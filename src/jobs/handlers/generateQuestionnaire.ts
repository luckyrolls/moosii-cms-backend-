import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import type { Job } from "../registry";

// database.types.ts is stale: it predates the questionnaire `age` column and a
// few views. Untyped bridge for the questionnaire-atom writes (same pattern as
// the other content handlers). Regenerate types to remove this.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
//
// TWO DISTINCT track references — do not conflate:
//   target_track_id — the track the response rule ADDS (what answering activates).
//                     Its name + description is the SPEC the whole atom is built
//                     against; must exist with a substantive description.
//   host_track_id   — the questionnaire's own track FK. Placement/visibility only;
//                     does NOT shape content.
type Input = {
  target_track_id: string;
  host_track_id: string;
  age_months: number;   // single age gate (months) — when the questionnaire surfaces
  topic?: string;       // theme; free string for now (NOT a topics.id)
  topic_id?: string;    // optional real topics.id FK
  milestone_id?: string; // optional milestones.id — born mapped, suppressible per slice 3.
                         //   Absent → NULL (unsuppressible). Validated against milestones.
};

// ---------------------------------------------------------------------------
// The structured atom shape the LLM returns. The handler owns the score math and
// validation — OpenAI strict schemas can't enforce minItems / threshold ranges /
// score spread (same limitation as the quiz schema), so those are checked below.
// ---------------------------------------------------------------------------
type GenAnswer = { answer_text: string; score: number };
type GenQuestion = { question_text: string; answers: GenAnswer[] };
type GenAtom = {
  questionnaire_name: string;
  intro_text: string;
  questions: GenQuestion[];
  add_threshold: number;
};

// Prompt is DB-composed (migration 0005): prompt_type='questionnaire' row carries
// system_message + output_schema (+ optional model/params). Kept in the permissive
// responseSchema form so it works on either provider (openai|gemini).
type QuestionnairePromptRow = {
  id: string;
  system_message: string;
  output_schema: Record<string, unknown>;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
};

async function loadQuestionnairePromptRow(): Promise<QuestionnairePromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, output_schema, model, temperature, max_tokens")
    .eq("prompt_type", "questionnaire")
    .eq("is_active", true)
    .single();
  if (error || !data) {
    throw new Error(`No active questionnaire prompt row found: ${error?.message ?? "not found"}`);
  }
  const row = data as QuestionnairePromptRow;
  if (!row.system_message) throw new Error("Questionnaire prompt row has no system_message");
  if (!row.output_schema)  throw new Error("Questionnaire prompt row has no output_schema");
  return row;
}

const MAX_GEN_ATTEMPTS = 3;

// Existing questionnaire rows use this default placeholder image; reuse it so the
// draft renders coherently in the CMS before a human sets a real one.
const DEFAULT_ONBOARDING_IMAGE =
  "https://szhihepbqzbbmxybluql.supabase.co/storage/v1/object/public/questionnaire_and_quiz/questionnaire.jpg";

// Priority is stamped at generation from the TARGET track's priority (a COPIED value —
// later track edits must not reshuffle existing questionnaires). It becomes the pool
// item priority: the MLP orders items within a host track by priority ASCENDING
// (lower = sooner; NULL → 9999 = bottom). Track priorities span ~10–850 and lesson item
// priorities cluster ~100–220 on the same scale/direction, so a track priority sits
// sensibly among lessons. Fallback for a target track with NULL priority: a neutral
// mid-scale constant — NEVER write NULL (that's the deprioritization bug this fixes).
const QUESTIONNAIRE_DEFAULT_PRIORITY = 500;

function resolveProvider(): "openai" | "gemini" {
  const p = (process.env.QUESTIONNAIRE_WRITER || "openai").toLowerCase();
  if (p !== "openai" && p !== "gemini") {
    throw new Error(`Invalid QUESTIONNAIRE_WRITER="${p}" (expected "openai" or "gemini")`);
  }
  return p;
}

// Validate a generated atom and compute the real max achievable score
// (sum of the highest-value answer per question). Throws on any problem that
// would make the questionnaire fail to discriminate; the caller retries.
function validateAtom(atom: GenAtom): { realMax: number } {
  if (!atom || typeof atom !== "object") throw new Error("atom is not an object");
  if (!atom.questionnaire_name?.trim()) throw new Error("missing questionnaire_name");
  if (!atom.intro_text?.trim()) throw new Error("missing intro_text");
  if (!Array.isArray(atom.questions) || atom.questions.length === 0) {
    throw new Error("no questions");
  }

  let realMax = 0;
  atom.questions.forEach((q, i) => {
    if (!q.question_text?.trim()) throw new Error(`question ${i + 1}: empty question_text`);
    if (!Array.isArray(q.answers) || q.answers.length < 2) {
      throw new Error(`question ${i + 1}: needs >= 2 answers to discriminate`);
    }
    const scores = q.answers.map((a) => a.score);
    if (scores.some((s) => !Number.isInteger(s) || s < 0)) {
      throw new Error(`question ${i + 1}: every score must be a non-negative integer`);
    }
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    if (max === min) {
      throw new Error(
        `question ${i + 1}: answers don't spread (all score ${max}) — can't discriminate`
      );
    }
    realMax += max;
  });

  if (realMax <= 0) throw new Error("real max achievable score is 0");

  const th = atom.add_threshold;
  if (!Number.isInteger(th) || th < 1 || th > realMax) {
    throw new Error(`add_threshold ${th} out of range [1 .. ${realMax}]`);
  }

  return { realMax };
}

