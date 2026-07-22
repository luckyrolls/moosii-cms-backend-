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

// POST /lessons/coverage-accept — accept selected track-coverage-audit proposals as lesson
// STUBS. Sync (just an insert, no LLM). Per-proposal: the CMS sends only the picked
// proposals (they're ephemeral — held in the audit job's result). Resolves each topic
// name -> id and FAILS LOUD on any miss (identical to generate_lessons), then inserts via
// the SAME atomic create_lessons_with_segments RPC — so accepted stubs are byte-identical
// to ideation-created stubs (unpublished, un-approved, one segment each). The RPC PERSISTS
// band_rationale + safety_sensitive (added in migration 011) and curator_note (044); this
// handler forwards all three from each proposal so an accepted safety-sensitive lesson lands
// flagged (the old "RPC drops them" note was pre-011 folklore). coverage_rationale/fills_gap
// stay display-only (never sent). NOTE: the CMS acceptPayload currently sends only the 6-field
// subset — until it forwards safety_sensitive/band_rationale too, accepts THROUGH the CMS still
// default those; direct callers (import) that send the full proposal get them persisted.
router.post("/coverage-accept", async (req: Request, res: Response): Promise<void> => {
  const { track_id, proposals } = req.body as {
    track_id?: string;
    proposals?: Array<{
      lesson_name: string; description: string;
      min_child_age: number; max_child_age: number; topic: string; priority: number;
      // Persisted columns the model emits on each proposal (create_lessons_with_segments
      // has carried these since 011). Optional so a caller still sending the old 6-field
      // subset keeps working: absent safety_sensitive coalesces false, absent band_rationale
      // inserts NULL. curator_note is human-supplied provenance (011/044) — absent = NULL.
      safety_sensitive?: boolean; band_rationale?: string; curator_note?: string;
    }>;
  };
  if (!track_id) { apiError(res, 400, "missing_field", "track_id is required"); return; }
  if (!Array.isArray(proposals) || proposals.length === 0) {
    apiError(res, 400, "missing_field", "proposals (non-empty array) is required"); return;
  }

  // Topic allow-set for name -> id resolution (identical to generate_lessons Step 8).
  const { data: topics, error: topicsErr } = await supabase.from("topics").select("id, name");
  if (topicsErr || !topics) { apiError(res, 500, "db_error", topicsErr?.message ?? "failed to load topics"); return; }
  const normalize = (s: string) => (s ?? "").trim().toLowerCase();
  const topicIdByName = new Map(topics.map((t) => [normalize(t.name ?? ""), t.id]));

  const unresolved: string[] = [];
  const rows = proposals.map((p) => {
    const topic_id = topicIdByName.get(normalize(p.topic));
    if (!topic_id) unresolved.push(`"${p.lesson_name}" → topic "${p.topic}"`);
    return {
      lesson_name: p.lesson_name,
      description: p.description,
      min_child_age: p.min_child_age,
      max_child_age: p.max_child_age,
      priority: p.priority,
      track_id,
      topic_id,
      // Forward the model's flags so an accepted proposal lands byte-identical to
      // ideation. safety_sensitive is passed as-is (including false); undefined →
      // dropped → RPC coalesces false. band_rationale undefined → dropped → NULL.
      safety_sensitive: p.safety_sensitive,
      band_rationale: p.band_rationale,
      ...(p.curator_note ? { curator_note: p.curator_note } : {}),
      ...(req.user?.id && { created_by: req.user.id }),
    };
  });
  if (unresolved.length > 0) {
    apiError(res, 422, "unresolved_topic",
      `Proposal(s) with a topic outside the allowed set: ${unresolved.join("; ")}. ` +
      `Allowed: ${topics.map((t) => t.name).join(", ")}. Nothing inserted.`);
    return;
  }

  // Same atomic tail as ideation — lessons (with the model's flags) + one segment each.
  const { data: created, error: rpcErr } = await db.rpc("create_lessons_with_segments", { p_lessons: rows });
  if (rpcErr || !created) { apiError(res, 500, "insert_failed", rpcErr?.message ?? "insert failed"); return; }
  res.json({ ok: true, track_id, lessons_created: (created as unknown[]).length, lessons: created });
});

export default router;
