import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import { loadBlock } from "./generateSegmentContent";
import type { Job } from "../registry";

// database.types.ts predates migrations 0001/0002. Use untyped alias.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuizPromptRow = {
  id: string;
  system_message: string;
  scope: string | null;
  output_schema: Record<string, unknown>;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
  question_count: number;
  tone_block_id: string | null;
};

type RawAnswer = {
  answer_text: string;
  is_correct: boolean;
  response: string;
};

type RawQuestion = {
  question_text: string;
  answers: RawAnswer[];
};

type ValidatedQuestion = {
  question_text: string;
  answers: RawAnswer[]; // exactly 4, exactly one correct
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadQuizPromptRow(): Promise<QuizPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, scope, output_schema, model, temperature, max_tokens, question_count, tone_block_id")
    .eq("prompt_type", "quiz")
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error(`No active quiz prompt row found: ${error?.message}`);
  }

  const row = data as unknown as QuizPromptRow;
  if (!row.system_message) throw new Error("Quiz prompt row has no system_message");
  if (!row.output_schema)  throw new Error("Quiz prompt row has no output_schema");
  if (!row.model)          throw new Error("Quiz prompt row has no model");
  return row;
}

// ---------------------------------------------------------------------------
// Prompt composer for quiz
// scope → ## Tone (if block set) → ## Content (card text) → question count
// ---------------------------------------------------------------------------

