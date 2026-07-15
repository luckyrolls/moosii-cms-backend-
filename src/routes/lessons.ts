import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { createAndStartJob, enqueueRebuildAllIfIdle } from "../jobs/runner";
import { apiError } from "../lib/errors";
import { logApproval } from "../lib/approvalLog";

const router = Router();
const BUCKET = "lessons";

// approve_segment_bundle / unapprove_segment_bundle are new in migration 029 and not
// yet in database.types — scoped bridge for those two rpc calls; drop after types regen.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// POST /lessons/generate
// Creates a generate_lessons job: queries existing lessons, calls OpenAI,
// inserts new lessons + one segment per lesson.
router.post("/generate", async (req: Request, res: Response): Promise<void> => {
  const { prompt, track_id, topic_id, count } = req.body as {
    prompt?: string;
    track_id?: string;
    topic_id?: string;
    count?: number;
  };

  if (!prompt) {
    apiError(res, 400, "missing_field", "prompt is required");
    return;
  }
  if (!track_id) {
    apiError(res, 400, "missing_field", "track_id is required");
    return;
  }

  try {
    const jobId = await createAndStartJob("generate_lessons", {
      prompt,
      track_id,
      ...(topic_id && { topic_id }),
      ...(count !== undefined && { count }),
      ...(req.user?.id && { created_by: req.user.id }),
    });
    res.status(202).json({ job_id: jobId });
  } catch (err) {
    console.error("Failed to create generate_lessons job:", err);
    apiError(res, 500, "job_create_failed", "Failed to create lesson generation job");
  }
});

// POST /lessons/:id/approve — BULK approve a lesson: content + images + quiz, so all
// three cross the app's gate together (seg_status='complete', sub_segments.image,
// quiz_questions.answer_status='approved'). Fans out to the lesson's segment(s); each
// segment approved atomically via approve_segment_bundle. Images are best-effort (the
// latest candidate per card is approved; a card with no candidate stays imageless);
// content + quiz are all-or-nothing per segment. Refuses a segment with no content.
router.post("/:id/approve", async (req: Request, res: Response): Promise<void> => {
  const lessonId = req.params.id;
  // Actor is the verified JWT user ONLY — the client-supplied approver field is retired.
  const approvedBy = req.user?.id ?? null;

  const { data: segs, error: segErr } = await supabase
    .from("segments").select("id").eq("lesson_id", lessonId);
  if (segErr) { apiError(res, 500, "db_error", segErr.message); return; }
  if (!segs || segs.length === 0) { apiError(res, 404, "no_segments", "lesson has no segments to approve"); return; }

  const results: unknown[] = [];
  for (const seg of segs) {
    const { data: subs } = await supabase.from("sub_segments").select("id").eq("seg_id", seg.id);
    if (!subs || subs.length === 0) {
      apiError(res, 409, "no_content", `segment ${seg.id} has no content cards to approve — generate content first`);
      return;
    }
    // Latest candidate image per card (a card may have several; approve the newest).
    const { data: cands } = await supabase
      .from("content_images")
      .select("id, sub_segment_id, storage_path, created_at")
      .in("sub_segment_id", subs.map((s) => s.id))
      .eq("status", "candidate")
      .neq("storage_path", "pending")
      .order("created_at", { ascending: false });
    const latestBySub = new Map<string, { id: string; storage_path: string }>();
    for (const c of cands ?? []) {
      if (c.sub_segment_id && !latestBySub.has(c.sub_segment_id)) {
        latestBySub.set(c.sub_segment_id, { id: c.id, storage_path: c.storage_path as string });
      }
    }
    const images = [...latestBySub.entries()].map(([subId, c]) => ({
      id: c.id,
      sub_segment_id: subId,   // for the pre-check error only; the bundle fn ignores it
      public_url: supabase.storage.from(BUCKET).getPublicUrl(c.storage_path).data.publicUrl,
      storage_path: c.storage_path,
    }));

    // PRE-CHECK: sub_segments.image FKs to image_assets.url (populated out-of-backend by
    // the storage-upload flow). A candidate whose url isn't there would fail the atomic
    // bundle with a raw FK error and block the WHOLE segment (content + quiz too). Catch
    // it here and return an actionable 409 naming the card(s); approve NOTHING — do not
    // silently approve a card missing the image it was meant to have. Fix = regenerate.
    if (images.length > 0) {
      const { data: assets } = await supabase
        .from("image_assets").select("url").in("url", images.map((i) => i.public_url));
      const present = new Set((assets ?? []).map((a) => a.url));
      const missing = images.filter((i) => !present.has(i.public_url));
      if (missing.length > 0) {
        apiError(res, 409, "image_not_linkable",
          `Cannot approve: ${missing.length} generated image(s) are not linkable (no image_assets row) ` +
          `for card(s) ${missing.map((m) => m.sub_segment_id).join(", ")}. Regenerate those images and try again.`);
        return;
      }
    }

    const { data: r, error } = await db.rpc("approve_segment_bundle", {
      p_seg_id: seg.id, p_approved_by: approvedBy, p_images: images,
    });
    if (error) { apiError(res, 500, "approve_failed", error.message); return; }
    await logApproval("segment", seg.id, "approve", req);
    results.push(r);
  }
  res.json({ ok: true, lesson_id: lessonId, segments: results });
});

