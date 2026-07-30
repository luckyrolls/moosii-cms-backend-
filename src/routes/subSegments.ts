import express, { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { supabase } from "../supabase";
import { createAndStartJob } from "../jobs/runner";
import { purgeImagesForSubSegments } from "../storage/purgeImages";
import { uploadImage } from "../storage/upload";
import { reGateSegmentIfComplete } from "../lib/reGateSegment";
import { apiError } from "../lib/errors";

// content_images.source / uploaded_by postdate database.types.ts (migration applied, types
// not yet regenerated from live schema — no db-url in this env). Untyped bridge for the
// upload insert only; drop it when the types are regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
const BUCKET = "lessons"; // matches src/storage/upload.ts

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

// POST /sub-segments/:id/upload-image — §1g. A human uploads ONE image for a card. It lands
// as a content_images CANDIDATE (source='uploaded'); approval stays the existing
// POST /content-images/:id/approve (this route writes NO pointer). SYNCHRONOUS 201, not the
// 202+poll job pattern — an upload is not an LLM call (same deliberate deviation as §2j).
//
// Raw-body middleware is scoped to THIS route only — the global express.json() 100 kB limit
// (index.ts) is untouched. express.json() ignores non-JSON content types, so an image/* body
// passes through it and is parsed here into req.body: Buffer.
router.post(
  "/:id/upload-image",
  express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "10mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const subSegmentId = req.params.id;
    const bytes = req.body as Buffer;

    // 1. Resolve the card + its segment.
    const { data: sub, error: subErr } = await supabase
      .from("sub_segments").select("id, seg_id").eq("id", subSegmentId).maybeSingle();
    if (subErr) { apiError(res, 500, "db_error", subErr.message); return; }
    if (!sub) { apiError(res, 404, "not_found", `sub_segment ${subSegmentId} not found`); return; }
    const segId = sub.seg_id;
    // (2. No published-lesson guard — image generation has none; mirror it, invent no policy.)

    // 3. Dimensions via sharp BEFORE uploading anything. Unparseable → 400.
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      apiError(res, 400, "invalid_image", "Request body was empty — send raw image bytes with an image/* Content-Type."); return;
    }
    let width: number | undefined, height: number | undefined;
    try {
      const meta = await sharp(bytes).metadata();
      width = meta.width; height = meta.height;
    } catch {
      apiError(res, 400, "invalid_image", "Could not parse the payload as an image."); return;
    }
    if (!width || !height) { apiError(res, 400, "invalid_image", "Image has no readable dimensions."); return; }

    // 4. Accept policy — REJECT, never crop, never pad. Two distinct reasons possible.
    const aspect = width / height;
    const longEdge = Math.max(width, height);
    const aspectOk = aspect >= 1.6 && aspect <= 2.1;
    const sizeOk = longEdge >= 1200;
    if (!aspectOk || !sizeOk) {
      const reasons: string[] = [];
      if (!aspectOk) reasons.push(`aspect ${aspect.toFixed(2)}:1 is outside the required 1.6–2.1`);
      if (!sizeOk) reasons.push(`long edge ${longEdge}px is below the required minimum of 1200px`);
      apiError(res, 400, "image_out_of_spec",
        `Image is ${width}×${height} (${aspect.toFixed(2)}:1). ${reasons.join("; ")}. ` +
        `Cards are 1200×655 (~1.83:1); uploads are rejected, never cropped or padded.`);
      return;
    }

    // 5. Re-encode + store via the EXISTING helper (WebP, ≤1200 long edge, canonical path).
    const imageId = randomUUID();
    const mimeType = (req.headers["content-type"] ?? "image/png").split(";")[0].trim();
    let up: Awaited<ReturnType<typeof uploadImage>>;
    try {
      up = await uploadImage({ bytes, mimeType, subSegmentId, imageId });
    } catch (e) {
      apiError(res, 500, "upload_failed", e instanceof Error ? e.message : String(e)); return;
    }

    // Cleanup: remove the just-written object. The storage trigger created its image_assets
    // row synchronously on upload, so a single remove drops the file WHILE the row exists —
    // exactly the ordering purgeImages.ts:39-55 protects (avoids the P0001 the delete trigger
    // raises on a missing row). Best-effort, never throws.
    const cleanupFile = async () => { try { await supabase.storage.from(BUCKET).remove([up.path]); } catch { /* leak over crash */ } };

    // 6. Read back image_assets for the public URL (trigger is synchronous — one query, no
    //    retry). Absent → clean up + fail loudly HERE, not as an opaque 409 at lesson approve.
    const { data: asset } = await supabase.from("image_assets").select("id").eq("url", up.publicUrl).maybeSingle();
    if (!asset) {
      await cleanupFile();
      apiError(res, 500, "asset_not_registered", `Stored file has no image_assets row (${up.path}); file removed.`); return;
    }

    // 7. INSERT the candidate. uploaded_by comes from the VERIFIED JWT — never the body.
    const { data: ci, error: ciErr } = await db.from("content_images").insert({
      sub_segment_id: subSegmentId,
      storage_path: up.path,
      status: "candidate",
      source: "uploaded",
      uploaded_by: req.user?.id ?? null,
      final_prompt: null, image_prompt: null, image_generator_name: null, scene: null,
    }).select("id").single();
    if (ciErr || !ci) {
      await cleanupFile(); // 8. no orphan file left behind
      apiError(res, 500, "insert_failed", ciErr?.message ?? "content_images insert failed"); return;
    }

    // 9. Re-gate the segment (shared helper). No-op + approval_reset:false when not 'complete'.
    const { approval_reset } = await reGateSegmentIfComplete(segId!);

    res.status(201).json({
      ok: true,
      content_image_id: ci.id,
      sub_segment_id: subSegmentId,
      seg_id: segId,
      status: "candidate",
      source: "uploaded",
      public_url: up.publicUrl,
      storage_path: up.path,
      width: up.width,
      height: up.height,
      bytes: up.bytes,
      approval_reset,
    });
  }
);

export default router;
