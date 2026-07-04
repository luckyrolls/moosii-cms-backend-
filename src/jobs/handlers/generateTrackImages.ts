import { supabase } from "../../supabase";
import type { Job } from "../registry";
import { generateSubSegmentImage } from "./generateSubSegmentImage";

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
  current_unit: string | null;
  errors: { unit: string; message: string }[];
};

const CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY ?? "2", 10);

// Pure enumeration from the content/image tables (the resume checkpoint). Exported so
// proofs can assert the plan without generating images.
export async function planTrackImages(
  track_id: string
): Promise<{ plan: ImageUnit[]; skipped_no_content: number }> {
  // tracks ← lessons ← segments ← sub_segments
  const { data: lessons, error: lErr } = await supabase
    .from("lessons").select("id").eq("track_id", track_id);
  if (lErr) throw new Error(`Failed to load lessons for track ${track_id}: ${lErr.message}`);
  const lessonIds = (lessons ?? []).map((l) => l.id);
  if (lessonIds.length === 0) return { plan: [], skipped_no_content: 0 };

  const { data: segs, error: sErr } = await supabase
    .from("segments").select("id").in("lesson_id", lessonIds);
  if (sErr) throw new Error(`Failed to load segments for track ${track_id}: ${sErr.message}`);
  const segIds = (segs ?? []).map((s) => s.id);
  if (segIds.length === 0) return { plan: [], skipped_no_content: 0 };

  const { data: subs, error: ssErr } = await supabase
    .from("sub_segments").select("id, seg_id, content").in("seg_id", segIds);
  if (ssErr) throw new Error(`Failed to load sub_segments for track ${track_id}: ${ssErr.message}`);
  const subSegs = (subs ?? []).filter((r) => r.id && r.seg_id) as { id: string; seg_id: string; content: string | null }[];
  if (subSegs.length === 0) return { plan: [], skipped_no_content: 0 };

  // Segment-level content presence (≥1 non-empty card in the segment).
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

  const plan: ImageUnit[] = [];
  let skipped_no_content = 0;
  for (const ss of subSegs) {
    if (imaged.has(ss.id)) continue;                 // has image → skip (regen is per-image)
    if (segHasContent.has(ss.seg_id)) plan.push({ sub_segment_id: ss.id, ref: `image:${ss.id}` });
    else skipped_no_content++;                        // no image, no content → run content first
  }
  return { plan, skipped_no_content };
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
  jobId: string, plan: ImageUnit[], skipped_no_content: number,
  runUnit: ImageRunUnit = realRunUnit
): Promise<BatchResult> {
  const result: BatchResult = {
    status: "running", total: plan.length, done: 0, failed: 0,
    skipped_no_content, current_unit: null, errors: [],
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
  const { plan, skipped_no_content } = await planTrackImages(track_id);
  return executeTrackImages(job.id, plan, skipped_no_content);
}
