import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import { lintSegmentCards, type LintHit } from "../../lib/voiceLint";
import { generateQuiz } from "./generateQuiz";
import type { Job } from "../registry";

// database.types.ts predates migration 0001_prompts_refactor (new prompts columns +
// prompt_blocks table). Use untyped alias until types are regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// Shared types (exported for regen handler)
// ---------------------------------------------------------------------------

export type SegmentContentPromptRow = {
  id: string;
  system_message: string;
  scope: string | null;
  output_schema: Record<string, unknown>;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
  tone_block_id: string | null;
  structure_block_id: string | null;
  length_block_id: string | null;
};

export type Card = { title: string; content: string };

// ---------------------------------------------------------------------------
// Shared loaders (exported for regen handler)
// ---------------------------------------------------------------------------

export async function loadPromptRow(tone: string): Promise<SegmentContentPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, scope, output_schema, model, temperature, max_tokens, tone_block_id, structure_block_id, length_block_id")
    .eq("prompt_type", "segment")
    .eq("tone", tone)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error(`No active segment prompt for tone "${tone}": ${error?.message}`);
  }

  const row = data as unknown as SegmentContentPromptRow;
  if (!row.system_message) throw new Error(`Prompt row for tone "${tone}" has no system_message`);
  if (!row.output_schema)  throw new Error(`Prompt row for tone "${tone}" has no output_schema`);
  if (!row.model)          throw new Error(`Prompt row for tone "${tone}" has no model`);
  return row;
}

export async function loadBlock(blockId: string | null, label: string): Promise<string> {
  if (!blockId) return "";
  const { data, error } = await db
    .from("prompt_blocks")
    .select("content")
    .eq("id", blockId)
    .single();
  if (error || !data) {
    throw new Error(`Failed to load ${label} block (id: ${blockId}): ${error?.message}`);
  }
  return (data as { content: string }).content;
}

// ---------------------------------------------------------------------------
// Shared prompt composer (exported for regen handler)
// When regenTarget is provided, appends a "Regeneration Target" section
// with neighbor context for single_card scope.
// ---------------------------------------------------------------------------

export type RegenTarget = {
  sequence: number;
  totalCards: number;
  oldTitle: string;
  prevCard: { sequence: number; title: string; content: string } | null;
  nextCard: { sequence: number; title: string; content: string } | null;
};

