import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { planTrackContent, type Mode } from "../jobs/handlers/generateTrackContent";
import { planTrackImages } from "../jobs/handlers/generateTrackImages";
import { trackExcludedFromBatch } from "../lib/approvalSafety";
import { buildPerLesson, tallyPerLesson, type PlannedUnit } from "../lib/batchReport";
import { loadEstimateBasis, estimateFor } from "../lib/batchEstimate";

// ---------------------------------------------------------------------------
// GET /tracks/:id/plan-preview — slice A2. A DRY RUN of both batches: what each WOULD do,
// what it would refuse and why, and what it would cost in calls and tokens. Generates
// nothing, writes nothing, creates no job row.
//
// It calls the SAME planners the jobs call (planTrackContent / planTrackImages, both already
// pure reads), so the preview cannot disagree with the run. That is the whole design: a
// second implementation of "what would happen" would drift from the first within a slice.
//
// Shaped for a confirm dialog: `per_lesson` renders as a table (one row per lesson the plan
// touched or refused, with planned units split content / quiz / image), the two batch
// sections carry the totals and skip reasons, and `images.editorial` is the N-of-M warning.
// ---------------------------------------------------------------------------

export const trackBuildoutRouter = Router();

// ── the pure layer: query parsing, so it can be tested without a round trip ──────────────
// Exported and unit-tested (src/routes/__tests__/trackBuildout.test.ts): a reachable database
// is not needed to prove that `mode=replace_all` is refused.

const asBool = (v: unknown): boolean | null => {
  if (v === undefined || v === null || v === "") return null;
  if (v === "true" || v === true || v === "1") return true;
  if (v === "false" || v === false || v === "0") return false;
  return null;
};

export type PreviewQuery = {
  mode: Mode;
  quizzes: boolean;
  only_editorially_approved: boolean;
  window_days: number;
};

export type ParseResult =
  | { ok: true; query: PreviewQuery }
  | { ok: false; code: string; message: string };

export function parsePreviewQuery(q: Record<string, unknown>): ParseResult {
  const m = (q.mode as string | undefined) ?? "fill_missing";
  if (m !== "fill_missing" && m !== "replace") {
    return { ok: false, code: "bad_mode", message: "mode must be 'fill_missing' or 'replace'." };
  }

  const qz = asBool(q.quizzes);
  if (q.quizzes !== undefined && qz === null) {
    return { ok: false, code: "bad_request", message: "quizzes must be true or false." };
  }

  const ed = asBool(q.only_editorially_approved);
  if (q.only_editorially_approved !== undefined && ed === null) {
    return {
      ok: false,
      code: "bad_request",
      message: "only_editorially_approved must be true or false.",
    };
  }

  const days = Number(q.window_days ?? 90);
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    return {
      ok: false,
      code: "bad_request",
      message: "window_days must be a number between 1 and 3650.",
    };
  }

  return {
    ok: true,
    query: { mode: m, quizzes: qz === true, only_editorially_approved: ed === true, window_days: days },
  };
}

trackBuildoutRouter.get("/:id/plan-preview", async (req: Request, res: Response): Promise<void> => {
  const track_id = req.params.id;

  const parsed = parsePreviewQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    apiError(res, 400, parsed.code, parsed.message);
    return;
  }
  const { mode, quizzes, only_editorially_approved: onlyEditorial, window_days: windowDays } =
    parsed.query;

  const { data: track, error: tErr } = await supabase
    .from("tracks")
    .select("id, track_name, archived_at, mode_archived, test_group")
    .eq("id", track_id)
    .maybeSingle();
  if (tErr) {
    apiError(res, 500, "db_error", `Failed to load track: ${tErr.message}`);
    return;
  }
  if (!track) {
    apiError(res, 404, "not_found", "No such track.");
    return;
  }

  // The preview is a dry run of the jobs, so it is PLANNED EXACTLY AS THEY WOULD BE — the
  // batch's own created_at stands in for the resume cutoff (a fresh replace skips nothing).
  const batchCreatedAt = new Date().toISOString();
  let content, images;
  try {
    [content, images] = await Promise.all([
      planTrackContent(track_id, { mode, quizzes, batchCreatedAt }),
      planTrackImages(track_id, { onlyEditoriallyApproved: onlyEditorial }),
    ]);
  } catch (e) {
    apiError(res, 500, "plan_failed", e instanceof Error ? e.message : String(e));
    return;
  }

  const contentUnits: PlannedUnit[] = content.plan.map((u) => ({
    kind: u.type, ref: u.ref, lesson_id: u.lesson_id,
  }));
  const imageUnits: PlannedUnit[] = images.plan.map((u) => ({
    kind: "image" as const, ref: u.ref, lesson_id: u.lesson_id,
  }));

  // ONE merged table: both batches' units against the same lesson rows. A lesson excluded
  // from both appears once, with the refusal counted per refused unit — which is the truth
  // (an excluded lesson costs the content batch and the image batch one skip each).
  const per_lesson = buildPerLesson({
    lessons: images.lessons.length > 0 ? images.lessons : content.lessons,
    planned: [...contentUnits, ...imageUnits],
    skipped: [...content.skipped, ...images.skipped],
  });

  const contentTally = tallyPerLesson(
    buildPerLesson({ lessons: content.lessons, planned: contentUnits, skipped: content.skipped })
  );
  const imageTally = tallyPerLesson(
    buildPerLesson({ lessons: images.lessons, planned: imageUnits, skipped: images.skipped })
  );

  const basis = await loadEstimateBasis(windowDays);
  const counts = {
    content: contentTally.planned_by_kind.content,
    quiz: contentTally.planned_by_kind.quiz,
    image: imageTally.planned_by_kind.image,
  };

  res.json({
    track: {
      id: track.id,
      track_name: track.track_name,
      test_group: track.test_group,
      archived_at: track.archived_at,
      mode_archived: track.mode_archived,
      // A1: legacy or a human archival puts the whole track out of every batch. A track
      // hidden only by the current catalog mode is NOT excluded.
      excluded_from_batches: trackExcludedFromBatch({
        archived_at: track.archived_at,
        mode_archived: track.mode_archived,
        test_group: track.test_group,
      }),
    },
    content: {
      mode,
      quizzes,
      planned: {
        content: contentTally.planned_by_kind.content,
        quiz: contentTally.planned_by_kind.quiz,
        total: contentTally.planned,
      },
      skipped_by_reason: content.skipped_by_reason,
      skipped_total: contentTally.skipped_total,
      skipped_approved: content.skipped_approved,
    },
    images: {
      only_editorially_approved: onlyEditorial,
      planned: { image: imageTally.planned_by_kind.image, total: imageTally.planned },
      skipped_by_reason: images.skipped_by_reason,
      skipped_total: imageTally.skipped_total,
      // The CMS warning, N of M: lessons with cards still awaiting editorial, out of the
      // lessons this batch would otherwise consider.
      editorial: images.editorial,
    },
    per_lesson,
    estimates: {
      // The two batches are separate runs (no chaining), so each is estimated on its own and
      // `combined` is simply both — useful when a build-out is planned as a pair.
      content: estimateFor({ content: counts.content, quiz: counts.quiz, image: 0 }, basis),
      images: estimateFor({ content: 0, quiz: 0, image: counts.image }, basis),
      combined: estimateFor(counts, basis),
      basis,
    },
    generated_at: new Date().toISOString(),
  });
});

export default trackBuildoutRouter;