// POST /lessons/:id/unapprove — full revert of the bulk approve: content, quiz, and
// images all flip back (seg_status→'pending', answer_status→'pending', approved images→
// 'candidate', sub_segments.image cleared). Nothing is regenerated; fully reversible.
router.post("/:id/unapprove", async (req: Request, res: Response): Promise<void> => {
  const lessonId = req.params.id;
  const { data: segs, error: segErr } = await supabase
    .from("segments").select("id").eq("lesson_id", lessonId);
  if (segErr) { apiError(res, 500, "db_error", segErr.message); return; }
  if (!segs || segs.length === 0) { apiError(res, 404, "no_segments", "lesson has no segments"); return; }

  const results: unknown[] = [];
  for (const seg of segs) {
    const { data: r, error } = await db.rpc("unapprove_segment_bundle", { p_seg_id: seg.id });
    if (error) { apiError(res, 500, "unapprove_failed", error.message); return; }
    await logApproval("segment", seg.id, "unapprove", req);
    results.push(r);
  }
  res.json({ ok: true, lesson_id: lessonId, segments: results });
});

// POST /lessons/:id/publish — flip lessons.is_published=true server-side. Replaces the
// CMS's old Supabase-direct toggle so the publish is ATTRIBUTED (logApproval) and the
// rebuild is hooked. Writes published_by=req.user.id (wiring the previously-unwired
// column), logs the approval, and enqueues a coalesced rebuild. "Publishing ≠ content
// approval" — this only flips the app-facing published flag.
router.post("/:id/publish", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const { data, error } = await supabase
    .from("lessons")
    .update({ is_published: true, published_by: req.user?.id ?? null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data || data.length === 0) { apiError(res, 404, "not_found", "lesson not found"); return; }
  await logApproval("lesson", id, "publish", req);
  void enqueueRebuildAllIfIdle({ reason: "lesson_publish", correlationId: id });
  res.json({ ok: true, lesson_id: id, is_published: true });
});

// POST /lessons/:id/unpublish — flip is_published=false, clear published_by, log, rebuild.
router.post("/:id/unpublish", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const { data, error } = await supabase
    .from("lessons")
    .update({ is_published: false, published_by: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data || data.length === 0) { apiError(res, 404, "not_found", "lesson not found"); return; }
  await logApproval("lesson", id, "unpublish", req);
  void enqueueRebuildAllIfIdle({ reason: "lesson_unpublish", correlationId: id });
  res.json({ ok: true, lesson_id: id, is_published: false });
});

export default router;
