import { Router, Request, Response } from "express";
import { supabase } from "../supabase";

const router = Router();
const BUCKET = "lessons";

// POST /images/:id/approve
router.post("/:id/approve", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { approved_by } = req.body as { approved_by?: string };

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

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(image.storage_path);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: result, error: rpcErr } = await (supabase as any).rpc("approve_content_image", {
    p_id: id,
    p_approved_by: approved_by ?? null,
    p_public_url: urlData.publicUrl,
    p_storage_path: image.storage_path,
  } as any);

  if (rpcErr) {
    console.error("approve_content_image RPC failed:", rpcErr);
    res.status(500).json({ error: rpcErr.message });
    return;
  }

  res.json({ ok: true, ...(result as object) });
});

// POST /images/:id/reject
router.post("/:id/reject", async (req: Request, res: Response): Promise<void> => {
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
