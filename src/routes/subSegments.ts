import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { createAndStartJob } from "../jobs/runner";
import { purgeImagesForSubSegments } from "../storage/purgeImages";
import { apiError } from "../lib/errors";

const router = Router();

// POST /sub-segments/:id/generate-image
// Creates a single generate_sub_segment_image job for the given sub-segment.
// Backs "redo this one" and the prompt-tweak/compare loop.
router.post("/:id/generate-image", async (req: Request, res: Response): Promise<void> => {
  const subSegmentId = req.params.id;
  const { instructions_override, prompt_override, scene } = req.body as {
    instructions_override?: string;
    prompt_override?: string;
    scene?: string;
  };

  try {
    const jobId = await createAndStartJob("generate_sub_segment_image", {
      sub_segment_id: subSegmentId,
      auto_approve: false,
      ...(instructions_override && { instructions_override }),
      ...(prompt_override && { prompt_override }),
      ...(scene && { scene }),
    });
    res.status(202).json({ job_id: jobId });
  } catch (err) {
    console.error("Failed to create generate-image job:", err);
    apiError(res, 500, "job_create_failed", "Failed to create image generation job");
  }
});

// DELETE /sub-segments/:id — delete a card. NOT a direct CMS write: image cleanup has a
// strict ordered purge (storage trigger enforces clear-pointer → delete content_images →
// remove file → drop image_assets, else P0001), owned by purgeImagesForSubSegments
// (service-role). Order here is mandatory:
//   1. purge images (storage + image_assets + content_images)
//   2. delete the card row (content_findings cascade on sub_segment_id)
//   3. RENUMBER the segment's remaining cards to contiguous 1..N — a gap breaks single-card
//      regen ("card 5 of 4") and the `sequence == totalCards ⇒ takeaway` detection
//   4. re-gate the segment (structure changed) — matches how content regen re-gates
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;

  // Resolve the card's segment (and confirm it exists) before any destructive step.
  const { data: card, error: cardErr } = await supabase
    .from("sub_segments").select("id, seg_id").eq("id", id).maybeSingle();
  if (cardErr) { apiError(res, 500, "db_error", cardErr.message); return; }
  if (!card) { apiError(res, 404, "not_found", `sub_segment ${id} not found`); return; }
  const segId = card.seg_id;

  // 1. Purge images first (ordered storage/image_assets/content_images cleanup; best-effort
  //    on storage — never throws on a file-removal failure).
  await purgeImagesForSubSegments([id]);

  // 2. Delete the card row (content_findings.sub_segment_id ON DELETE CASCADE fires).
  const { error: delErr } = await supabase.from("sub_segments").delete().eq("id", id);
  if (delErr) { apiError(res, 500, "delete_failed", delErr.message); return; }

  // 3. Renumber remaining cards to contiguous 1..N. Ascending order compacts safely even
  //    under a UNIQUE(seg_id, sequence) constraint — each target slot was just vacated by a
  //    lower card (delete only shifts DOWN). Skip rows already in place (no-op writes).
  const { data: remaining, error: remErr } = await supabase
    .from("sub_segments").select("id, sequence").eq("seg_id", segId!).order("sequence", { ascending: true });
  if (remErr) { apiError(res, 500, "db_error", remErr.message); return; }
  const cards = remaining ?? [];
  for (let i = 0; i < cards.length; i++) {
    const want = i + 1;
    if (cards[i].sequence !== want) {
      const { error: upErr } = await supabase.from("sub_segments").update({ sequence: want }).eq("id", cards[i].id);
      if (upErr) { apiError(res, 500, "renumber_failed", upErr.message); return; }
    }
  }

  // 4. Re-gate the segment: structure changed → force a re-review/re-publish.
  const { error: gateErr } = await supabase
    .from("segments").update({ seg_status: "pending", approved_by: null }).eq("id", segId!);
  if (gateErr) { apiError(res, 500, "regate_failed", gateErr.message); return; }

  res.json({
    ok: true,
    seg_id: segId,
    deleted_id: id,
    cards: cards.map((c, i) => ({ id: c.id, sequence: i + 1 })),
  });
});

export default router;
