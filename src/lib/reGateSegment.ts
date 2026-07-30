import { supabase } from "../supabase";

// A new content candidate means the segment is no longer fully reviewed: knock a currently-
// 'complete' segment back to 'pending' and clear approved_by, so it must be re-published
// (mirrors content regen). SCOPED to 'complete' segments via the WHERE — a true no-op
// otherwise (no updated_at churn), which is correct for first-time / batch generation on
// un-approved segments. Returns whether it actually re-gated (approval_reset).
//
// SINGLE implementation, shared by generate_sub_segment_image (non-auto_approve path) and the
// manual upload route — do not write a second copy of this policy.
export async function reGateSegmentIfComplete(segId: string): Promise<{ approval_reset: boolean }> {
  const { data } = await supabase
    .from("segments")
    .update({ seg_status: "pending", approved_by: null })
    .eq("id", segId)
    .eq("seg_status", "complete")
    .select("id");
  return { approval_reset: (data ?? []).length > 0 };
}