export function composeUserMessage(opts: {
  scope: string | null;
  toneContent: string;
  structureContent: string;
  lengthContent: string;
  lessonTitle: string;
  segmentName: string;
  segmentDescription: string | null;
  regenTarget?: RegenTarget;
}): string {
  const parts: string[] = [];
  if (opts.scope)            parts.push(opts.scope);
  if (opts.toneContent)      parts.push(`## Tone\n\n${opts.toneContent}`);
  if (opts.structureContent) parts.push(`## Structure\n\n${opts.structureContent}`);
  if (opts.lengthContent)    parts.push(`## Length\n\n${opts.lengthContent}`);

  const ctx = [`Lesson title: ${opts.lessonTitle}`, `Segment: ${opts.segmentName}`];
  if (opts.segmentDescription) ctx.push(`Description: ${opts.segmentDescription}`);
  parts.push(`## Context\n\n${ctx.join("\n")}`);

  if (opts.regenTarget) {
    const { sequence, totalCards, oldTitle, prevCard, nextCard } = opts.regenTarget;
    const neighborLines: string[] = [];

    if (prevCard) {
      neighborLines.push(
        `**Card ${prevCard.sequence} (before target) — "${prevCard.title}":**\n${prevCard.content}`
      );
    }
    if (nextCard) {
      neighborLines.push(
        `**Card ${nextCard.sequence} (after target) — "${nextCard.title}":**\n${nextCard.content}`
      );
    }

    const neighborBlock = neighborLines.length > 0
      ? `\nNeighboring cards (do NOT repeat their content):\n\n${neighborLines.join("\n\n")}`
      : "";

    parts.push(
      `## Regeneration Target\n\nRegenerate ONLY card ${sequence} of ${totalCards} (currently titled "${oldTitle}").` +
      `\nOutput a \`cards\` array containing exactly ONE card.` +
      `\nThe replacement must fit coherently into the arc at this position.` +
      neighborBlock
    );
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Shared generation core (exported for regen handler)
// Calls OpenAI, logs, guards finish_reason, parses, returns cards.
// Does NOT touch the database — callers handle DB writes.
// ---------------------------------------------------------------------------

type CallAndParseOpts = {
  systemMessage: string;
  userMessage: string;
  promptRow: SegmentContentPromptRow;
  correlationId: string;
  operation: string;
  relatedEntityType: "segment" | "sub_segment";
  relatedEntityId: string;
  notes?: string;
};

export async function callAndParseCards(opts: CallAndParseOpts): Promise<{
  cards: Card[];
  model: string;
  finishReason: string | undefined;
  lint: LintHit[];
}> {
  const client = getLLMClient("openai");
  const llmStart = Date.now();
  const result = await client.generate({
    instructions:  opts.systemMessage,
    userPrompt:    opts.userMessage,
    rawJsonSchema: opts.promptRow.output_schema,
    model:         opts.promptRow.model,
    temperature:   opts.promptRow.temperature ?? undefined,
    maxTokens:     opts.promptRow.max_tokens  ?? undefined,
  });

  await logAiCall({
    correlationId:     opts.correlationId,
    operation:         opts.operation,
    prompt:            formatLlmPrompt(opts.systemMessage, opts.userMessage),
    response:          result.raw,
    model:             result.model,
    latencyMs:         Date.now() - llmStart,
    relatedEntityType: opts.relatedEntityType,
    relatedEntityId:   opts.relatedEntityId,
    notes:             opts.notes,
  });

  if (result.finishReason === "length" || result.finishReason === "content_filter") {
    throw new Error(
      `OpenAI stopped with finish_reason="${result.finishReason}" for ` +
      `${opts.relatedEntityType} ${opts.relatedEntityId} — not parseable. Retry the job.`
    );
  }

  let cards: Card[];
  try {
    const parsed = JSON.parse(result.text) as { cards: Card[] };
    cards = parsed.cards;
  } catch (err) {
    throw new Error(
      `Failed to parse OpenAI response as JSON for ${opts.relatedEntityType} ${opts.relatedEntityId}.\n` +
      `Error: ${err}\nRaw: ${result.text}`
    );
  }

  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error(`OpenAI returned no cards for ${opts.relatedEntityType} ${opts.relatedEntityId}`);
  }

  // Deterministic voice lint (advisory — never throws, never blocks).
  const lint = await lintSegmentCards(cards);

  return { cards, model: result.model, finishReason: result.finishReason, lint };
}

// ---------------------------------------------------------------------------
// Handler — first-time generation
// ---------------------------------------------------------------------------

type Input = {
  seg_id: string;
  tone: string;
  generate_quiz?: boolean; // if true, generate quiz after cards using the same correlationId
};

export async function generateSegmentContentHandler(job: Job): Promise<unknown> {
  const { seg_id, tone, generate_quiz: alsoGenerateQuiz = false } = job.input as Input;
  if (!seg_id) throw new Error("input.seg_id is required");
  if (!tone)   throw new Error("input.tone is required");

  const correlationId = randomUUID();

  // Step 1 — load segment + lesson context
  const { data: segment, error: segErr } = await supabase
    .from("segments")
    .select("id, segment_name, description, lesson_id")
    .eq("id", seg_id)
    .single();
  if (segErr || !segment) throw new Error(`Segment not found: ${seg_id}`);
  if (!segment.lesson_id) throw new Error(`Segment ${seg_id} has no lesson_id`);

  const { data: lesson, error: lessonErr } = await supabase
    .from("lessons")
    .select("id, lesson_name")
    .eq("id", segment.lesson_id)
    .single();
  if (lessonErr || !lesson) throw new Error(`Lesson not found for segment ${seg_id}`);

  // Step 2 — load prompt row + blocks in parallel
  const promptRow = await loadPromptRow(tone);

  const [toneContent, structureContent, lengthContent] = await Promise.all([
    loadBlock(promptRow.tone_block_id,      "tone"),
    loadBlock(promptRow.structure_block_id, "structure"),
    loadBlock(promptRow.length_block_id,    "length"),
  ]);

  // Step 3 — compose prompts
  const systemMessage = promptRow.system_message;
  const userMessage = composeUserMessage({
    scope:              promptRow.scope,
    toneContent,
    structureContent,
    lengthContent,
    lessonTitle:        lesson.lesson_name ?? "",
    segmentName:        segment.segment_name ?? "",
    segmentDescription: segment.description ?? null,
  });

  // Step 4 — generate (withRetry lives inside the provider)
  const { cards, model, finishReason, lint } = await callAndParseCards({
    systemMessage,
    userMessage,
    promptRow,
    correlationId,
    operation:         "segment_content",
    relatedEntityType: "segment",
    relatedEntityId:   seg_id,
    notes:             `tone: ${tone}`,
  });

  // Step 5 — replace sub_segments (whole-unit: delete then insert).
  // content_images.sub_segment_id is ON DELETE CASCADE, so images are also removed.
  const { error: deleteErr } = await supabase
    .from("sub_segments")
    .delete()
    .eq("seg_id", seg_id);
  if (deleteErr) {
    throw new Error(`Failed to delete existing sub_segments for seg ${seg_id}: ${deleteErr.message}`);
  }

  const rowsToInsert = cards.map((card, i) => ({
    seg_id,
    title:    card.title,
    content:  card.content,
    sequence: i + 1,
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from("sub_segments")
    .insert(rowsToInsert)
    .select("id, title, sequence");
  if (insertErr || !inserted) {
    throw new Error(`Failed to insert sub_segments for seg ${seg_id}: ${insertErr?.message}`);
  }

  // Optional one-action flow: generate quiz from the just-written cards,
  // sharing the same correlationId so both log entries are linked.
  let quizResult: Awaited<ReturnType<typeof generateQuiz>> | null = null;
  if (alsoGenerateQuiz) {
    quizResult = await generateQuiz({ seg_id, correlationId, isRegen: false });
  }

  return {
    seg_id,
    sub_segments_inserted: inserted.length,
    sub_segment_ids:       inserted.map((r) => r.id),
    model,
    finish_reason:         finishReason,
    lint,
    ...(quizResult && { quiz: quizResult }),
  };
}
