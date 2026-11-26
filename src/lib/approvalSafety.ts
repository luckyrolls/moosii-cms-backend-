// ---------------------------------------------------------------------------
// Slice A1 — approval safety. PURE decisions; every caller loads the state itself.
//
// Three rules live here, and nowhere else, so the batch planners, the per-unit jobs, the
// route preconditions and the migration's SQL cannot drift apart:
//
//   1. blocksGate            — when an un-ruled-on image holds a segment out of 'complete'
//   2. candidateArrivalTarget — what a NEW candidate does to its card's review state
//   3. contentSkipReason / imageSkipReason — what a batch refuses to touch, and why
//
// Rule 1 is mirrored in SQL by `recompute_seg_status` (migration 129). If one changes, the
// other must: that function is the SINGLE writer of seg_status and the only thing the app
// and the RLS reader policies key on. The duplication is deliberate (the gate must hold
// against CMS-direct writes too) and is covered by the db test, which asserts the SQL and
// this module agree on the same fixtures.
// ---------------------------------------------------------------------------

export type ReviewState = "draft" | "editorial_reviewed" | "clinically_approved";

/** The only two facts about a card's images that any rule here needs. */
export type CardImages = { has_approved: boolean; has_candidate: boolean };

// ---------------------------------------------------------------------------
// 1. The gate
// ---------------------------------------------------------------------------

/**
 * A card holds its segment out of 'complete' when it has NO approved image but DOES have a
 * candidate: a picture nobody has ruled on, and nothing live to fall back to.
 *
 * A replacement candidate BESIDE an approved image does NOT block — the live image is still
 * the approved one, so a published lesson must not drop to published_unreviewed just because
 * someone pressed regenerate. That asymmetry is the whole point of the rule.
 */
export function blocksGate(img: CardImages): boolean {
  return !img.has_approved && img.has_candidate;
}

/** Segment-level: 'complete' iff >=1 card, every card clinically approved, no card blocking. */
export function deriveSegStatus(
  cards: { review_state: ReviewState; images: CardImages }[]
): "complete" | "pending" {
  if (cards.length === 0) return "pending";
  if (cards.some((c) => c.review_state !== "clinically_approved")) return "pending";
  if (cards.some((c) => blocksGate(c.images))) return "pending";
  return "complete";
}

// ---------------------------------------------------------------------------
// 2. What a new candidate costs the card
// ---------------------------------------------------------------------------

/**
 * A new candidate image arrives on a card. Returns the review state to move it to, or null
 * for "change nothing".
 *
 *   * the card already has an approved image  → null. Nothing live changed.
 *   * no approved image, card clinically approved → 'editorial_reviewed'. The TEXT approval
 *     survives; only the clinical/visual sign-off is spent. (Before slice A1 this was
 *     'draft', which also threw away the editorial pass over text nobody had edited.)
 *   * anything else → null. A draft or editorial card has nothing left to lose.
 *
 * Approving the candidate later still demotes clinical via migration 093 — unchanged.
 */
export function candidateArrivalTarget(
  current: ReviewState,
  img: { has_approved: boolean }
): ReviewState | null {
  if (img.has_approved) return null;
  if (current === "clinically_approved") return "editorial_reviewed";
  return null;
}

// ---------------------------------------------------------------------------
// 3. What a batch refuses to touch
// ---------------------------------------------------------------------------

export type SkipReason =
  | "published"        // a published lesson is parent-facing; a batch never rewrites it
  | "archived"         // a HUMAN shelved it: see trackExcludedFromBatch / lessonGateFor below
  | "approved_images"  // the segment carries an approved image a replace would destroy
  | "approved_content" // replace only: the segment is signed off
  | "resume"           // a dead run in this lineage already regenerated this unit
  | "no_content";      // images only: nothing to illustrate yet

export type BatchMode = "fill_missing" | "replace";

/** Lesson-level facts, shared by both batches. `archived` already folds in the track. */
export type LessonGate = { published: boolean; archived: boolean };

/** The three track columns batch eligibility reads (128 added the last two). */
export type TrackGate = {
  archived_at: string | null;
  mode_archived: boolean | null;
  test_group: string | null;
};

/**
 * Is this track OUT of every batch? Only when a HUMAN put it away:
 *
 *   * `test_group = 'legacy'` — old work, outside the rotation for good. A mode switch never
 *     touches it in either direction (migration 128), so nothing will ever reveal it.
 *   * `archived_at` set AND `mode_archived = false` — a person archived it, in the CMS or by
 *     hand, and 128's sync trigger recorded that as manual.
 *
 * A track the MODE SWITCHER archived (`mode_archived = true`) is NOT excluded. It is the live
 * catalog of some other mode: invisible to parents today, and perfectly buildable today — which
 * is the normal state of EVERY live track while Moosii sits in `mem`. Excluding it would make a
 * batch's eligible set depend on which mode happens to be active, so building the live
 * curriculum would mean switching the whole catalog over to it first.
 *
 * `mode_archived` carries the distinction on its own (128's CHECK makes it imply `archived_at`,
 * and its sync trigger forces it false on any archival that does not set it), so the two tests
 * above do not overlap: legacy is checked by name because a legacy track that someone
 * unarchived by hand would otherwise read as eligible.
 */
export function trackExcludedFromBatch(t: TrackGate): boolean {
  if (t.test_group === "legacy") return true;
  return !!t.archived_at && !t.mode_archived;
}

