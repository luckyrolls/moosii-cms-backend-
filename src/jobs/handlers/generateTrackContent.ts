import { supabase } from "../../supabase";
import type { Job } from "../registry";
import { generateSegmentContent } from "./generateSegmentContent";
import { generateQuiz } from "./generateQuiz";

// ---------------------------------------------------------------------------
// generate_track_content — ORCHESTRATOR over the existing per-unit generators.
// Given a track, fan out content (+ optional quiz) generation across all its
// lessons/segments. No new generation logic: each unit calls the extracted core
// (generateSegmentContent / generateQuiz) with the BATCH's correlationId (= job.id)
// so a whole run is one provenance thread in ai_generation_log.
//
// SURVIVAL: no per-unit state table. The CONTENT tables are the resume checkpoint —
// a killed batch (reaper marks it failed after 10min, last progress snapshot kept in
// jobs.result) is completed by re-running fill_missing, which re-derives remaining
// work from what content now exists. One source of truth, no reconcile.
//
// One unit failing NEVER fails the batch: record in errors[], continue. jobs.status
// stays succeeded/failed (CHECK constraint); the succeeded-vs-completed_with_errors
// distinction lives in result.status.
// ---------------------------------------------------------------------------

export type Mode = "fill_missing" | "replace";
type Input = {
  track_id: string;
  mode?: Mode;              // default 'fill_missing' (also the resume mode)
  include_approved?: boolean; // replace-only, destructive override; default false
  quizzes?: boolean;        // also generate/replace quizzes; default false
  tone_id: string;          // prompts.id of the segment tone (per-unit content requires it)
};

export type Unit = { type: "content" | "quiz"; seg_id: string; ref: string };

export type BatchResult = {
  status: "running" | "succeeded" | "completed_with_errors";
  total: number;
  done: number;
  failed: number;
  skipped_approved: number;
  current_unit: string | null;
  errors: { unit: string; message: string }[];
};

const CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY ?? "2", 10);

// Enumerate the work plan for a track+mode from the CONTENT tables (the resume
// checkpoint). Pure read — no generation. Exported so the DoD proofs can assert the
// plan directly without firing the LLM, and so re-planning after partial completion
// (the resume story) is inspectable.
export async function planTrackContent(
  track_id: string,
  opts: { mode: Mode; quizzes: boolean; include_approved: boolean }
): Promise<{ plan: Unit[]; skipped_approved: number }> {
  const { mode, quizzes, include_approved } = opts;

  // tracks ← lessons ← segments
  const { data: lessons, error: lErr } = await supabase
    .from("lessons").select("id").eq("track_id", track_id);
  if (lErr) throw new Error(`Failed to load lessons for track ${track_id}: ${lErr.message}`);
  const lessonIds = (lessons ?? []).map((l) => l.id);

  const segments: { id: string; seg_status: string | null }[] = [];
  if (lessonIds.length > 0) {
    const { data: segs, error: sErr } = await supabase
      .from("segments").select("id, seg_status").in("lesson_id", lessonIds);
    if (sErr) throw new Error(`Failed to load segments for track ${track_id}: ${sErr.message}`);
    for (const s of segs ?? []) segments.push({ id: s.id, seg_status: s.seg_status ?? null });
  }
  const segIds = segments.map((s) => s.id);

  // Current content + quiz state per segment.
  const hasContent = new Set<string>();       // segment has ≥1 non-empty card
  const quizCount = new Map<string, number>();
  const quizHasUnapproved = new Set<string>();
  if (segIds.length > 0) {
    const { data: subs } = await supabase.from("sub_segments").select("seg_id, content").in("seg_id", segIds);
    for (const r of subs ?? []) if (r.seg_id && r.content && r.content.trim()) hasContent.add(r.seg_id);

    if (quizzes) {
      const { data: qs } = await supabase.from("quiz_questions").select("segment_id, answer_status").in("segment_id", segIds);
      for (const q of qs ?? []) {
        if (!q.segment_id) continue;
        quizCount.set(q.segment_id, (quizCount.get(q.segment_id) ?? 0) + 1);
        if (q.answer_status !== "approved") quizHasUnapproved.add(q.segment_id);
      }
    }
  }

  // Build the plan. skipped_approved accrues only in replace (approved units the sweep
  // leaves alone); fill_missing skips present content because it's present, not approved.
  const plan: Unit[] = [];
  let skipped_approved = 0;
  for (const seg of segments) {
    // seg_status is a two-state model in this DB: 'complete' = approved (regen resets to
    // 'pending'). Accept a future 'approved' too. This is the "human-approved" gate.
    const contentApproved = seg.seg_status === "complete" || seg.seg_status === "approved";
    if (mode === "fill_missing") {
      if (!hasContent.has(seg.id)) plan.push({ type: "content", seg_id: seg.id, ref: `content:${seg.id}` });
    } else {
      if (contentApproved && !include_approved) skipped_approved++;
      else plan.push({ type: "content", seg_id: seg.id, ref: `content:${seg.id}` });
    }

    if (quizzes) {
      const count = quizCount.get(seg.id) ?? 0;
      const quizApproved = count > 0 && !quizHasUnapproved.has(seg.id);
      if (mode === "fill_missing") {
        if (count === 0) plan.push({ type: "quiz", seg_id: seg.id, ref: `quiz:${seg.id}` });
      } else {
        if (quizApproved && !include_approved) skipped_approved++;
        else plan.push({ type: "quiz", seg_id: seg.id, ref: `quiz:${seg.id}` });
      }
    }
  }
  return { plan, skipped_approved };
}

