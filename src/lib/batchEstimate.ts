// ---------------------------------------------------------------------------
// Slice A2 — what a batch is about to cost, in CALLS and TOKENS, from measured history.
//
// NO DOLLARS, deliberately: there is no rate card in this repo (FINDINGS-track-buildout §6),
// and a hard-coded price goes stale silently. Calls and tokens are facts this database has.
//
// Every number is measured, never assumed: the per-unit averages come from
// `ai_generation_log` over a stated window, and the cards-per-segment multiplier (how many
// image slots a content run will CREATE — the count is model-determined, so it cannot be
// known before the run) comes from the live `sub_segments` population. Each figure carries
// the basis it was computed from, so a reader can see when it is thin.
// ---------------------------------------------------------------------------

import { supabase } from "../supabase";
import { extractUsage } from "./aiUsage";

/** The AI calls one unit of each kind makes — a property of the code path, not a measurement. */
export const CALLS_PER_UNIT = {
  content: 1,   // generateSegmentContent: one segment_content call
  quiz: 1,      // generateQuiz: one quiz call
  image: 2,     // generateSubSegmentImage: image_prompt_generate + image_generate
} as const;

/** Which logged operation stands for which unit when averaging. */
export const OPERATION_FOR_UNIT = {
  content: ["segment_content", "segment_content_regen"],
  quiz: ["quiz"],
  image: ["image_prompt_generate", "image_generate"],
} as const;

export type OpAverage = {
  operation: string;
  calls: number;              // how many logged calls the average rests on
  avg_tokens_in: number;
  avg_tokens_out: number;
  avg_tokens_total: number;
  window: "window" | "all_time";   // which basis this row actually used
};

export type EstimateBasis = {
  window_days: number;
  window_from: string;
  operations: Record<string, OpAverage>;
  /** The image-slot multiplier: cards per segment, measured live. null when nothing exists. */
  cards_per_segment: { segments: number; avg: number; min: number; max: number } | null;
  notes: string[];
};

type UsageRow = { operation: string | null; usage: unknown; um: unknown };

const MIN_CALLS_FOR_WINDOW = 3;

function averageOf(rows: UsageRow[], operation: string, window: OpAverage["window"]): OpAverage {
  let n = 0, i = 0, o = 0, t = 0;
  for (const r of rows) {
    if (r.operation !== operation) continue;
    const u = extractUsage({ usage: r.usage, usageMetadata: r.um });
    if (!u) continue;
    n++;
    i += u.tokens_in;
    o += u.tokens_out;
    t += u.tokens_total;
  }
  const round = (v: number) => (n === 0 ? 0 : Math.round(v / n));
  return {
    operation,
    calls: n,
    avg_tokens_in: round(i),
    avg_tokens_out: round(o),
    avg_tokens_total: round(t),
    window,
  };
}

/**
 * Measured per-operation averages. Reads ONLY the usage blocks (a PostgREST JSON-path select),
 * not the prompts or raw completions — those are the large columns and none of this needs them.
 *
 * An operation with fewer than three calls inside the window falls back to its all-time
 * average and says so in `window`, because three samples of a 60-second LLM call is not an
 * average worth showing and silently reporting 0 would be worse.
 */
export async function loadEstimateBasis(windowDays = 90): Promise<EstimateBasis> {
  const from = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const ops = [
    ...OPERATION_FOR_UNIT.content,
    ...OPERATION_FOR_UNIT.quiz,
    ...OPERATION_FOR_UNIT.image,
  ];
  const notes: string[] = [];

  const select = "operation, usage:response->usage, um:response->usageMetadata";
  const [windowed, allTime] = await Promise.all([
    supabase.from("ai_generation_log").select(select).in("operation", ops).gte("created_at", from),
    supabase.from("ai_generation_log").select(select).in("operation", ops),
  ]);
  if (windowed.error) notes.push(`windowed averages unavailable: ${windowed.error.message}`);
  if (allTime.error) notes.push(`all-time averages unavailable: ${allTime.error.message}`);
  const wRows = (windowed.data ?? []) as unknown as UsageRow[];
  const aRows = (allTime.data ?? []) as unknown as UsageRow[];

  const operations: Record<string, OpAverage> = {};
  for (const op of ops) {
    const w = averageOf(wRows, op, "window");
    operations[op] = w.calls >= MIN_CALLS_FOR_WINDOW ? w : averageOf(aRows, op, "all_time");
  }

  return {
    window_days: windowDays,
    window_from: from,
    operations,
    cards_per_segment: await loadCardsPerSegment(notes),
    notes,
  };
}

