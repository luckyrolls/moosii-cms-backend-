// ---------------------------------------------------------------------------
// Slice A2 — what a batch run actually cost, read back from ai_generation_log by the
// batch's correlation id (= the parent job.id). No new state: the log IS the record, which
// is why every handler logs with `correlationId = job.id` (CLAUDE.md, AI generation logging).
//
// The mapping from a logged call to a LESSON is whatever the handler recorded:
//   segment_content / segment_content_regen / quiz → related_entity_type 'segment'      → seg_id
//   segment_content_regen (card scope)             → related_entity_type 'sub_segment'  → card
//   image_generate                                 → related_entity_type 'content_image'→ image
//   image_prompt_generate                          → NULL (an intermediate call, by the rule
//                                                     "related_entity_id is null for
//                                                     intermediate calls") → unattributable
// Anything that cannot be mapped is counted in `unattributed_calls` rather than dropped, so
// the run total always reconciles even when a per-lesson row cannot.
// ---------------------------------------------------------------------------

import { supabase } from "../supabase";
import { extractUsage, type Usage } from "./aiUsage";

export type LogRow = {
  operation: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  response: unknown;
};

export type RunUsage = {
  ai_calls: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  unattributed_calls: number;
};

/** Every logged call for one run. Read-only; a failure returns [] (never breaks a report). */
export async function loadRunLog(jobId: string): Promise<LogRow[]> {
  const { data, error } = await supabase
    .from("ai_generation_log")
    .select("operation, related_entity_type, related_entity_id, response")
    .eq("correlation_id", jobId);
  if (error) {
    console.error(`[batchUsage] failed to read ai_generation_log for ${jobId}: ${error.message}`);
    return [];
  }
  return (data ?? []) as LogRow[];
}

/** PURE. Run totals, plus how many calls had nothing to attribute them to. */
export function runUsageFrom(rows: LogRow[], attributable: (r: LogRow) => boolean): RunUsage {
  let tokens_in = 0, tokens_out = 0, tokens_total = 0, unattributed_calls = 0;
  for (const r of rows) {
    const u: Usage | null = extractUsage(r.response);
    if (u) {
      tokens_in += u.tokens_in;
      tokens_out += u.tokens_out;
      tokens_total += u.tokens_total;
    }
    if (!attributable(r)) unattributed_calls++;
  }
  return { ai_calls: rows.length, tokens_in, tokens_out, tokens_total, unattributed_calls };
}

/**
 * PURE. Tokens per lesson for a CONTENT run. `segToLesson` comes from the plan itself (every
 * unit carries its lesson), so no extra query is needed to resolve the hierarchy.
 *
 * `cardToLesson` covers the `sub_segment`-scoped regen log rows; the track batch does not
 * produce them today (it calls generateSegmentContent, which logs 'segment'), but the map is
 * accepted so a future card-scoped unit reports rather than silently going unattributed.
 */
export function contentTokensByLesson(
  rows: LogRow[],
  segToLesson: Map<string, string>,
  cardToLesson?: Map<string, string>
): { byLesson: Map<string, number>; usage: RunUsage } {
  const lessonOf = (r: LogRow): string | undefined => {
    if (!r.related_entity_id) return undefined;
    if (r.related_entity_type === "segment") return segToLesson.get(r.related_entity_id);
    if (r.related_entity_type === "sub_segment") return cardToLesson?.get(r.related_entity_id);
    return undefined;
  };

  const byLesson = new Map<string, number>();
  for (const r of rows) {
    const lesson = lessonOf(r);
    if (!lesson) continue;
    const u = extractUsage(r.response);
    if (!u) continue;
    byLesson.set(lesson, (byLesson.get(lesson) ?? 0) + u.tokens_total);
  }
  return { byLesson, usage: runUsageFrom(rows, (r) => lessonOf(r) !== undefined) };
}

/**
 * PURE. AI calls per lesson for an IMAGE run.
 *
 * Every planned slot makes EXACTLY TWO calls — `image_prompt_generate` (the prompt writer)
 * then `image_generate` (`generateSubSegmentImage.ts`) — and only the second records an
 * entity. So a lesson's call count is `2 x (its image_generate rows)`: a pairing that follows
 * from the code path, not a guess. The prompt-writer half still shows up in
 * `usage.unattributed_calls`, and `usage.tokens_total` counts BOTH halves.
 *
 * `imageToLesson` maps a content_images.id to its lesson; the caller builds it from the rows
 * that carry `job_id = <this run>`.
 */
export function imageCallsByLesson(
  rows: LogRow[],
  imageToLesson: Map<string, string>
): { byLesson: Map<string, number>; usage: RunUsage } {
  const lessonOf = (r: LogRow): string | undefined =>
    r.related_entity_type === "content_image" && r.related_entity_id
      ? imageToLesson.get(r.related_entity_id)
      : undefined;

  const byLesson = new Map<string, number>();
  for (const r of rows) {
    const lesson = lessonOf(r);
    if (!lesson) continue;
    byLesson.set(lesson, (byLesson.get(lesson) ?? 0) + 2);
  }
  return { byLesson, usage: runUsageFrom(rows, (r) => lessonOf(r) !== undefined) };
}

/** Content run: load + map in one call. Never throws. */
export async function lessonTokensForRun(
  jobId: string,
  segToLesson: Map<string, string>
): Promise<{ byLesson: Map<string, number>; usage: RunUsage }> {
  return contentTokensByLesson(await loadRunLog(jobId), segToLesson);
}

/**
 * Image run: find the images this run created (`content_images.job_id = jobId`), map them to
 * lessons, then load + map the log. Never throws.
 *
 * `cardToLesson` is the PLAN's own map — an image slot IS a sub_segment, so every image this
 * run created belongs to a card the plan named, and no hierarchy query is needed. An image on
 * a card outside the plan would be left unattributed rather than guessed at.
 */
export async function lessonImageCallsForRun(
  jobId: string,
  cardToLesson: Map<string, string>
): Promise<{ byLesson: Map<string, number>; usage: RunUsage; imagesCreated: number }> {
  const { data, error } = await supabase
    .from("content_images")
    .select("id, sub_segment_id")
    .eq("job_id", jobId);
  if (error) {
    console.error(`[batchUsage] failed to read content_images for ${jobId}: ${error.message}`);
  }
  const images = (data ?? []) as { id: string; sub_segment_id: string | null }[];

  const imageToLesson = new Map<string, string>();
  for (const i of images) {
    const lesson = i.sub_segment_id ? cardToLesson.get(i.sub_segment_id) : undefined;
    if (lesson) imageToLesson.set(i.id, lesson);
  }

  const mapped = imageCallsByLesson(await loadRunLog(jobId), imageToLesson);
  return { ...mapped, imagesCreated: images.length };
}
