import { supabase } from "../supabase";
import { candidateArrivalTarget } from "./approvalSafety";

// review_state / the RPCs postdate database.types.ts (migration 056). Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ReviewState = "draft" | "editorial_reviewed" | "clinically_approved";

// seg_status is DERIVED — the ONLY code path that changes it is recompute_seg_status, a
// SECURITY DEFINER RPC that locks the segment and derives the gate from card review_state.
// Node never writes seg_status directly anymore (a follow-up privilege guard makes a direct
// write a permission error). Returns the recomputed 'complete' | 'pending'.
export async function recomputeSegStatus(segId: string): Promise<string | null> {
  const { data, error } = await db.rpc("recompute_seg_status", { p_seg_id: segId });
  if (error) throw new Error(`recompute_seg_status failed: ${error.message}`);
  return (data as string) ?? null;
}

export type SetCardsResult = { segment_id: string; cards_updated: number; seg_status: string };

// Transition cards + one recompute, atomic under the segment lock (the RPC). cardIds null =
// every card in the segment. fromState non-null enforces the step order (draft→editorial→
// clinical) at the data layer; null = any current state (used by resets). actorId is stamped
// as segments.approved_by ONLY on a clinical approval. CAPABILITY IS ENFORCED IN THE ROUTE
// BEFORE THIS IS CALLED — this is a mechanical setter.
export async function setCardsReviewState(
  segId: string,
  cardIds: string[] | null,
  newState: ReviewState,
  fromState: ReviewState | null,
  actorId: string | null
): Promise<SetCardsResult> {
  const { data, error } = await db.rpc("set_card_review_state", {
    p_seg_id: segId,
    p_card_ids: cardIds,
    p_new_state: newState,
    p_from_state: fromState,
    p_actor: actorId,
  });
  if (error) throw new Error(`set_card_review_state failed: ${error.message}`);
  return data as SetCardsResult;
}

// A content/structure change invalidates a card's review: reset the given card(s) to 'draft'
// (any current state) and recompute. Replaces the old reGateSegmentIfComplete for the paths
// that changed a card's content or image. cardIds null = the whole segment (full regen).
export async function resetCardsToDraft(segId: string, cardIds: string[] | null): Promise<SetCardsResult> {
  return setCardsReviewState(segId, cardIds, "draft", null, null);
}

// SLICE A1 — a NEW CANDIDATE image arrived on a card. This replaces the old
// `resetCardsToDraft` call on the two candidate paths (the image job and the upload route).
//
// The rule is in `candidateArrivalTarget` (src/lib/approvalSafety.ts) and comes to two cases:
//   * the card already has an APPROVED image → change NOTHING. The live picture is still the
//     approved one, so a published lesson must not drop to published_unreviewed because
//     somebody pressed regenerate. The segment's gate is still recomputed — by the
//     content_images trigger (migration 129), not from here.
//   * no approved image → a clinically_approved card drops to 'editorial_reviewed' and keeps
//     its TEXT approval. A draft or editorial card is untouched (the `p_from_state` guard
//     makes that a no-op, so this is safe to call unconditionally).
//
// Returns whether an approval was actually spent, for the route's `approval_reset` field.
export async function applyCandidateArrival(
  segId: string,
  cardId: string
): Promise<{ demoted: boolean; seg_status: string | null }> {
  const { data: card } = await db
    .from("sub_segments").select("review_state").eq("id", cardId).maybeSingle();
  const current = (card?.review_state as ReviewState | undefined) ?? "draft";

  const { data: approved } = await db
    .from("content_images").select("id")
    .eq("sub_segment_id", cardId).eq("status", "approved").limit(1);
  const hasApproved = ((approved ?? []) as unknown[]).length > 0;

  const target = candidateArrivalTarget(current, { has_approved: hasApproved });
  if (!target) {
    // Nothing to move. Do NOT recompute here: migration 129's content_images trigger already
    // did it when the candidate row landed, and calling it again would be a second lock on
    // the segment for no change.
    const { data: seg } = await db.from("segments").select("seg_status").eq("id", segId).maybeSingle();
    return { demoted: false, seg_status: (seg?.seg_status as string | null) ?? null };
  }

  const r = await setCardsReviewState(segId, [cardId], target, "clinically_approved", null);
  return { demoted: r.cards_updated > 0, seg_status: r.seg_status };
}

