import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import type { Job } from "../registry";

// content_findings + the review prompt rows postdate database.types.ts. Untyped bridge
// (same pattern as the other content handlers); regenerate types after migration 035.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// AI content review — slice 1. READ-ONLY reviewer: it produces FINDINGS for human
// judgment and writes ONLY content_findings (+ the ai_generation_log, like every AI
// call). It never edits content, never approves/rejects, never emits a verdict/score.
// Findings-or-silence: the output shape is a list of flagged issues (possibly empty);
// there is no pass/score/verdict field anywhere. An empty list = nothing flagged, NOT
// an endorsement.
//
// Two prompt-only review types this slice (seeded in migration 035):
//   best_practices — voice, AI-tells, reading level, structure.
//   factual_smell  — confident specifics that warrant a HUMAN check (flagging, not
//                    fact-checking).
// Slice 2 (doc-grounded proofing) adds more review_types; nothing here blocks that.
// ---------------------------------------------------------------------------

type ReviewType = string; // free text; the seeded types are best_practices | factual_smell
type Provider = "openai" | "gemini";

type ReviewPromptRow = {
  id: string;
  system_message: string;
  output_schema: Record<string, unknown>;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
};

// The model's structured output. NOTE: findings-or-silence — the shape is ONLY a
// findings array; there is no pass/verdict/score field to parse.
type RawFinding = { card_ref: string | null; finding: string; severity: string };

const VALID_SEVERITY = new Set(["info", "warning", "issue"]);

function resolveProvider(): Provider {
  const p = (process.env.REVIEW_WRITER || "openai").toLowerCase();
  if (p !== "openai" && p !== "gemini") {
    throw new Error(`Invalid REVIEW_WRITER="${p}" (expected "openai" or "gemini")`);
  }
  return p;
}

// Thin load — a review prompt is one `prompts` row keyed by prompt_type=review_<type>.
// NOT the tone/structure/length block-composition path (review isn't toned).
async function loadReviewPromptRow(reviewType: ReviewType): Promise<ReviewPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, output_schema, model, temperature, max_tokens")
    .eq("prompt_type", `review_${reviewType}`)
    .eq("is_active", true)
    .single();
  if (error || !data) {
    throw new Error(`No active review prompt for review_type "${reviewType}" (prompt_type=review_${reviewType}): ${error?.message ?? "not found"}`);
  }
  const row = data as ReviewPromptRow;
  if (!row.system_message) throw new Error(`Review prompt review_${reviewType} has no system_message`);
  if (!row.output_schema)  throw new Error(`Review prompt review_${reviewType} has no output_schema`);
  return row;
}

type Card = { id: string; title: string | null; content: string | null; sequence: number | null };

async function loadLessonCards(lessonId: string): Promise<{ lessonName: string; cards: Card[] }> {
  const { data: lesson, error: lErr } = await supabase
    .from("lessons").select("id, lesson_name").eq("id", lessonId).single();
  if (lErr || !lesson) throw new Error(`Lesson not found: ${lessonId} (${lErr?.message ?? "no row"})`);

  const { data: segs, error: sErr } = await supabase
    .from("segments").select("id").eq("lesson_id", lessonId);
  if (sErr) throw new Error(`Failed to load segments for lesson ${lessonId}: ${sErr.message}`);
  const segIds = (segs ?? []).map((s) => s.id);
  if (segIds.length === 0) throw new Error(`Lesson ${lessonId} has no segments — nothing to review`);

  const { data: cards, error: cErr } = await supabase
    .from("sub_segments").select("id, title, content, sequence, seg_id")
    .in("seg_id", segIds)
    .order("seg_id", { ascending: true })
    .order("sequence", { ascending: true });
  if (cErr) throw new Error(`Failed to load sub_segments for lesson ${lessonId}: ${cErr.message}`);
  const withContent = (cards ?? []).filter((c) => c.content && c.content.trim()) as Card[];
  if (withContent.length === 0) throw new Error(`Lesson ${lessonId} has no content cards — generate content first`);
  return { lessonName: lesson.lesson_name ?? "", cards: withContent };
}

// Present each card prefixed with its card_id; the model echoes that id back as
// card_ref (or null for a lesson-level finding).
function composeReviewUserMessage(lessonName: string, cards: Card[]): string {
  const cardText = cards
    .map((c) => `[card_id: ${c.id}] Card ${c.sequence ?? "?"}: ${c.title ?? ""}\n${c.content ?? ""}`)
    .join("\n\n");
  return (
    `## Lesson: ${lessonName}\n\n` +
    `## Cards to review\n` +
    `Each card below is prefixed with its card_id. In each finding, set card_ref to the ` +
    `EXACT card_id it concerns, or null for a lesson-level / cross-card finding.\n\n` +
    cardText
  );
}