/**
 * Cards per segment, over every segment that has content. This is the ONLY way to anticipate
 * how many image slots a content run will create: the card count is chosen by the model
 * (api-contract §2b), so the preview must quote a range, not a promise.
 */
export async function loadCardsPerSegment(
  notes: string[] = []
): Promise<EstimateBasis["cards_per_segment"]> {
  const { data, error } = await supabase
    .from("sub_segments")
    .select("seg_id")
    .not("content", "is", null);
  if (error) {
    notes.push(`cards-per-segment basis unavailable: ${error.message}`);
    return null;
  }
  const perSeg = new Map<string, number>();
  for (const r of (data ?? []) as { seg_id: string | null }[]) {
    if (!r.seg_id) continue;
    perSeg.set(r.seg_id, (perSeg.get(r.seg_id) ?? 0) + 1);
  }
  const counts = [...perSeg.values()];
  if (counts.length === 0) return null;
  const sum = counts.reduce((a, b) => a + b, 0);
  return {
    segments: counts.length,
    avg: Math.round((sum / counts.length) * 100) / 100,
    min: Math.min(...counts),
    max: Math.max(...counts),
  };
}

export type UnitCounts = { content: number; quiz: number; image: number };

export type Estimate = {
  ai_calls: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  /** Per unit kind, so a CMS can show where the cost sits. */
  by_unit: Record<keyof UnitCounts, { units: number; ai_calls: number; tokens_total: number }>;
  /**
   * Image slots the CONTENT phase will create, which do not exist yet and are therefore NOT
   * in `ai_calls` above. null when there is no measured multiplier.
   */
  image_slots_content_will_create: { expected: number; low: number; high: number } | null;
};

/** PURE. Multiply measured averages by planned units. */
export function estimateFor(counts: UnitCounts, basis: EstimateBasis): Estimate {
  const avg = (op: string) => basis.operations[op]?.avg_tokens_total ?? 0;
  const avgIn = (op: string) => basis.operations[op]?.avg_tokens_in ?? 0;
  const avgOut = (op: string) => basis.operations[op]?.avg_tokens_out ?? 0;

  // Content uses the first-generation average; a batch's content unit IS a first generation
  // for the segment it touches (replace delete+inserts), so segment_content is the right row.
  const perUnit = {
    content: { in: avgIn("segment_content"), out: avgOut("segment_content"), total: avg("segment_content") },
    quiz: { in: avgIn("quiz"), out: avgOut("quiz"), total: avg("quiz") },
    image: {
      in: avgIn("image_prompt_generate") + avgIn("image_generate"),
      out: avgOut("image_prompt_generate") + avgOut("image_generate"),
      total: avg("image_prompt_generate") + avg("image_generate"),
    },
  };

  const by_unit = {
    content: {
      units: counts.content,
      ai_calls: counts.content * CALLS_PER_UNIT.content,
      tokens_total: counts.content * perUnit.content.total,
    },
    quiz: {
      units: counts.quiz,
      ai_calls: counts.quiz * CALLS_PER_UNIT.quiz,
      tokens_total: counts.quiz * perUnit.quiz.total,
    },
    image: {
      units: counts.image,
      ai_calls: counts.image * CALLS_PER_UNIT.image,
      tokens_total: counts.image * perUnit.image.total,
    },
  };

  const cps = basis.cards_per_segment;
  return {
    ai_calls: by_unit.content.ai_calls + by_unit.quiz.ai_calls + by_unit.image.ai_calls,
    tokens_in:
      counts.content * perUnit.content.in + counts.quiz * perUnit.quiz.in + counts.image * perUnit.image.in,
    tokens_out:
      counts.content * perUnit.content.out + counts.quiz * perUnit.quiz.out + counts.image * perUnit.image.out,
    tokens_total: by_unit.content.tokens_total + by_unit.quiz.tokens_total + by_unit.image.tokens_total,
    by_unit,
    image_slots_content_will_create:
      cps && counts.content > 0
        ? {
            expected: Math.round(counts.content * cps.avg),
            low: counts.content * cps.min,
            high: counts.content * cps.max,
          }
        : null,
  };
}
