import { supabase } from "../supabase";

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