// One unit's work. tone_id feeds content units; quiz units use the single active quiz
// prompt. Throws on failure (the executor records it and continues).
export type RunUnit = (unit: Unit, tone_id: string, correlationId: string) => Promise<void>;

const realRunUnit: RunUnit = async (unit, tone_id, correlationId) => {
  if (unit.type === "content") {
    await generateSegmentContent({ seg_id: unit.seg_id, tone_id, generate_quiz: false, correlationId });
    // Regenerated content is unapproved — reset (mirrors regenSegmentContent) so an
    // include_approved regen can never remain marked approved.
    await supabase.from("segments").update({ seg_status: "pending", approved_by: null }).eq("id", unit.seg_id);
  } else {
    await generateQuiz({ seg_id: unit.seg_id, correlationId, isRegen: true });
  }
};

// Execute a plan with bounded concurrency, writing live progress into jobs.result.
// One unit failing is recorded, never fatal. runUnit is injectable so proofs can drive
// orchestration (progress shape, resume, poisoned unit) without the LLM. Returns the
// final result (the runner then persists it + flips jobs.status).
export async function executeTrackContent(
  jobId: string, plan: Unit[], skipped_approved: number, tone_id: string,
  runUnit: RunUnit = realRunUnit
): Promise<BatchResult> {
  const result: BatchResult = {
    status: "running", total: plan.length, done: 0, failed: 0,
    skipped_approved, current_unit: null, errors: [],
  };
  // Mutations are safe between awaits (single-threaded). Live progress for CMS polling.
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
        await runUnit(unit, tone_id, jobId);
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

export async function generateTrackContentHandler(job: Job): Promise<unknown> {
  const { track_id, mode = "fill_missing", include_approved = false, quizzes = false, tone_id } =
    job.input as Input;
  if (!track_id) throw new Error("input.track_id is required");
  if (!tone_id)  throw new Error("input.tone_id is required");
  if (mode !== "fill_missing" && mode !== "replace") {
    throw new Error(`input.mode must be 'fill_missing' | 'replace' (got "${mode}")`);
  }
  const { plan, skipped_approved } = await planTrackContent(track_id, { mode, quizzes, include_approved });
  return executeTrackContent(job.id, plan, skipped_approved, tone_id);
}