// Reset + report whether an approved segment was knocked back (preserves the old
// reGateSegmentIfComplete `approval_reset` contract for the routes that surface it). The
// before-read is informational only (approval_reset), so a race there is harmless.
export async function resetCardsAndReport(
  segId: string,
  cardIds: string[] | null
): Promise<{ seg_status: string; approval_reset: boolean }> {
  const { data: before } = await db.from("segments").select("seg_status").eq("id", segId).maybeSingle();
  const r = await resetCardsToDraft(segId, cardIds);
  return { seg_status: r.seg_status, approval_reset: before?.seg_status === "complete" && r.seg_status !== "complete" };
}

// ---------------------------------------------------------------------------
// APPROVAL-RESET REPORTING (slice 2)
//
// Several edit paths invalidate review in the DATABASE, not in the route: the 066 triggers
// reset a card (text edit) or a WHOLE segment (insert/delete/reorder — card_positions roles
// are position-derived, invariant 2), and sub_segments_image_swap_review demotes a
// clinically_approved card to editorial_reviewed when its picture changes. A route that only
// reported its own writes would under-report. So every such route snapshots the segment's
// review state BEFORE its work and diffs afterwards, which catches trigger effects too.
export type ReviewSnapshot = {
  seg_status: string | null;
  draft: number;
  editorial_reviewed: number;
  clinically_approved: number;
  quiz_pending: number;
};

export type ResetSummary = {
  approval_reset: boolean;
  scope: "none" | "card" | "segment";
  seg_status: string | null;
  cards_reset_to_draft: number;
  cards_demoted_to_editorial: number;
  quiz_questions_reset: number;
};

export async function captureReview(segId: string): Promise<ReviewSnapshot> {
  const { data: seg } = await db.from("segments").select("seg_status").eq("id", segId).maybeSingle();
  const { data: cards } = await db.from("sub_segments").select("review_state").eq("seg_id", segId);
  const { data: quiz } = await db.from("quiz_questions").select("answer_status").eq("segment_id", segId);
  const rows = (cards ?? []) as Array<{ review_state: string | null }>;
  const count = (s: string) => rows.filter((r) => r.review_state === s).length;
  return {
    seg_status: (seg?.seg_status as string | null) ?? null,
    draft: count("draft"),
    editorial_reviewed: count("editorial_reviewed"),
    clinically_approved: count("clinically_approved"),
    quiz_pending: ((quiz ?? []) as Array<{ answer_status: string | null }>)
      .filter((q) => q.answer_status !== "approved").length,
  };
}

// PURE. `scope` is declared by the caller because only the caller knows what it did: a text
// edit touches one card, a structural change (add/delete/reorder) re-gates the whole segment.
// It is reported as "none" when nothing actually moved, whatever the caller intended.
export function diffReview(
  before: ReviewSnapshot,
  after: ReviewSnapshot,
  scope: "card" | "segment"
): ResetSummary {
  const cards_reset_to_draft = Math.max(0, after.draft - before.draft);
  const cards_demoted_to_editorial = Math.max(0, after.editorial_reviewed - before.editorial_reviewed);
  const quiz_questions_reset = Math.max(0, after.quiz_pending - before.quiz_pending);
  const gate_lost = before.seg_status === "complete" && after.seg_status !== "complete";
  const moved = cards_reset_to_draft > 0 || cards_demoted_to_editorial > 0 || quiz_questions_reset > 0 || gate_lost;
  return {
    approval_reset: moved,
    scope: moved ? scope : "none",
    seg_status: after.seg_status,
    cards_reset_to_draft,
    cards_demoted_to_editorial,
    quiz_questions_reset,
  };
}

// Response shape, shared by every edit route. `approval_reset` stays the BOOLEAN that
// PATCH /sub-segments/:id has always returned, so a CMS doing `if (approval_reset)` keeps
// working; the breakdown is ADDITIVE under `approval_reset_detail` (an object is always
// truthy, so widening the existing field would have silently reported a reset on every call).
export function toApprovalFields(
  summary: ResetSummary
): { approval_reset: boolean; approval_reset_detail: Omit<ResetSummary, "approval_reset"> } {
  const { approval_reset, ...detail } = summary;
  return { approval_reset, approval_reset_detail: detail };
}