type GenerationResult = {
  atom: GenAtom;
  realMax: number;
  model: string;
  version: string;
  raw: unknown;
  attempts: number;
};

// Call the LLM and validate; retry up to MAX_GEN_ATTEMPTS on a parse/validation
// failure (the LLM occasionally returns a non-discriminating question). Fails
// clearly after exhausting attempts.
async function generateAtom(opts: {
  instructions: string;
  userPrompt: string;
  provider: "openai" | "gemini";
  responseSchema: Record<string, unknown>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<GenerationResult> {
  const client = getLLMClient(opts.provider);
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    const result = await client.generate({
      instructions:   opts.instructions,
      userPrompt:     opts.userPrompt,
      responseSchema: opts.responseSchema,
      ...(opts.model && { model: opts.model }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    });

    if (result.finishReason === "length" || result.finishReason === "content_filter") {
      lastErr = new Error(`LLM stopped with finish_reason="${result.finishReason}" — not parseable`);
      console.warn(`[generate_questionnaire] attempt ${attempt}: ${lastErr.message}`);
      continue;
    }

    let atom: GenAtom;
    try {
      atom = JSON.parse(result.text) as GenAtom;
    } catch (err) {
      lastErr = new Error(`response was not valid JSON: ${err}`);
      console.warn(`[generate_questionnaire] attempt ${attempt}: ${lastErr.message}`);
      continue;
    }

    try {
      const { realMax } = validateAtom(atom);
      return { atom, realMax, model: result.model, version: result.version, raw: result.raw, attempts: attempt };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[generate_questionnaire] attempt ${attempt}: validation failed — ${lastErr.message}`);
    }
  }

  throw new Error(
    `Questionnaire generation failed after ${MAX_GEN_ATTEMPTS} attempts. Last error: ${lastErr?.message}`
  );
}

// ---------------------------------------------------------------------------
// Handler — generate_questionnaire
// Writes ONE questionnaire atom (questionnaire + questions + answers + one
// response rule) as a DRAFT (is_published=false). Publishing is the human
// approve action and is out of scope here.
// ---------------------------------------------------------------------------
export async function generateQuestionnaireHandler(job: Job): Promise<unknown> {
  const { target_track_id, host_track_id, age_months, topic, topic_id, milestone_id } = job.input as Input;
  if (!target_track_id) throw new Error("input.target_track_id is required");
  if (!host_track_id)   throw new Error("input.host_track_id is required");
  if (age_months === undefined || age_months === null) {
    throw new Error("input.age_months is required");
  }

  // Optional milestone mapping (slice 3): if provided, the questionnaire is born
  // MAPPED (suppressible when a child has the fact). Validate it resolves to a real
  // milestones row — a dangling map is unconstructable at the FK, but fail EARLY
  // and clearly here rather than surfacing a raw FK error at insert time.
  if (milestone_id) {
    const { data: ms, error: msErr } = await db
      .from("milestones")
      .select("id")
      .eq("id", milestone_id)
      .maybeSingle();
    if (msErr) throw new Error(`Failed to validate milestone_id: ${msErr.message}`);
    if (!ms) throw new Error(`input.milestone_id ${milestone_id} does not resolve to a real milestones row`);
  }

  const correlationId = randomUUID();
  const provider = resolveProvider();

  // 1. Resolve the TARGET track — its description is the spec for the whole atom, and
  //    its priority is COPIED onto the questionnaire (see QUESTIONNAIRE_DEFAULT_PRIORITY).
  const { data: target, error: tErr } = await db
    .from("tracks")
    .select("id, track_name, description, priority")
    .eq("id", target_track_id)
    .single();
  if (tErr || !target) {
    throw new Error(`Target track not found: ${target_track_id} (${tErr?.message ?? "no row"})`);
  }
  if (!target.description || !target.description.trim()) {
    throw new Error(
      `Target track ${target_track_id} ("${target.track_name}") has no description. ` +
      `The description is the spec the questionnaire is generated against — populate it first.`
    );
  }

  // 2. Resolve the HOST track exists (placement only).
  const { data: host, error: hErr } = await db
    .from("tracks")
    .select("id")
    .eq("id", host_track_id)
    .single();
  if (hErr || !host) {
    throw new Error(`Host track not found: ${host_track_id} (${hErr?.message ?? "no row"})`);
  }

  // 3. Generate the atom from the target track's name + description (the spec).
  //    Prompt + output schema (+ optional params) come from the DB row.
  const promptRow = await loadQuestionnairePromptRow();
  const instructions = promptRow.system_message;
  const userPrompt =
    `Target track name: ${target.track_name}\n` +
    `Target track description:\n${target.description}\n\n` +
    `Child age (months) this questionnaire surfaces at: ${age_months}\n` +
    (topic ? `Theme: ${topic}\n` : "") +
    `\nWrite the questionnaire that screens for this track.`;

  const llmStart = Date.now();
  const { atom, realMax, model, raw, attempts } = await generateAtom({
    instructions,
    userPrompt,
    provider,
    responseSchema: promptRow.output_schema,
    model:          promptRow.model ?? undefined,
    temperature:    promptRow.temperature ?? undefined,
    maxTokens:      promptRow.max_tokens ?? undefined,
  });

  // 4. Write the questionnaire root as a draft.
  const { data: q, error: qErr } = await db
    .from("questionnaire")
    .insert({
      questionnaire_name: atom.questionnaire_name,
      description:        atom.intro_text,
      track_id:          host_track_id,   // HOST track — placement/visibility
      priority:          target.priority ?? QUESTIONNAIRE_DEFAULT_PRIORITY, // COPIED from TARGET track; never NULL
      topic_id:          topic_id ?? null,
      is_score_based:    true,            // required: routing only computes a score when true
      is_published:      false,           // draft; publishing is the human approve
      age:               age_months,      // single age gate (months)
      onboarding_text:   atom.intro_text,
      onboarding_image:  DEFAULT_ONBOARDING_IMAGE,
      with_quiz:         false,
      milestone_id:      milestone_id ?? null,  // born mapped (slice 3) or unsuppressible
    })
    .select("id")
    .single();
  if (qErr || !q) throw new Error(`Failed to insert questionnaire: ${qErr?.message}`);
  const questionnaireId = q.id as string;

  // Provenance — real model now; logged after the row exists so related_entity_id
  // can carry the questionnaire. Shared correlation_id across the atom.
  await logAiCall({
    correlationId,
    operation:         "questionnaire_generate",
    prompt:            formatLlmPrompt(instructions, userPrompt),
    response:          raw,
    model,
    latencyMs:         Date.now() - llmStart,
    relatedEntityType: "questionnaire",
    relatedEntityId:   questionnaireId,
    notes:             `provider=${provider}, attempts=${attempts}, real_max=${realMax}, add_threshold=${atom.add_threshold}, target_track_id=${target_track_id}, age_months=${age_months}`,
  });

  // 5. Questions + answers (each answer carries a score).
  let questionsWritten = 0;
  let answersWritten = 0;
  for (const question of atom.questions) {
    const { data: insertedQ, error: qInsErr } = await db
      .from("questionnaire_questions")
      .insert({
        questionnaire_id: questionnaireId,
        question_text:    question.question_text,
        type:             "Single Selection",
        answer_status:    "pending",   // publish-time approval flips this to 'approved'
      })
      .select("question_id")
      .single();
    if (qInsErr || !insertedQ) throw new Error(`Failed to insert questionnaire_question: ${qInsErr?.message}`);

    const answerRows = question.answers.map((a) => ({
      question_id: insertedQ.question_id,
      answer_text: a.answer_text,
      score:       a.score,
      response:    null,
    }));
    const { error: aInsErr } = await db.from("questionnaire_answers").insert(answerRows);
    if (aInsErr) throw new Error(`Failed to insert questionnaire_answers: ${aInsErr.message}`);

    questionsWritten += 1;
    answersWritten += answerRows.length;
  }

  // 6. The routing rule — total score in [threshold .. real_max] → ADD the TARGET
  //    track. Both bounds are grounded in the actual generated answer values; no
  //    sentinel ceiling. A single add band: scores below the threshold simply add
  //    no track (no rule), which is correct — we never fabricate a remove rule.
  const { data: rule, error: rErr } = await db
    .from("questionnaire_response")
    .insert({
      questionnaire_id: questionnaireId,
      track_id:         target_track_id,   // TARGET track — what answering activates
      tag_id:           null,
      add:              true,
      score_min_range:  atom.add_threshold,
      score_max_range:  realMax,
    })
    .select("id")
    .single();
  if (rErr || !rule) throw new Error(`Failed to insert questionnaire_response: ${rErr?.message}`);

  return {
    questionnaire_id:  questionnaireId,
    is_published:      false,
    host_track_id,
    target_track_id,
    priority:          target.priority ?? QUESTIONNAIRE_DEFAULT_PRIORITY,
    age_months,
    milestone_id:      milestone_id ?? null,
    questions_written: questionsWritten,
    answers_written:   answersWritten,
    response_rule_id:  rule.id,
    add_threshold:     atom.add_threshold,
    real_max:          realMax,
    score_range:       { min: atom.add_threshold, max: realMax },
    provider,
    model,
    attempts,
    correlation_id:    correlationId,
  };
}
