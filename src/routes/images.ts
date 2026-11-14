import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { logApproval } from "../lib/approvalLog";
import { apiError } from "../lib/errors";
import { hasCapability, hasAnyCapability } from "../middleware/jwtAuth";
import { captureReview, diffReview, toApprovalFields } from "../lib/cardReview";

const router = Router();
const BUCKET = "lessons";

// POST /images/:id/approve — cap: EDITORIAL. A picture is an editorial choice; the clinical
// consequence is handled by the database, which DEMOTES an already clinically_approved card to
// editorial_reviewed when its picture changes (sub_segments_image_swap_review, migration 092/093).
// That demotion happens in a TRIGGER, so this route reports it by snapshotting the segment's
// review state before the approve and diffing after — see `approval_reset` in the response.
router.post("/:id/approve", async (req: Request, res: Response): Promise<void> => {
  if (!hasCapability(req.user, "editorial")) {
    apiError(res, 403, "forbidden", "Requires editorial capability"); return;
  }
  const { id } = req.params;

  // Load the row — need storage_path to derive the public URL before calling the RPC
  const { data: image, error: loadErr } = await supabase
    .from("content_images")
    .select("id, sub_segment_id, storage_path, status")
    .eq("id", id)
    .single();

  if (loadErr || !image) {
    res.status(404).json({ error: "content_image not found" });
    return;
  }

  if (image.storage_path === "pending") {
    res.status(409).json({
      error: "content_image has no uploaded image (the generation job may have failed mid-flight)",
    });
    return;
  }

  // Snapshot the owning segment's review state BEFORE the approve, so the trigger's demotion
  // is visible in the response. A lesson/segment-level image has no sub_segment, hence the null.
  let segId: string | null = null;
  if (image.sub_segment_id) {
    const { data: card } = await supabase
      .from("sub_segments").select("seg_id").eq("id", image.sub_segment_id).maybeSingle();
    segId = (card?.seg_id as string | null) ?? null;
  }
  const before = segId ? await captureReview(segId) : null;

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(image.storage_path);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: result, error: rpcErr } = await (supabase as any).rpc("approve_content_image", {
    p_id: id,
    // Actor is the verified JWT user ONLY — client-supplied approver retired.
    p_approved_by: req.user?.id ?? null,
    p_public_url: urlData.publicUrl,
    p_storage_path: image.storage_path,
  } as any);

  if (rpcErr) {
    console.error("approve_content_image RPC failed:", rpcErr);
    res.status(500).json({ error: rpcErr.message });
    return;
  }

  await logApproval("image", id, "approve", req);
  const after = segId ? await captureReview(segId) : null;
  res.json({
    ok: true,
    ...(result as object),
    ...(before && after ? toApprovalFields(diffReview(before, after, "card")) : {}),
  });
});

// POST /images/:id/reject — cap: EDITORIAL or CLINICAL. Either reviewer may discard a
// candidate. It never touches sub_segments.image (the approved pointer is guarded below), so
// no review state moves and there is no approval_reset to report.
router.post("/:id/reject", async (req: Request, res: Response): Promise<void> => {
  if (!hasAnyCapability(req.user, ["editorial", "clinical"])) {
    apiError(res, 403, "forbidden", "Requires editorial or clinical capability"); return;
  }
  const { id } = req.params;

  const { data: image, error: loadErr } = await supabase
    .from("content_images")
    .select("id, status")
    .eq("id", id)
    .single();

  if (loadErr || !image) {
    res.status(404).json({ error: "content_image not found" });
    return;
  }

  // Guard: rejecting the approved image would leave sub_segments.image pointing
  // at a row marked rejected. Caller must approve a replacement first.
  if (image.status === "approved") {
    res.status(409).json({
      error: "Cannot reject an approved image. Approve a replacement first.",
    });
    return;
  }

  const { error: updateErr } = await supabase
    .from("content_images")
    .update({ status: "rejected" })
    .eq("id", id);

  if (updateErr) {
    res.status(500).json({ error: updateErr.message });
    return;
  }

  res.json({ ok: true, content_image_id: id, status: "rejected" });
});

export default router;
