import { supabase } from "../../supabase";
import type { Job } from "../registry";
import { generateSegmentContent } from "./generateSegmentContent";
import { generateQuiz } from "./generateQuiz";
import { recomputeSegStatus } from "../../lib/cardReview";
import {
  contentSkipReason,
  lessonGateFor,
  quizSkipReason,
  tallySkips,
  type LessonGate,
  type SkipReason,
  type TrackGate,
} from "../../lib/approvalSafety";

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
  quizzes?: boolean;        // also generate/replace quizzes; default false
  tone_id: string;          // prompts.id of the segment tone (per-unit content requires it)
  // SLICE A1: `include_approved` is GONE. It was the one way a batch could destroy a human
  // sign-off (and, with it, approved images). POST /jobs refuses it with 400
  // `include_approved_removed` before the job row exists; the handler below refuses it again
  // in case a job row is created another way. Accepted here only so that refusal can be typed.
  include_approved?: never;
};

export type Unit = { type: "content" | "quiz"; seg_id: string; ref: string };

export type BatchResult = {
  status: "running" | "succeeded" | "completed_with_errors";
  total: number;
  done: number;
  failed: number;
  skipped_approved: number;
  // SLICE A1 — every skip, named. `skipped_approved` stays what it was (approved units the
  // sweep left alone) and is now the sum of approved_content + approved_images, so a CMS
  // reading only that field still sees every approval the batch respected.
  skipped_by_reason: Record<SkipReason, number>;
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
  opts: { mode: Mode; quizzes: boolean; batchCreatedAt: string }
): Promise<{ plan: Unit[]; skipped_approved: number; skipped_by_reason: Record<SkipReason, number> }> {
  const { mode, quizzes, batchCreatedAt } = opts;

  // The TRACK's own archival (invariant 6: a lesson is archived if its own archived_at is set
  // OR its track's — archival is DERIVED, never stamped down). An archived track therefore
  // excludes every lesson under it, which the report will say in so many words. But only a
  // HUMAN archival counts: a track the mode switcher put away (mode_archived, migration 128)
  // is simply another mode's catalog and stays buildable — trackExcludedFromBatch owns that
  // rule, and lessonGateFor applies it.
  const { data: track, error: tErr } = await supabase
    .from("tracks").select("archived_at, mode_archived, test_group").eq("id", track_id).maybeSingle();
  if (tErr) throw new Error(`Failed to load track ${track_id}: ${tErr.message}`);
  const trackGate: TrackGate = {
    archived_at: track?.archived_at ?? null,
    mode_archived: track?.mode_archived ?? null,
    test_group: track?.test_group ?? null,
  };

  // tracks <- lessons <- segments. SLICE A1: carry the publish/archive gate down.
  const { data: lessons, error: lErr } = await supabase
    .from("lessons").select("id, is_published, archived_at").eq("track_id", track_id);
  if (lErr) throw new Error(`Failed to load lessons for track ${track_id}: ${lErr.message}`);
  const lessonGate = new Map<string, LessonGate>();
  for (const l of lessons ?? []) {
    lessonGate.set(l.id, lessonGateFor(l, trackGate));
  }
  const lessonIds = [...lessonGate.keys()];

  const segments: { id: string; lesson_id: string; seg_status: string | null }[] = [];
  if (lessonIds.length > 0) {
    const { data: segs, error: sErr } = await supabase
      .from("segments").select("id, lesson_id, seg_status").in("lesson_id", lessonIds);
    if (sErr) throw new Error(`Failed to load segments for track ${track_id}: ${sErr.message}`);
    for (const s of segs ?? []) {
      if (!s.lesson_id) continue;   // an orphan segment has no lesson gate to read; not ours
      segments.push({ id: s.id, lesson_id: s.lesson_id, seg_status: s.seg_status ?? null });
    }
  }
  const segIds = segments.map((s) => s.id);

  // Current content + quiz state per segment. contentLatest/quizLatest hold the MAX
  // created_at — which IS the (re)generation time, because the write path delete+inserts
  // (no updated_at needed; verified). Used for replace-mode resume below.
  const hasContent = new Set<string>();       // segment has >=1 non-empty card
  const contentLatest = new Map<string, string>();
  const quizCount = new Map<string, number>();
  const quizHasUnapproved = new Set<string>();
  const quizLatest = new Map<string, string>();
  // SLICE A1 — segments carrying an APPROVED image. generateSegmentContent purges every
  // card's images before delete+insert (generateSegmentContent.ts:314-318), so a content
  // (re)generation over such a segment destroys an approved picture outright. Never planned.
  const segHasApprovedImage = new Set<string>();
  if (segIds.length > 0) {
    const { data: subs } = await supabase
      .from("sub_segments").select("id, seg_id, content, created_at").in("seg_id", segIds);
    const cardSeg = new Map<string, string>();
    for (const r of subs ?? []) {
      if (!r.seg_id) continue;
      cardSeg.set(r.id, r.seg_id);
      if (!r.content || !r.content.trim()) continue;
      hasContent.add(r.seg_id);
      const prev = contentLatest.get(r.seg_id);
      if (!prev || r.created_at > prev) contentLatest.set(r.seg_id, r.created_at);
    }
    const cardIds = [...cardSeg.keys()];
    if (cardIds.length > 0) {
      const { data: imgs } = await supabase
        .from("content_images").select("sub_segment_id")
        .in("sub_segment_id", cardIds).eq("status", "approved");
      for (const i of imgs ?? []) {
        const seg = i.sub_segment_id ? cardSeg.get(i.sub_segment_id) : undefined;
        if (seg) segHasApprovedImage.add(seg);
      }
    }
    if (quizzes) {
      const { data: qs } = await supabase.from("quiz_questions").select("segment_id, answer_status, created_at").in("segment_id", segIds);
      for (const q of qs ?? []) {
        if (!q.segment_id) continue;
        quizCount.set(q.segment_id, (quizCount.get(q.segment_id) ?? 0) + 1);
        if (q.answer_status !== "approved") quizHasUnapproved.add(q.segment_id);
        const prev = quizLatest.get(q.segment_id);
        if (!prev || q.created_at > prev) quizLatest.set(q.segment_id, q.created_at);
      }
    }
  }

  // REPLACE-MODE RESUME (derived, no new state): a replace killed mid-run must not
  // redo units the dead run already regenerated (duplicate spend + mixed vintage). The
  // cutoff is the start of the current failed/running batch lineage for this track
  // (since the last success) — units whose content/quiz was (re)generated at-or-after
  // the cutoff are skipped as already-done. Fresh replace -> cutoff = now, skips nothing.
  const cutoff = mode === "replace" ? await resumeCutoff(track_id, batchCreatedAt) : null;
  const regeneratedSince = (m: Map<string, string>, segId: string) => {
    const t = m.get(segId);
    return !!cutoff && !!t && t >= cutoff;
  };

  // Build the plan. Every decision is in src/lib/approvalSafety.ts (unit-tested); this loop
  // only supplies the facts. There is no include_approved escape any more — the route refuses
  // it with 400 before the job row exists (src/lib/jobPreconditions.ts).
  const plan: Unit[] = [];
  const reasons: (SkipReason | null)[] = [];
  const OPEN: LessonGate = { published: false, archived: false };
  for (const seg of segments) {
    const lesson = lessonGate.get(seg.lesson_id) ?? OPEN;
    // seg_status is a two-state model in this DB: 'complete' = approved (regen resets to
    // 'pending'). Accept a future 'approved' too. This is the "human-approved" gate.
    const content_approved = seg.seg_status === "complete" || seg.seg_status === "approved";

    const c = contentSkipReason(
      {
        seg_id: seg.id,
        lesson,
        has_content: hasContent.has(seg.id),
        content_approved,
        has_approved_image: segHasApprovedImage.has(seg.id),
        regenerated_since_cutoff: regeneratedSince(contentLatest, seg.id),
      },
      mode
    );
    if (c.plan) plan.push({ type: "content", seg_id: seg.id, ref: `content:${seg.id}` });
    reasons.push(c.skip);

    if (quizzes) {
      const count = quizCount.get(seg.id) ?? 0;
      const q = quizSkipReason(
        {
          seg_id: seg.id,
          lesson,
          question_count: count,
          quiz_approved: count > 0 && !quizHasUnapproved.has(seg.id),
          regenerated_since_cutoff: regeneratedSince(quizLatest, seg.id),
        },
        mode
      );
      if (q.plan) plan.push({ type: "quiz", seg_id: seg.id, ref: `quiz:${seg.id}` });
      reasons.push(q.skip);
    }
  }
  const skipped_by_reason = tallySkips(reasons);
  return {
    plan,
    skipped_approved: skipped_by_reason.approved_content + skipped_by_reason.approved_images,
    skipped_by_reason,
  };
}