function composeQuizUserMessage(opts: {
  scope: string | null;
  toneContent: string;
  questionCount: number;
  cards: { title: string | null; content: string | null; sequence: number | null }[];
}): string {
  const parts: string[] = [];
  if (opts.scope)       parts.push(opts.scope);
  if (opts.toneContent) parts.push(`## Tone\n\n${opts.toneContent}`);

  const cardText = opts.cards
    .map((c) => `**Card ${c.sequence ?? "?"}: ${c.title ?? ""}**\n${c.content ?? ""}`)
    .join("\n\n");
  parts.push(`## Content\n\n${cardText}`);
  parts.push(`Generate exactly ${opts.questionCount} question${opts.questionCount === 1 ? "" : "s"}.`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Per-question validation
// Returns the question if valid, null if malformed (caller logs shortfall).
// ---------------------------------------------------------------------------

function validateQuestion(q: RawQuestion, index: number): ValidatedQuestion | null {
  const { question_text, answers } = q;

  if (!question_text?.trim()) {
    console.warn(`[generateQuiz] Question ${index + 1}: missing question_text — dropped`);
    return null;
  }
  if (!Array.isArray(answers) || answers.length !== 4) {
    console.warn(`[generateQuiz] Question ${index + 1} ("${question_text}"): expected 4 answers, got ${answers?.length ?? 0} — dropped`);
    return null;
  }
  const correctCount = answers.filter((a) => a.is_correct).length;
  if (correctCount !== 1) {
    console.warn(`[generateQuiz] Question ${index + 1} ("${question_text}"): expected 1 correct answer, got ${correctCount} — dropped`);
    return null;
  }
  const missingResponse = answers.find((a) => !a.response?.trim());
  if (missingResponse) {
    console.warn(`[generateQuiz] Question ${index + 1} ("${question_text}"): answer missing response text — dropped`);
    return null;
  }

  return { question_text, answers };
}

// ---------------------------------------------------------------------------
// Core: generateQuiz
// Exported so the segment content handler can call it in the one-action flow
// sharing the same correlationId, and so the standalone job handler can call
// it with its own correlationId.
// ---------------------------------------------------------------------------

export type GenerateQuizResult = {
  questions_requested: number;
  questions_written: number;
  question_ids: string[];
  model: string;
};

export async function generateQuiz(opts: {
  seg_id: string;
  correlationId: string;
  isRegen?: boolean;
}): Promise<GenerateQuizResult> {
  const { seg_id, correlationId, isRegen = false } = opts;

  // Step 1 — load segment cards (the source material)
  const { data: cards, error: cardsErr } = await supabase
    .from("sub_segments")
    .select("id, title, content, sequence")
    .eq("seg_id", seg_id)
    .order("sequence", { ascending: true });
  if (cardsErr) throw new Error(`Failed to load sub_segments for seg ${seg_id}: ${cardsErr.message}`);
  if (!cards || cards.length === 0) throw new Error(`No cards found for segment ${seg_id} — generate content first`);

  // Step 2 — load lesson_id (needed for quiz_questions FK)
  const { data: segment, error: segErr } = await supabase
    .from("segments")
    .select("id, lesson_id")
    .eq("id", seg_id)
    .single();
  if (segErr || !segment) throw new Error(`Segment not found: ${seg_id}`);

  // Step 3 — load quiz prompt row + tone block
  const promptRow = await loadQuizPromptRow();
  const toneContent = await loadBlock(promptRow.tone_block_id, "tone");

  // Step 4 — compose prompts
  const systemMessage = promptRow.system_message;
  const userMessage = composeQuizUserMessage({
    scope:         promptRow.scope,
    toneContent,
    questionCount: promptRow.question_count,
    cards,
  });

  // Step 5 — call OpenAI (withRetry lives inside the provider)
  const client = getLLMClient("openai");
  const llmStart = Date.now();
  const result = await client.generate({
    instructions:  systemMessage,
    userPrompt:    userMessage,
    rawJsonSchema: promptRow.output_schema,
    model:         promptRow.model,
    temperature:   promptRow.temperature  ?? undefined,
    maxTokens:     promptRow.max_tokens   ?? undefined,
  });

  await logAiCall({
    correlationId,
    operation:         "quiz",
    prompt:            formatLlmPrompt(systemMessage, userMessage),
    response:          result.raw,
    model:             result.model,
    latencyMs:         Date.now() - llmStart,
    relatedEntityType: "segment",
    relatedEntityId:   seg_id,
    notes:             `requested: ${promptRow.question_count}, isRegen: ${isRegen}`,
  });

  // Step 6 — guard finish_reason
  if (result.finishReason === "length" || result.finishReason === "content_filter") {
    throw new Error(
      `OpenAI stopped with finish_reason="${result.finishReason}" for quiz on segment ${seg_id} — not parseable. Retry the job.`
    );
  }

  // Step 7 — parse
  let rawQuestions: RawQuestion[];
  try {
    const parsed = JSON.parse(result.text) as { questions: RawQuestion[] };
    rawQuestions = parsed.questions;
  } catch (err) {
    throw new Error(`Failed to parse quiz response as JSON for segment ${seg_id}.\nError: ${err}\nRaw: ${result.text}`);
  }

  if (!Array.isArray(rawQuestions)) {
    throw new Error(`Quiz response missing questions array for segment ${seg_id}`);
  }

  // Step 8 — validate each question; drop malformed ones, keep valid
  const validQuestions: ValidatedQuestion[] = rawQuestions
    .map((q, i) => validateQuestion(q, i))
    .filter((q): q is ValidatedQuestion => q !== null);

  if (validQuestions.length === 0) {
    throw new Error(
      `Quiz generation produced 0 valid questions for segment ${seg_id} ` +
      `(requested ${promptRow.question_count}, got ${rawQuestions.length} but all failed validation). Retry the job.`
    );
  }

  if (validQuestions.length < promptRow.question_count) {
    console.warn(
      `[generateQuiz] seg ${seg_id}: requested ${promptRow.question_count}, only ${validQuestions.length} passed validation`
    );
  }

  // Step 9 — generate before destroy: valid questions are in hand. ALWAYS replace
  // any existing questions for this segment — one quiz per segment, so regenerating
  // replaces rather than appends (delete answers first, then questions). This is
  // unconditional (not gated on isRegen) so a re-run can never duplicate the quiz.
  const { data: existingQs } = await supabase
    .from("quiz_questions")
    .select("question_id")
    .eq("segment_id", seg_id);

  if (existingQs && existingQs.length > 0) {
    const existingIds = existingQs.map((q: { question_id: string }) => q.question_id);

    const { error: ansDeleteErr } = await supabase
      .from("quiz_answers")
      .delete()
      .in("question_id", existingIds);
    if (ansDeleteErr) throw new Error(`Failed to delete existing quiz_answers for seg ${seg_id}: ${ansDeleteErr.message}`);

    const { error: qDeleteErr } = await supabase
      .from("quiz_questions")
      .delete()
      .eq("segment_id", seg_id);
    if (qDeleteErr) throw new Error(`Failed to delete existing quiz_questions for seg ${seg_id}: ${qDeleteErr.message}`);
  }

  // Step 10 — insert questions, then their answers
  const insertedIds: string[] = [];

  for (const q of validQuestions) {
    const { data: insertedQ, error: qInsertErr } = await supabase
      .from("quiz_questions")
      .insert({
        question_text:  q.question_text,
        type:           "Single Selection",
        segment_id:     seg_id,
        lesson_id:      segment.lesson_id ?? null,
        answer_status:  "pending",
      })
      .select("question_id")
      .single();

    if (qInsertErr || !insertedQ) {
      throw new Error(`Failed to insert quiz_question for seg ${seg_id}: ${qInsertErr?.message}`);
    }

    const answersToInsert = q.answers.map((a) => ({
      question_id:  insertedQ.question_id,
      answer_text:  a.answer_text,
      is_correct:   a.is_correct,
      response:     a.response,
      score:        0,
    }));

    const { error: aInsertErr } = await supabase
      .from("quiz_answers")
      .insert(answersToInsert);

    if (aInsertErr) {
      throw new Error(`Failed to insert quiz_answers for question ${insertedQ.question_id}: ${aInsertErr.message}`);
    }

    insertedIds.push(insertedQ.question_id);
  }

  return {
    questions_requested: promptRow.question_count,
    questions_written:   validQuestions.length,
    question_ids:        insertedIds,
    model:               result.model,
  };
}

// ---------------------------------------------------------------------------
// Standalone job handler — generate_quiz job type
// Replaces existing questions for the segment (isRegen = true).
// ---------------------------------------------------------------------------

type Input = {
  seg_id: string;
};

export async function generateQuizHandler(job: Job): Promise<unknown> {
  const { seg_id } = job.input as Input;
  if (!seg_id) throw new Error("input.seg_id is required");

  const correlationId = randomUUID();

  const result = await generateQuiz({
    seg_id,
    correlationId,
    isRegen: true,
  });

  return {
    ...result,
    seg_id,
    shortfall: result.questions_written < result.questions_requested
      ? `${result.questions_written} of ${result.questions_requested} questions written`
      : null,
  };
}
