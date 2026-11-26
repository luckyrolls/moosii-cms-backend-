import { supabase } from "../../supabase";
import type { Job } from "../registry";
import { generateSubSegmentImage } from "./generateSubSegmentImage";
import {
  imageSkipReason,
  lessonGateFor,
  tallySkips,
  type LessonGate,
  type SkipReason,
  type TrackGate,
} from "../../lib/approvalSafety";

// ---------------------------------------------------------------------------
// generate_track_images — FILL-MISSING fan-out over the single-unit image job.
// Sibling of generate_track_content (same orchestration), but simpler: fill only,
// NO replace mode. Image regeneration stays per-image (the rejection/regen flow);
// this batch only creates images that don't exist yet.
//
// A "slot" = a sub_segment (images attach to sub_segments). Per slot:
//   has_image  = a content_images row with status IN ('candidate','approved') — the
//                existing image-batch 'gaps' definition (reuse; rejected/superseded do
//                NOT count as present, they are gaps to fill). ANY present image → skip.
//   has_content = the parent SEGMENT has ≥1 non-empty sub_segment (content PRESENT,
//                approval NOT required — same predicate as the content batch's has-it;
//                images generate against pending content).
// Plan = slots with NO image AND content present. Slots with no image and NO content
// are NOT planned and counted skipped_no_content — the first-class "run/fix content
// generation first" signal.
//
// SURVIVAL: fill-missing is fully derivable (image-exists is the state) — a killed
// batch is finished by re-firing; re-plan skips created images. No replace hole here.
// Concurrency: the existing image-batch knob (BATCH_CONCURRENCY, default 2); images are
// the most expensive unit — keep the posture, don't raise. Provenance: every unit runs
// with correlationId = parent job.id (whole run = one query; content_images.job_id too).
// ---------------------------------------------------------------------------

type Input = { track_id: string };
export type ImageUnit = { sub_segment_id: string; ref: string };

export type BatchResult = {
  status: "running" | "succeeded" | "completed_with_errors";
  total: number;
  done: number;
  failed: number;
  skipped_no_content: number;
  // SLICE A1 — every skip, named (published / archived / no_content). `skipped_no_content`
  // keeps its old meaning and is the same number as skipped_by_reason.no_content.
  skipped_by_reason: Record<SkipReason, number>;
  current_unit: string | null;
  errors: { unit: string; message: string }[];
};

const CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY ?? "2", 10);