// The resume cutoff for a replace re-fire: the created_at of the EARLIEST failed/running
// generate_track_content batch for this track since the last succeeded one (the start of
// the current resume lineage). Derived from the jobs table — no new state. If there is no
// such prior run, the cutoff is this batch's own created_at (a fresh replace skips nothing).
async function resumeCutoff(track_id: string, batchCreatedAt: string): Promise<string> {
  const { data: priors } = await supabase
    .from("jobs")
    .select("created_at, status, input")
    .eq("type", "generate_track_content")
    .lt("created_at", batchCreatedAt)
    .order("created_at", { ascending: false });
  let cutoff = batchCreatedAt;
  for (const r of priors ?? []) {
    if ((r.input as { track_id?: string } | null)?.track_id !== track_id) continue;
    if (r.status === "succeeded") break;   // everything before the last success is a done lineage
    cutoff = r.created_at;                  // failed/running → push the cutoff earlier
  }
  return cutoff;
}

// One unit's work. tone_id feeds content units; quiz units use the single active quiz
// prompt. Throws on failure (the executor records it and continues).
export type RunUnit = (unit: Unit, tone_id: string, correlationId: string) => Promise<void>;

// Content units opt in to the activity rule exactly like the generate_segment_content job: an activity gets the
// activity_v1 structure block, a lesson its tone's default (src/lib/structureChoice.ts; api-contract §2b, §2f).
export const TRACK_CONTENT_GENERATE_OPTS = { activityStructure: true } as const;