/**
 * Fold a lesson and its track into the gate both batches read. The lesson's OWN `archived_at`
 * is always manual — lessons have no `mode_archived` and no mode switch touches them.
 */
export function lessonGateFor(
  lesson: { is_published: boolean | null; archived_at: string | null },
  track: TrackGate
): LessonGate {
  return {
    published: !!lesson.is_published,
    archived: !!lesson.archived_at || trackExcludedFromBatch(track),
  };
}

/**
 * Precedence is fixed and deliberate: lesson-level exclusions first (they are absolute and
 * say nothing about the segment), then the destructive-image refusal, then the sign-off, then
 * resume. `approved_images` outranks `approved_content` so the report names the image loss —
 * the one that cannot be undone by re-approving.
 */
function lessonSkip(lesson: LessonGate): SkipReason | null {
  if (lesson.published) return "published";
  if (lesson.archived) return "archived";
  return null;
}

export type ContentSegment = {
  seg_id: string;
  lesson: LessonGate;
  has_content: boolean;
  content_approved: boolean;
  has_approved_image: boolean;
  regenerated_since_cutoff: boolean;
};

/**
 * Should the content batch plan this segment, and if not, why?
 * `{ plan: false, skip: null }` means "nothing to do and nothing worth reporting" — in
 * fill_missing, a segment that already has content.
 *
 * `approved_images` applies in BOTH modes, not just replace: `generateSegmentContent` purges
 * every card's images before delete+insert (generateSegmentContent.ts:314-318) whatever the
 * mode that reached it, so the destruction does not care which mode planned the unit.
 */
export function contentSkipReason(
  seg: ContentSegment,
  mode: BatchMode
): { plan: boolean; skip: SkipReason | null } {
  const ls = lessonSkip(seg.lesson);
  if (ls) return { plan: false, skip: ls };
  if (seg.has_approved_image) return { plan: false, skip: "approved_images" };

  if (mode === "fill_missing") {
    return seg.has_content ? { plan: false, skip: null } : { plan: true, skip: null };
  }
  if (seg.content_approved) return { plan: false, skip: "approved_content" };
  if (seg.regenerated_since_cutoff) return { plan: false, skip: "resume" };
  return { plan: true, skip: null };
}

export type QuizSegment = {
  seg_id: string;
  lesson: LessonGate;
  question_count: number;
  quiz_approved: boolean;
  regenerated_since_cutoff: boolean;
};

/**
 * The quiz half of the content batch. No image rule: `generateQuiz` replaces questions and
 * answers and touches no image.
 */
export function quizSkipReason(
  seg: QuizSegment,
  mode: BatchMode
): { plan: boolean; skip: SkipReason | null } {
  const ls = lessonSkip(seg.lesson);
  if (ls) return { plan: false, skip: ls };

  if (mode === "fill_missing") {
    return seg.question_count === 0 ? { plan: true, skip: null } : { plan: false, skip: null };
  }
  if (seg.quiz_approved) return { plan: false, skip: "approved_content" };
  if (seg.regenerated_since_cutoff) return { plan: false, skip: "resume" };
  return { plan: true, skip: null };
}

export type ImageSlot = {
  sub_segment_id: string;
  lesson: LessonGate;
  has_image: boolean;      // candidate|approved present — the existing 'gaps' definition
  segment_has_content: boolean;
};

/**
 * The image batch is fill-only, so it never destroys anything — but it still must not add
 * pictures to a published or archived lesson, which is what the lesson gate is for here.
 */
export function imageSkipReason(slot: ImageSlot): { plan: boolean; skip: SkipReason | null } {
  const ls = lessonSkip(slot.lesson);
  if (ls) return { plan: false, skip: ls };
  if (slot.has_image) return { plan: false, skip: null };   // regen is per-image, not a batch
  if (!slot.segment_has_content) return { plan: false, skip: "no_content" };
  return { plan: true, skip: null };
}

/** Tally skip reasons for `jobs.result`. Always carries every key, so a zero is explicit. */
export function tallySkips(reasons: (SkipReason | null)[]): Record<SkipReason, number> {
  const t: Record<SkipReason, number> = {
    published: 0, archived: 0, approved_images: 0, approved_content: 0, resume: 0, no_content: 0,
  };
  for (const r of reasons) if (r) t[r]++;
  return t;
}

// ---------------------------------------------------------------------------
// 4. The single-segment refusal (route precondition)
// ---------------------------------------------------------------------------

/**
 * A content (re)generation that would destroy an approved image is refused BEFORE the job
 * row is created, so the CMS gets a 409 it can show rather than a job that fails later.
 *
 * Scope-aware, because the destruction is: `whole_segment` (and first-time
 * `generate_segment_content`) purges every card in the segment; `single_card` purges only
 * that one card (regenSegmentContent.ts:276).
 *
 * `approvedImageCardIds` is the set of cards in the segment that hold an approved image.
 */
export function regenApprovedImageBlock(opts: {
  scope: "whole_segment" | "single_card";
  card_id?: string | null;
  approvedImageCardIds: string[];
}): { count: number; card_ids: string[] } | null {
  const { scope, card_id, approvedImageCardIds } = opts;
  const hit =
    scope === "single_card"
      ? approvedImageCardIds.filter((id) => id === card_id)
      : approvedImageCardIds;
  if (hit.length === 0) return null;
  return { count: hit.length, card_ids: hit };
}
