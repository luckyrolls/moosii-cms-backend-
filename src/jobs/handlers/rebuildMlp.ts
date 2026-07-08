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
// A suppressed questionnaire + the milestone fact that caused it. The rebuild only
// needs the ids (→ exclusion keys); the questionnaire-status inspector also needs the
// milestone name to show WHY it's suppressed.
export type SuppressionHit = { questionnaireId: string; milestoneId: string; milestoneName: string | null };

// Detail variant — same resolution the rebuild uses, returning the (questionnaire,
// milestone) hits. computeMilestoneSuppression below maps this to exclusion keys.
export async function computeMilestoneSuppressionDetail(
  userId: string,
  pool: MlpPoolItem[]
): Promise<SuppressionHit[]> {
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

  // Resolve milestone names (also catches DANGLING mappings: an id that isn't a real
  // milestone can never match a fact — facts FK milestones — so it surfaces, but a
  // mistaken mapping should be visible, not silent. P4).
  const mappedMilestoneIds = [...new Set(mappings.map((m) => m.milestone_id))];
  const { data: realMs } = await db.from("milestones").select("id, name").in("id", mappedMilestoneIds);
  const nameById = new Map(((realMs ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
  for (const m of mappings) {
    if (!nameById.has(m.milestone_id)) {
      console.warn(`[rebuild_mlp] questionnaire ${m.id} maps to nonexistent milestone ${m.milestone_id}; surfacing it (dangling mapping)`);
    }
  }

  // Suppress a questionnaire ONLY when its mapped milestone is a resolved fact.
  return mappings
    .filter((m) => facts.has(m.milestone_id))
    .map((m) => ({ questionnaireId: m.id, milestoneId: m.milestone_id, milestoneName: nameById.get(m.milestone_id) ?? null }));
}

// Exclusion-key variant — what the rebuild consumes (unchanged behavior). Returns
// `item_type:item_id` keys for suppressed questionnaires.
export async function computeMilestoneSuppression(
  userId: string,
  pool: MlpPoolItem[]
): Promise<string[]> {
  return (await computeMilestoneSuppressionDetail(userId, pool)).map((h) => `questionnaire:${h.questionnaireId}`);
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
export type CompletedRow = { item_id: string; item_type: string; score: number | null; created_at: string };
export type Band = { min: number | null; max: number | null; days: number };

// Pure selection: which recurring band governs the latest answer? A band matches
// when its range contains the score (null bound = open-ended on that side); among
// matches the SHORTEST interval wins (most attentive follow-up). null score or no
// match → null (one-shot). Extracted so the questionnaire-status inspector can report
// WHICH band matched without re-deriving the selection (single source of truth).
export function matchRecurringBand(latestScore: number | null, bands: Band[]): Band | null {
  if (latestScore === null || latestScore === undefined) return null; // no guessing
  const matched = bands.filter(
    (bd) => (bd.min === null || latestScore >= bd.min) && (bd.max === null || latestScore <= bd.max)
  );
  if (matched.length === 0) return null; // score matched no recurring band → one-shot
  return matched.reduce((best, bd) => (bd.days < best.days ? bd : best));
}

// Pure decision: given the latest answer (score + when) and the questionnaire's
// recurring bands, is it due again NOW? Unit-testable without the DB. Delegates band
// selection to matchRecurringBand; due once elapsed >= the matched band's interval.
export function isQuestionnaireDue(
  latestScore: number | null,
  latestCreatedAtMs: number,
  bands: Band[],
  nowMs: number
): boolean {
  const band = matchRecurringBand(latestScore, bands);
  if (!band) return false;
  const elapsedDays = (nowMs - latestCreatedAtMs) / 86_400_000;
  return elapsedDays >= band.days;
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

// The shared inputs the MLP is computed over: the user's active tracks (enriched
// with track_type), the published candidate pool scoped to those tracks, and the
// youngest child's age. Extracted so the questionnaire-status inspector sees the
// EXACT same universe the rebuild does — one pool query, no divergence.
export type UserMlpInputs = { tracks: MlpTrack[]; pool: MlpPoolItem[]; youngestAgeMonths: number | null };

export async function loadUserMlpInputs(userId: string): Promise<UserMlpInputs> {
  // 1. Active tracks — the resolved track list (owns demographics/defaults/questionnaire
  //    actions/manual mods; do NOT reimplement). Resolved via the per-user FUNCTION
  //    (migration 037) rather than the whole-user-base VIEW + filter: same rows (verified
  //    byte-identical), but O(one user) so it stays cheap as the user base grows.
  const { data: activeTracksRaw, error: tErr } = await db
    .rpc("user_active_tracks_for_user", { p_user_id: userId });
  if (tErr) throw new Error(`user_active_tracks_for_user rpc failed: ${tErr.message}`);
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
  const youngestAgeMonths = num(mlpData?.youngest_age_in_months);

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

  return { tracks, pool, youngestAgeMonths };
}

// The MLP row shape written to user_mlp_v2 (also the preview payload). Mirrors the
// BuildShip updateMLP record so stored output matches for diffing.
export type MlpItemRow = {
  item_id: string;
  item_type: string;
  track_id: string;
  track_name: string;
  position: number;
  item_name: string;
  item_description: string;
  with_quiz: boolean;
  item_priority: number | null;
  track_weight: number | null;
  track_priority: number | null;
};

// Overrides for the shared compute core. Both default to "as the rebuild does it":
//   ageMonthsOverride — replaces the youngest-child age (feeds BOTH the pool age gate
//     AND age-bracket weighting, exactly as the real age does — same semantics, a
//     different value). Undefined → the child's real age. Preview only.
//   includeCompleted — true → NOTHING is excluded as completed (view the full path).
//     False/undefined → the rebuild's normal completed set (with due-again re-inclusion).
//     This bypasses ONLY the completed-exclusion; milestone suppression + the age gate
//     still apply.
export type MlpComputeOverrides = { ageMonthsOverride?: number; includeCompleted?: boolean };

export type MlpComputeResult = {
  items: MlpItemRow[];
  childAgeMonths: number | null;   // the real youngest-child age (for the CMS default)
  ageMonthsUsed: number | null;    // ageMonthsOverride ?? childAgeMonths
  activeTrackCount: number;
  debug: ReturnType<typeof generateFullMLP>["debug"];
};

// SHARED COMPUTE CORE — everything the rebuild does EXCEPT persistence. Pure reads +
// the pure generateFullMLP algorithm; NO writes, NO side effects. rebuildOneUser wraps
// this with the atomic rpc; the CMS preview endpoint calls it with overrides and never
// persists. Single source of the due/suppression/age math — no duplication.
export async function computeUserMlp(
  userId: string,
  overrides: MlpComputeOverrides = {}
): Promise<MlpComputeResult> {
  // 1-3. Active tracks, track_type enrichment, demographics, candidate pool.
  const { tracks, pool, youngestAgeMonths: childAgeMonths } = await loadUserMlpInputs(userId);

  // Age actually used: the override when given (0 is valid), else the real child age.
  const ageMonthsUsed = overrides.ageMonthsOverride ?? childAgeMonths;

  // 4. Completed exclusion. include_completed → exclude NOTHING (skip the query + due
  //    computation entirely). Otherwise the normal set with due-again re-inclusion.
  let completedItems: CompletedItem[] = [];
  if (!overrides.includeCompleted) {
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
    completedItems = completedRows
      .filter((c) => !(c.item_type === "questionnaire" && dueQuestionnaires.has(c.item_id)))
      .map((c) => ({ item_id: c.item_id, item_type: c.item_type })) as CompletedItem[];
  }

  // 4b. Milestone suppression (slice 3) — DERIVED per-user at build time. ALWAYS applied
  //     (include_completed does not bypass it). Wrapped so any failure yields an empty
  //     exclusion (default-to-surface): a bug here can only over-surface, never hide.
  let suppressedItemKeys: string[] = [];
  try {
    suppressedItemKeys = await computeMilestoneSuppression(userId, pool);
  } catch (e) {
    console.warn(
      `[rebuild_mlp] milestone suppression errored for ${userId}; surfacing all questionnaires: ${e instanceof Error ? e.message : String(e)}`
    );
    suppressedItemKeys = [];
  }

  // Run the ported algorithm. The age value feeds both the bracket weighting (ages)
  // and the pool age gate (youngestAgeMonths), exactly as the rebuild does.
  const { finalMLP, debug } = generateFullMLP({
    pool,
    tracks,
    completedItems,
    ages: ageMonthsUsed !== null ? [ageMonthsUsed] : [], // v1: youngest child only
    youngestAgeMonths: ageMonthsUsed, // CHANGE 2 pool age filter
    suppressedItemKeys, // CHANGE 3 (slice 3) milestone suppression
  });

  const items: MlpItemRow[] = finalMLP.map((i) => ({
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

  return { items, childAgeMonths, ageMonthsUsed, activeTrackCount: tracks.length, debug };
}

// Rebuild a single user's MLP into user_mlp_v2 (verification phase). Persist wrapper
// around computeUserMlp (real age, normal completed set) — output byte-identical.
export async function rebuildOneUser(userId: string): Promise<RebuildOneUserResult> {
  const compute = await computeUserMlp(userId);

  // Atomic delete + insert into user_mlp_v2 (no stale rows, no position clashes).
  const { data: insertedCount, error: rpcErr } = await db.rpc("rebuild_user_mlp", {
    p_user_id: userId,
    p_items: compute.items,
  });
  if (rpcErr) throw new Error(`rebuild_user_mlp rpc failed: ${rpcErr.message}`);

  return {
    user_id: userId,
    items_written: typeof insertedCount === "number" ? insertedCount : compute.items.length,
    pool_size: compute.debug.poolSize,
    filtered_pool_size: compute.debug.filteredPoolSize,
    active_track_count: compute.activeTrackCount,
    debug: compute.debug,
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