// Pure enumeration from the content/image tables (the resume checkpoint). Exported so
// proofs can assert the plan without generating images.
export async function planTrackImages(
  track_id: string
): Promise<{ plan: ImageUnit[]; skipped_no_content: number; skipped_by_reason: Record<SkipReason, number> }> {
  const empty = { plan: [], skipped_no_content: 0, skipped_by_reason: tallySkips([]) };

  // The track's own archival (invariant 6 — archival is DERIVED, so an archived track
  // archives every lesson under it) — but only a HUMAN archival excludes it from a batch. A
  // mode-hidden track (mode_archived, 128) is another mode's catalog and stays eligible:
  // trackExcludedFromBatch, applied by lessonGateFor.
  const { data: track, error: tErr } = await supabase
    .from("tracks").select("archived_at, mode_archived, test_group").eq("id", track_id).maybeSingle();
  if (tErr) throw new Error(`Failed to load track ${track_id}: ${tErr.message}`);
  const trackGate: TrackGate = {
    archived_at: track?.archived_at ?? null,
    mode_archived: track?.mode_archived ?? null,
    test_group: track?.test_group ?? null,
  };

  // tracks <- lessons <- segments <- sub_segments. SLICE A1: carry the lesson gate down, so a
  // batch never adds pictures to a PUBLISHED or ARCHIVED lesson.
  const { data: lessons, error: lErr } = await supabase
    .from("lessons").select("id, is_published, archived_at").eq("track_id", track_id);
  if (lErr) throw new Error(`Failed to load lessons for track ${track_id}: ${lErr.message}`);
  const lessonGate = new Map<string, LessonGate>();
  for (const l of lessons ?? []) {
    lessonGate.set(l.id, lessonGateFor(l, trackGate));
  }
  const lessonIds = [...lessonGate.keys()];
  if (lessonIds.length === 0) return empty;

  const { data: segs, error: sErr } = await supabase
    .from("segments").select("id, lesson_id").in("lesson_id", lessonIds);
  if (sErr) throw new Error(`Failed to load segments for track ${track_id}: ${sErr.message}`);
  const segLesson = new Map<string, string>();
  for (const s of segs ?? []) if (s.lesson_id) segLesson.set(s.id, s.lesson_id);
  const segIds = [...segLesson.keys()];
  if (segIds.length === 0) return empty;

  const { data: subs, error: ssErr } = await supabase
    .from("sub_segments").select("id, seg_id, content").in("seg_id", segIds);
  if (ssErr) throw new Error(`Failed to load sub_segments for track ${track_id}: ${ssErr.message}`);
  const subSegs = (subs ?? []).filter((r) => r.id && r.seg_id) as { id: string; seg_id: string; content: string | null }[];
  if (subSegs.length === 0) return empty;

  // Segment-level content presence (>=1 non-empty card in the segment).
  const segHasContent = new Set<string>();
  for (const r of subSegs) if (r.content && r.content.trim()) segHasContent.add(r.seg_id);

  // Present images (reuse the 'gaps' definition: candidate|approved).
  const imaged = new Set<string>();
  const { data: imgs } = await supabase
    .from("content_images")
    .select("sub_segment_id")
    .in("sub_segment_id", subSegs.map((s) => s.id))
    .in("status", ["candidate", "approved"]);
  for (const r of imgs ?? []) if (r.sub_segment_id) imaged.add(r.sub_segment_id);

  const OPEN: LessonGate = { published: false, archived: false };
  const plan: ImageUnit[] = [];
  const reasons: (SkipReason | null)[] = [];
  for (const ss of subSegs) {
    const lessonId = segLesson.get(ss.seg_id);
    const d = imageSkipReason({
      sub_segment_id: ss.id,
      lesson: (lessonId && lessonGate.get(lessonId)) || OPEN,
      has_image: imaged.has(ss.id),
      segment_has_content: segHasContent.has(ss.seg_id),
    });
    if (d.plan) plan.push({ sub_segment_id: ss.id, ref: `image:${ss.id}` });
    reasons.push(d.skip);
  }
  const skipped_by_reason = tallySkips(reasons);
  return { plan, skipped_no_content: skipped_by_reason.no_content, skipped_by_reason };
}

export type ImageRunUnit = (unit: ImageUnit, correlationId: string) => Promise<void>;

const realRunUnit: ImageRunUnit = async (unit, correlationId) => {
  // correlationId = the batch job.id; also the content_images.job_id (CMS join).
  await generateSubSegmentImage({ sub_segment_id: unit.sub_segment_id }, { correlationId, jobId: correlationId });
};

// Bounded-concurrency execution with live progress into jobs.result. One unit failing
// is recorded, never fatal. runUnit is injectable so proofs drive orchestration without
// generating images.
export async function executeTrackImages(
  jobId: string, plan: ImageUnit[],
  skips: { skipped_no_content: number; skipped_by_reason: Record<SkipReason, number> },
  runUnit: ImageRunUnit = realRunUnit
): Promise<BatchResult> {
  const result: BatchResult = {
    status: "running", total: plan.length, done: 0, failed: 0,
    skipped_no_content: skips.skipped_no_content,
    skipped_by_reason: skips.skipped_by_reason,
    current_unit: null, errors: [],
  };
  const writeProgress = async () => {
    await supabase.from("jobs").update({ result: { ...result } as never }).eq("id", jobId);
  };
  await writeProgress();

  const queue = [...plan];
  const worker = async () => {
    for (;;) {
      const unit = queue.shift();
      if (!unit) return;
      result.current_unit = unit.ref;
      await writeProgress();
      try {
        await runUnit(unit, jobId);
        result.done++;
      } catch (e) {
        result.failed++;
        result.errors.push({ unit: unit.ref, message: e instanceof Error ? e.message : String(e) });
      }
      await writeProgress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, worker));

  result.current_unit = null;
  result.status = result.failed > 0 ? "completed_with_errors" : "succeeded";
  await writeProgress();
  return result;
}

export async function generateTrackImagesHandler(job: Job): Promise<unknown> {
  const { track_id } = job.input as Input;
  if (!track_id) throw new Error("input.track_id is required");
  const { plan, skipped_no_content, skipped_by_reason } = await planTrackImages(track_id);
  return executeTrackImages(job.id, plan, { skipped_no_content, skipped_by_reason });
}