export type RunUnitDeps = {
  generate: typeof generateSegmentContent;
  recompute: typeof recomputeSegStatus;
  quiz: typeof generateQuiz;
};

// Built from injected deps so the wiring is unit-tested (src/jobs/handlers/__tests__/generateTrackContent.test.ts).
export function makeRunUnit(deps: RunUnitDeps): RunUnit {
  return async (unit, tone_id, correlationId) => {
    if (unit.type === "content") {
      await deps.generate({ seg_id: unit.seg_id, tone_id, generate_quiz: false, correlationId }, TRACK_CONTENT_GENERATE_OPTS);
      // Freshly-(re)generated cards default to review_state='draft' (migration 056); recompute
      // derives seg_status='pending' so an include_approved regen can never stay approved.
      // seg_status is never written directly.
      await deps.recompute(unit.seg_id);
    } else {
      await deps.quiz({ seg_id: unit.seg_id, correlationId, isRegen: true });
    }
  };
}

const realRunUnit: RunUnit = makeRunUnit({ generate: generateSegmentContent, recompute: recomputeSegStatus, quiz: generateQuiz });

// Execute a plan with bounded concurrency, writing live progress into jobs.result.
// One unit failing is recorded, never fatal. runUnit is injectable so proofs can drive
// orchestration (progress shape, resume, poisoned unit) without the LLM. Returns the
// final result (the runner then persists it + flips jobs.status).
export async function executeTrackContent(
  jobId: string, plan: Unit[],
  skips: { skipped_approved: number; skipped_by_reason: Record<SkipReason, number> },
  tone_id: string,
  runUnit: RunUnit = realRunUnit
): Promise<BatchResult> {
  const result: BatchResult = {
    status: "running", total: plan.length, done: 0, failed: 0,
    skipped_approved: skips.skipped_approved,
    skipped_by_reason: skips.skipped_by_reason,
    current_unit: null, errors: [],
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
  const { track_id, mode = "fill_missing", quizzes = false, tone_id } = job.input as Input;
  if (!track_id) throw new Error("input.track_id is required");
  if (!tone_id)  throw new Error("input.tone_id is required");
  if (mode !== "fill_missing" && mode !== "replace") {
    throw new Error(`input.mode must be 'fill_missing' | 'replace' (got "${mode}")`);
  }
  // Second line of defence behind the route's 400 (slice A1): fail the job loudly rather than
  // silently ignoring a flag whose whole purpose was to override approvals.
  if ((job.input as Record<string, unknown>).include_approved) {
    throw new Error(
      "input.include_approved was removed (slice A1): a batch never overwrites approved content " +
      "or approved images. Unapprove the segments you really mean to replace."
    );
  }
  const { plan, skipped_approved, skipped_by_reason } =
    await planTrackContent(track_id, { mode, quizzes, batchCreatedAt: job.created_at });
  return executeTrackContent(job.id, plan, { skipped_approved, skipped_by_reason }, tone_id);
}