export type ReviewLessonResult = {
  lesson_id: string;
  review_type: ReviewType;
  correlation_id: string;
  provider: Provider;
  model: string;
  findings_count: number;
  lesson_level_count: number;
  card_level_count: number;
};

// Core — exported so a later batch (slice 3) can drive it with a shared correlationId.
export async function reviewLesson(opts: {
  lesson_id: string;
  review_type: ReviewType;
  correlationId: string;
}): Promise<ReviewLessonResult> {
  const { lesson_id, review_type, correlationId } = opts;
  const provider = resolveProvider();

  const promptRow = await loadReviewPromptRow(review_type);
  const { lessonName, cards } = await loadLessonCards(lesson_id);
  const userPrompt = composeReviewUserMessage(lessonName, cards);

  // LLM call — provider-parameterized; withRetry lives inside the provider (the retry
  // fix now covers OpenAI transient errors too).
  const client = getLLMClient(provider);
  const llmStart = Date.now();
  const result = await client.generate({
    instructions:   promptRow.system_message,
    userPrompt,
    responseSchema: promptRow.output_schema,
    model:          promptRow.model ?? undefined,
    temperature:    promptRow.temperature ?? undefined,
    maxTokens:      promptRow.max_tokens ?? undefined,
  });

  await logAiCall({
    correlationId,
    operation:         `content_review_${review_type}`,
    prompt:            formatLlmPrompt(promptRow.system_message, userPrompt),
    response:          result.raw,
    model:             result.model,
    latencyMs:         Date.now() - llmStart,
    relatedEntityType: "lesson",
    relatedEntityId:   lesson_id,
    notes:             `review_type=${review_type}, provider=${provider}, cards=${cards.length}`,
  });

  // Unparseable / truncated output → FAIL VISIBLY. Never silently zero findings — a
  // parse failure is not "nothing flagged".
  if (result.finishReason === "length" || result.finishReason === "content_filter") {
    throw new Error(`Review model stopped with finish_reason="${result.finishReason}" for lesson ${lesson_id} — not parseable. Retry the job.`);
  }
  let findings: RawFinding[];
  try {
    const parsed = JSON.parse(result.text) as { findings: RawFinding[] };
    findings = parsed.findings;
  } catch (err) {
    throw new Error(`Failed to parse review response as JSON for lesson ${lesson_id}.\nError: ${err}\nRaw: ${result.text}`);
  }
  if (!Array.isArray(findings)) {
    throw new Error(`Review response missing a findings array for lesson ${lesson_id}`);
  }

  // Map findings → rows. card_ref must be one of THIS lesson's card ids; an unknown ref
  // is anchored to the lesson (never mis-anchored to the wrong card, never dropped).
  const cardIds = new Set(cards.map((c) => c.id));
  const rows = findings
    .filter((f) => {
      if (!f || typeof f.finding !== "string" || !f.finding.trim()) {
        console.warn(`[review_lesson] dropping a finding with no text (lesson ${lesson_id})`);
        return false;
      }
      return true;
    })
    .map((f) => {
      let subId: string | null = null;
      if (f.card_ref) {
        if (cardIds.has(f.card_ref)) subId = f.card_ref;
        else console.warn(`[review_lesson] finding referenced unknown card_id "${f.card_ref}" — anchoring to lesson level`);
      }
      const severity = VALID_SEVERITY.has(f.severity) ? f.severity : "info";
      return {
        correlation_id: correlationId,
        review_type,
        lesson_id,
        sub_segment_id: subId,
        finding: f.finding.trim(),
        severity,
        status: "open",
      };
    });

  // Insert findings (if any). Zero findings = valid silence → no rows written.
  if (rows.length > 0) {
    const { error: insErr } = await db.from("content_findings").insert(rows);
    if (insErr) throw new Error(`Failed to insert content_findings for lesson ${lesson_id}: ${insErr.message}`);
  }

  const cardLevel = rows.filter((r) => r.sub_segment_id !== null).length;
  return {
    lesson_id,
    review_type,
    correlation_id: correlationId,
    provider,
    model: result.model,
    findings_count: rows.length,
    lesson_level_count: rows.length - cardLevel,
    card_level_count: cardLevel,
  };
}

// ---------------------------------------------------------------------------
// Job handler — review_lesson. correlationId = job.id so a run's findings join to the
// job + ai_generation_log, and re-runs are distinguishable by correlation_id.
// ---------------------------------------------------------------------------
type Input = { lesson_id: string; review_type: ReviewType };

export async function reviewLessonHandler(job: Job): Promise<unknown> {
  const { lesson_id, review_type } = job.input as Input;
  if (!lesson_id) throw new Error("input.lesson_id is required");
  if (!review_type) throw new Error("input.review_type is required");
  return reviewLesson({ lesson_id, review_type, correlationId: job.id });
}
