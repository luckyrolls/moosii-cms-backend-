import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import { lintSegmentCards, loadPromptBanInstruction, type LintHit } from "../../lib/voiceLint";
import { loadSizeProfileById, renderLengthInstruction, type SizeNumbers } from "../../lib/sizeProfile";
import { generateQuiz } from "./generateQuiz";
import { purgeImagesForSubSegments } from "../../storage/purgeImages";
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
  tone: string | null;           // display name (for logs); selection is by id
  system_message: string;
  scope: string | null;
  output_schema: Record<string, unknown>;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
  tone_block_id: string | null;
  structure_block_id: string | null;
  length_block_id: string | null;
  size_profile_id: string | null;   // default size profile for this tone (014)
  card_positions_block_id: string | null;  // per-position card rules (shared with review)
};

export type Card = { title: string; content: string };

// ---------------------------------------------------------------------------
// Shared loaders (exported for regen handler)
// ---------------------------------------------------------------------------

// Select a segment tone by its stable prompts.id (NOT the display name — names are
// editable). Must be an active segment tone.
export async function loadSegmentPromptRowById(toneId: string): Promise<SegmentContentPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, tone, system_message, scope, output_schema, model, temperature, max_tokens, tone_block_id, structure_block_id, length_block_id, size_profile_id, card_positions_block_id")
    .eq("id", toneId)
    .eq("prompt_type", "segment")
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error(`No active segment tone with id "${toneId}": ${error?.message ?? "not found"}`);
  }

  const row = data as unknown as SegmentContentPromptRow;
  if (!row.system_message) throw new Error(`Tone ${toneId} has no system_message`);
  if (!row.output_schema)  throw new Error(`Tone ${toneId} has no output_schema`);
  if (!row.model)          throw new Error(`Tone ${toneId} has no model`);
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

// Resolve the "## Length" instruction text. Precedence:
//   1. a size profile (per-run override id, else the tone's default) rendered from
//      its numbers, with optional inline numeric tweaks merged on top; else
//   2. inline numeric tweaks alone (no base profile); else
//   3. the legacy length block (back-compat for tones with no profile).
export async function resolveLengthContent(
  promptRow: Pick<SegmentContentPromptRow, "size_profile_id" | "length_block_id">,
  sizeOverride?: { profileId?: string; inline?: SizeNumbers }
): Promise<string> {
  const baseId = sizeOverride?.profileId ?? promptRow.size_profile_id;
  if (baseId) {
    const prof = await loadSizeProfileById(baseId);
    if (prof) return renderLengthInstruction({ ...prof, ...(sizeOverride?.inline ?? {}) });
  }
  if (sizeOverride?.inline && Object.keys(sizeOverride.inline).length > 0) {
    return renderLengthInstruction(sizeOverride.inline);
  }
  return loadBlock(promptRow.length_block_id, "length");
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
  cardPositionsContent?: string;   // per-position card rules — sits BETWEEN structure and length
  lengthContent: string;
  lessonTitle: string;
  segmentName: string;
  segmentDescription: string | null;
  avoid?: string;            // error-severity voice-lint bans (prevention layer)
  guidance?: string;         // author feedback from a rejection — steers this regen
  regenTarget?: RegenTarget;
}): string {
  const parts: string[] = [];
  if (opts.scope)            parts.push(opts.scope);
  if (opts.toneContent)      parts.push(`## Tone\n\n${opts.toneContent}`);
  if (opts.structureContent) parts.push(`## Structure\n\n${opts.structureContent}`);
  if (opts.cardPositionsContent) parts.push(`## Card Positions\n\n${opts.cardPositionsContent}`);
  if (opts.lengthContent)    parts.push(`## Length\n\n${opts.lengthContent}`);
  if (opts.avoid)            parts.push(`## Avoid\n\n${opts.avoid}`);
  // Author feedback is authoritative — a human rejected the prior version. Placed
  // high and stated as a directive so the model prioritizes it.
  if (opts.guidance && opts.guidance.trim()) {
    parts.push(`## Author Feedback (a prior version was REJECTED — apply this)\n\n${opts.guidance.trim()}`);
  }

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
  blocks?: Record<string, string | null>;   // resolved block IDs used in composition
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
    blocks:            opts.blocks,
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
  tone_id: string;         // prompts.id of the segment tone (stable; not the display name)
  generate_quiz?: boolean; // if true, generate quiz after cards using the same correlationId
};

// Thin job wrapper. Core logic is generateSegmentContent (below), exported so the
// batch orchestrator can drive it directly with the BATCH's correlationId.
export async function generateSegmentContentHandler(job: Job): Promise<unknown> {
  return generateSegmentContent(job.input as Input);
}

// Core: generate + replace a segment's cards (whole-unit). correlationId defaults to
// a fresh uuid (standalone job); the batch passes its own so a whole run is one
// provenance thread. Throws on any failure (the batch records + continues).
export async function generateSegmentContent(input: Input & { correlationId?: string }) {
  const { seg_id, tone_id, generate_quiz: alsoGenerateQuiz = false } = input;
  if (!seg_id)  throw new Error("input.seg_id is required");
  if (!tone_id) throw new Error("input.tone_id is required");

  const correlationId = input.correlationId ?? randomUUID();

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
  const promptRow = await loadSegmentPromptRowById(tone_id);

  const [toneContent, structureContent, cardPositionsContent, lengthContent] = await Promise.all([
    loadBlock(promptRow.tone_block_id,      "tone"),
    loadBlock(promptRow.structure_block_id, "structure"),
    loadBlock(promptRow.card_positions_block_id, "card positions"),  // "" if FK null; throws if set-but-fails
    resolveLengthContent(promptRow),   // size profile (default) → rendered length, else block
  ]);

  // Step 3 — compose prompts (avoid = error-severity voice-lint bans, injected)
  const systemMessage = promptRow.system_message;
  const userMessage = composeUserMessage({
    scope:              promptRow.scope,
    toneContent,
    structureContent,
    cardPositionsContent,
    lengthContent,
    lessonTitle:        lesson.lesson_name ?? "",
    segmentName:        segment.segment_name ?? "",
    segmentDescription: segment.description ?? null,
    avoid:              await loadPromptBanInstruction(),
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
    notes:             `tone: ${promptRow.tone ?? tone_id} (${tone_id})`,
    blocks: {
      tone:           promptRow.tone_block_id,
      structure:      promptRow.structure_block_id,
      length:         promptRow.length_block_id,
      card_positions: promptRow.card_positions_block_id,
    },
  });

  // Step 5 — replace sub_segments (whole-unit: delete then insert).
  // content_images.sub_segment_id is ON DELETE CASCADE, so the image rows die with the
  // cards — but purge the underlying storage files + image_assets rows first, or they
  // orphan as bloat. (No-op on a first-time/empty segment.)
  const { data: prevCards } = await supabase.from("sub_segments").select("id").eq("seg_id", seg_id);
  await purgeImagesForSubSegments((prevCards ?? []).map((c) => c.id));
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
    tone_id,               // per-card tone (migration 030) — this is the CORE path the
                           // batch (generate_track_content) also hits.
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
