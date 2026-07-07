import { supabase } from "../../supabase";
import {
  generateFullMLP,
  type MlpTrack,
  type MlpPoolItem,
  type CompletedItem,
} from "../../mlp/generateFullMLP";
import type { Job } from "../registry";

// The MLP views, the `tracks` table, user_mlp, and the rebuild_user_mlp rpc
// (which writes production user_mlp as of migration 017) are not in the generated
// database.types yet. Use an untyped bridge (same pattern as generateSegmentContent).
// Regenerate types after running the migrations and drop this cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type SingleInput = { user_id: string };
type BatchInput = { scope: "all" };

// Coerce PostgREST numerics (which can arrive as strings) to number | null.
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export type RebuildOneUserResult = {
  user_id: string;
  items_written: number;
  pool_size: number;
  filtered_pool_size: number;
  active_track_count: number;
  debug: unknown;
};

// Slice 3 SUPPRESS — resolve which pooled questionnaires are redundant for this
// user because their mapped milestone (questionnaire.milestone_id) is already a
// recorded fact for the user's child. Returns `item_type:item_id` keys to exclude.
//
// DEFAULT-TO-SURFACE is structural here: this function NEVER throws — every
// early-out (no questionnaires, no child, no facts, no mappings) returns []. The
// caller also wraps it in try/catch. A questionnaire is suppressed ONLY on a
// positive, resolved (child, milestone) fact match; any doubt surfaces it.
//
// Child resolution: MLP is user-scoped but facts are child-scoped, so we resolve
// the user's YOUNGEST child (children.parent_id) — consistent with the age gate,
// which also targets the youngest. child_count is ~1 today; revisit if multi-child
// becomes real.
export async function computeMilestoneSuppression(
  userId: string,
  pool: MlpPoolItem[]
): Promise<string[]> {
  const questionnaireIds = pool
    .filter((i) => i.item_type === "questionnaire")
    .map((i) => i.item_id);
  if (questionnaireIds.length === 0) return [];

  // Which of the pooled questionnaires even HAVE a milestone mapping? (Unmapped =
  // unsuppressible by construction — there is no row to consult.)
  const { data: mapRows, error: mErr } = await db
    .from("questionnaire")
    .select("id, milestone_id")
    .in("id", questionnaireIds)
    .not("milestone_id", "is", null);
  if (mErr) {
    console.warn(`[rebuild_mlp] questionnaire mapping load failed for ${userId}; surfacing all: ${mErr.message}`);
    return [];
  }
  const mappings = (mapRows ?? []) as Array<{ id: string; milestone_id: string }>;
  if (mappings.length === 0) return [];

  // Youngest child of this user.
  const { data: kids, error: kErr } = await db
    .from("children")
    .select("id, birth_year, birth_month, created_at")
    .eq("parent_id", userId)
    .order("birth_year", { ascending: false })
    .order("birth_month", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (kErr) {
    console.warn(`[rebuild_mlp] child resolution failed for ${userId}; surfacing all: ${kErr.message}`);
    return [];
  }
  const childId = (kids ?? [])[0]?.id as string | undefined;
  if (!childId) return []; // no child → nothing to suppress against

  // The child's recorded milestone facts.
  const { data: factRows, error: fErr } = await db
    .from("child_milestones")
    .select("milestone_id")
    .eq("child_id", childId);
  if (fErr) {
    console.warn(`[rebuild_mlp] child_milestones load failed for ${userId}; surfacing all: ${fErr.message}`);
    return [];
  }
  const facts = new Set(((factRows ?? []) as Array<{ milestone_id: string }>).map((f) => f.milestone_id));
  if (facts.size === 0) return [];

  // Warn on a DANGLING mapping (points at a milestone id that isn't a real
  // milestone) — it can never match a fact (facts FK milestones), so it surfaces,
  // but a mistaken mapping should be visible, not silent. P4.
  const mappedMilestoneIds = [...new Set(mappings.map((m) => m.milestone_id))];
  const { data: realMs } = await db.from("milestones").select("id").in("id", mappedMilestoneIds);
  const realMsSet = new Set(((realMs ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const m of mappings) {
    if (!realMsSet.has(m.milestone_id)) {
      console.warn(`[rebuild_mlp] questionnaire ${m.id} maps to nonexistent milestone ${m.milestone_id}; surfacing it (dangling mapping)`);
    }
  }

  // Suppress a questionnaire ONLY when its mapped milestone is a resolved fact.
  return mappings
    .filter((m) => facts.has(m.milestone_id))
    .map((m) => `questionnaire:${m.id}`);
}

// Recurrence (migration 033) — resolve which ALREADY-COMPLETED questionnaires are
// DUE AGAIN and must NOT be excluded from the pool. Per (user, questionnaire): take
// the LATEST completed_items row (created_at DESC); find the score-band rule(s) on
// that questionnaire whose [score_min_range, score_max_range] contains that row's
// score AND have a non-null repeat_after_days (shortest interval wins — most
// attentive follow-up); the questionnaire is due once now - created_at >= interval.
//
// DEFAULT-TO-EXCLUDE is structural: this never throws, and every doubt (no bands,
// null score, band query error) yields "not due" = today's one-shot behavior. So
// with repeat_after_days NULL everywhere (no recurring bands) it returns an empty
// set and the rebuild is byte-identical to before. Suppression stays a separate
// sibling filter — a due-again questionnaire whose milestone fact exists is still
// independently excluded; recurrence and suppression do not couple.
type CompletedRow = { item_id: string; item_type: string; score: number | null; created_at: string };
type Band = { min: number | null; max: number | null; days: number };

// Pure decision: given the latest answer (score + when) and the questionnaire's
// recurring bands, is it due again NOW? Extracted so the recurrence math is unit-
// testable without the DB. Rules: null score → one-shot (false); a band matches when
// its range contains the score (null bound = open-ended on that side); shortest
// matching interval wins; due once elapsed >= that interval.
export function isQuestionnaireDue(
  latestScore: number | null,
  latestCreatedAtMs: number,
  bands: Band[],
  nowMs: number
): boolean {
  if (latestScore === null || latestScore === undefined) return false; // no guessing
  const matched = bands
    .filter((bd) => (bd.min === null || latestScore >= bd.min) && (bd.max === null || latestScore <= bd.max))
    .map((bd) => bd.days);
  if (matched.length === 0) return false; // score matched no recurring band → one-shot
  const interval = Math.min(...matched); // shortest interval wins — most attentive follow-up
  const elapsedDays = (nowMs - latestCreatedAtMs) / 86_400_000;
  return elapsedDays >= interval;
}

export async function computeDueQuestionnaires(completed: CompletedRow[]): Promise<Set<string>> {
  // Latest completed row per questionnaire (by created_at).
  const latestByQ = new Map<string, { score: number | null; createdAt: number }>();
  for (const r of completed) {
    if (r.item_type !== "questionnaire" || !r.item_id) continue;
    const t = new Date(r.created_at).getTime();
    const prev = latestByQ.get(r.item_id);
    if (!prev || t > prev.createdAt) latestByQ.set(r.item_id, { score: r.score, createdAt: t });
  }
  if (latestByQ.size === 0) return new Set();

  // Recurring bands for those questionnaires (repeat_after_days NOT NULL).
  const { data: bandRows, error } = await db
    .from("questionnaire_response")
    .select("questionnaire_id, score_min_range, score_max_range, repeat_after_days")
    .in("questionnaire_id", [...latestByQ.keys()])
    .not("repeat_after_days", "is", null);
  if (error) {
    console.warn(`[rebuild_mlp] recurring-band load failed; treating all as one-shot: ${error.message}`);
    return new Set();
  }
  const bandsByQ = new Map<string, Band[]>();
  for (const b of (bandRows ?? []) as Array<Record<string, unknown>>) {
    const qid = b.questionnaire_id as string | null;
    const days = num(b.repeat_after_days);
    if (!qid || days === null) continue;
    const list = bandsByQ.get(qid) ?? [];
    list.push({ min: num(b.score_min_range), max: num(b.score_max_range), days });
    bandsByQ.set(qid, list);
  }

  const now = Date.now();
  const due = new Set<string>();
  for (const [qid, latest] of latestByQ) {
    if (isQuestionnaireDue(latest.score, latest.createdAt, bandsByQ.get(qid) ?? [], now)) {
      due.add(qid); // answered AND past due → re-surface
    }
  }
  return due;
}

// Rebuild a single user's MLP into user_mlp_v2 (verification phase).
export async function rebuildOneUser(userId: string): Promise<RebuildOneUserResult> {
  // 1. Active tracks — the resolved track list (view owns demographics/defaults/
  //    questionnaire actions/manual mods; do NOT reimplement).
  const { data: activeTracksRaw, error: tErr } = await db
    .from("user_active_tracks")
    .select("user_id, track_id, track_name, priority, weight")
    .eq("user_id", userId);
  if (tErr) throw new Error(`user_active_tracks query failed: ${tErr.message}`);
  const activeTracks = (activeTracksRaw ?? []) as Array<Record<string, unknown>>;
  const trackIds = [...new Set(activeTracks.map((t) => t.track_id as string))];

  // 1b. track_type is NOT on the view but IS on the base `tracks` table; it
  //     drives the 'Age' track weight adjustment, so enrich it here to match
  //     BuildShip. If the lookup fails, fall back to non-Age (logged).
  const trackTypeById: Record<string, string | null> = {};
  if (trackIds.length > 0) {
    const { data: trackRows, error: ttErr } = await db
      .from("tracks")
      .select("id, track_type")
      .in("id", trackIds);
    if (ttErr) {
      console.warn(
        `[rebuild_mlp] could not load tracks.track_type (${ttErr.message}); treating all tracks as non-Age`
      );
    } else {
      for (const r of (trackRows ?? []) as Array<Record<string, unknown>>) {
        trackTypeById[r.id as string] = (r.track_type as string | null) ?? null;
      }
    }
  }

  const tracks: MlpTrack[] = activeTracks.map((t) => ({
    track_id: t.track_id as string,
    track_name: (t.track_name as string | null) ?? null,
    priority: num(t.priority),
    weight: num(t.weight),
    track_type: trackTypeById[t.track_id as string] ?? null,
  }));

  // 2. Demographics — youngest child age feeds both bracket weighting and the
  //    pool age filter (v1 = youngest child only).
  const { data: mlpData, error: dErr } = await db
    .from("user_mlp_data")
    .select("user_id, youngest_age_in_months, child_count")
    .eq("user_id", userId)
    .maybeSingle();
  if (dErr) throw new Error(`user_mlp_data query failed: ${dErr.message}`);
  const youngest = num(mlpData?.youngest_age_in_months);

  // 3. Candidate pool — CHANGE 1: published only, scoped to the user's tracks.
  let pool: MlpPoolItem[] = [];
  if (trackIds.length > 0) {
    const { data: poolRaw, error: pErr } = await db
      .from("mlp_item_pool")
      .select(
        "item_id, item_type, track_id, priority, item_name, item_description, min_child_age, max_child_age, is_published, with_quiz"
      )
      .eq("is_published", true)
      .in("track_id", trackIds);
    if (pErr) throw new Error(`mlp_item_pool query failed: ${pErr.message}`);
    pool = ((poolRaw ?? []) as Array<Record<string, unknown>>).map((i) => ({
      item_id: i.item_id as string,
      item_type: i.item_type as string,
      track_id: i.track_id as string,
      priority: num(i.priority),
      item_name: (i.item_name as string | null) ?? null,
      item_description: (i.item_description as string | null) ?? null,
      with_quiz: (i.with_quiz as boolean | null) ?? null,
      min_child_age: num(i.min_child_age),
      max_child_age: num(i.max_child_age),
    }));
  }

  // 4. Completed items — excluded from the pool. Keys are `item_type:item_id`.
  //    score + created_at are pulled for recurrence (migration 033); they're ignored
  //    for non-questionnaire items and when no band has a repeat interval.
  const { data: completedRaw, error: cErr } = await db
    .from("completed_items")
    .select("item_id, item_type, score, created_at")
    .eq("user_id", userId);
  if (cErr) throw new Error(`completed_items query failed: ${cErr.message}`);
  const completedRows = ((completedRaw ?? []) as Array<Record<string, unknown>>).map((c) => ({
    item_id: c.item_id as string,
    item_type: c.item_type as string,
    score: num(c.score),
    created_at: (c.created_at as string | null) ?? "",
  })) as CompletedRow[];

  // 4a. Recurrence (slice: score-band intervals) — DERIVED per-user at build time.
  //     Wrapped so any failure yields "nothing due" (default-to-exclude = today's
  //     one-shot behavior); a bug here can only fail to re-surface, never wrongly hide.
  let dueQuestionnaires: Set<string> = new Set();
  try {
    dueQuestionnaires = await computeDueQuestionnaires(completedRows);
  } catch (e) {
    console.warn(
      `[rebuild_mlp] recurrence check errored for ${userId}; treating all questionnaires as one-shot: ${e instanceof Error ? e.message : String(e)}`
    );
    dueQuestionnaires = new Set();
  }

  // Due-again questionnaires drop OUT of the exclusion set so the pool re-includes
  // them; everything else (all lessons, not-yet-due and one-shot questionnaires)
  // excludes exactly as before.
  const completedItems = completedRows
    .filter((c) => !(c.item_type === "questionnaire" && dueQuestionnaires.has(c.item_id)))
    .map((c) => ({ item_id: c.item_id, item_type: c.item_type })) as CompletedItem[];

  // 4b. Milestone suppression (slice 3) — DERIVED per-user at build time. Wrapped
  //     so any failure yields an empty exclusion (default-to-surface): a bug here
  //     can only over-surface a questionnaire, never silently hide one.
  let suppressedItemKeys: string[] = [];
  try {
    suppressedItemKeys = await computeMilestoneSuppression(userId, pool);
  } catch (e) {
    console.warn(
      `[rebuild_mlp] milestone suppression errored for ${userId}; surfacing all questionnaires: ${e instanceof Error ? e.message : String(e)}`
    );
    suppressedItemKeys = [];
  }

  // Run the ported algorithm.
  const { finalMLP, debug } = generateFullMLP({
    pool,
    tracks,
    completedItems,
    ages: youngest !== null ? [youngest] : [], // v1: youngest child only
    youngestAgeMonths: youngest, // CHANGE 2 pool age filter
    suppressedItemKeys, // CHANGE 3 (slice 3) milestone suppression
  });

  // Build the write payload, mirroring the BuildShip updateMLP record shape
  // (coerce with_quiz ?? false etc.) so stored output matches for diffing.
  const items = finalMLP.map((i) => ({
    item_id: i.item_id,
    item_type: i.item_type,
    track_id: i.track_id,
    track_name: i.track_name || "",
    position: i.position,
    item_name: i.item_name || "Untitled",
    item_description: i.item_description || "",
    with_quiz: i.with_quiz ?? false,
    item_priority: i.item_priority ?? null,
    track_weight: i.track_weight ?? null,
    track_priority: i.track_priority ?? null,
  }));

  // Atomic delete + insert into user_mlp_v2 (no stale rows, no position clashes).
  const { data: insertedCount, error: rpcErr } = await db.rpc("rebuild_user_mlp", {
    p_user_id: userId,
    p_items: items,
  });
  if (rpcErr) throw new Error(`rebuild_user_mlp rpc failed: ${rpcErr.message}`);

  return {
    user_id: userId,
    items_written: typeof insertedCount === "number" ? insertedCount : items.length,
    pool_size: debug.poolSize,
    filtered_pool_size: debug.filteredPoolSize,
    active_track_count: tracks.length,
    debug,
  };
}

type BatchResult = {
  users_processed: number;
  users_succeeded: number;
  users_failed: number;
  errors: Array<{ user_id: string; error: string }>;
};

// Rebuild every eligible user (those with a user_mlp_data row, i.e. at least one
// child with valid birth data). One user's failure must NOT abort the batch.
async function rebuildAllUsers(): Promise<BatchResult> {
  const { data: rows, error } = await db.from("user_mlp_data").select("user_id");
  if (error) throw new Error(`Failed to load eligible users: ${error.message}`);

  const userIds = [
    ...new Set(
      ((rows ?? []) as Array<Record<string, unknown>>)
        .map((r) => r.user_id as string)
        .filter(Boolean)
    ),
  ];

  let succeeded = 0;
  const errors: Array<{ user_id: string; error: string }> = [];
  const queue = [...userIds];

  // Small worker pool; isolate per-user failures.
  const CONCURRENCY = 3;
  async function worker() {
    while (queue.length > 0) {
      const uid = queue.shift();
      if (!uid) continue;
      try {
        await rebuildOneUser(uid);
        succeeded += 1;
      } catch (e) {
        errors.push({ user_id: uid, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
  );

  return {
    users_processed: userIds.length,
    users_succeeded: succeeded,
    users_failed: errors.length,
    errors,
  };
}

export async function rebuildMlpHandler(job: Job): Promise<unknown> {
  const input = job.input as Partial<SingleInput & BatchInput>;

  if (input.scope === "all") {
    return rebuildAllUsers();
  }

  if (!input.user_id) {
    throw new Error("input.user_id is required (or input.scope: 'all')");
  }
  return rebuildOneUser(input.user_id);
}
