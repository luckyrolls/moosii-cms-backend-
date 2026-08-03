import { supabase } from "../supabase";

// Content-tree tables (quiz_*, lesson_tags, questionnaire atoms, progress/starred) are
// partly ahead of database.types.ts. Single untyped bridge for the teardown planners.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Exact head-count of `table WHERE col = val` (or `col IN vals`). An empty IN list is 0
// without a query. Throws on a real DB error (the columns here are all verified live), so
// a dry-run never silently under-reports.
async function countBy(table: string, col: string, val: string | string[]): Promise<number> {
  if (Array.isArray(val) && val.length === 0) return 0;
  let q = db.from(table).select("*", { count: "exact", head: true });
  q = Array.isArray(val) ? q.in(col, val) : q.eq(col, val);
  const { count, error } = await q;
  if (error) throw new Error(`count ${table}.${col} failed: ${error.message}`);
  return count ?? 0;
}

export type LessonDeletePlan =
  | { found: false }
  | {
      found: true;
      segmentIds: string[];
      subSegmentIds: string[];
      // content_images that are NOT card-owned (lesson_id or segment_id set, sub_segment_id
      // NULL). purgeImagesForSubSegments filters sub_segment_id ONLY, so these would orphan
      // their storage files — the delete REFUSES (409) when this is > 0.
      orphanImageCount: number;
      counts: Record<string, number>;
    };

// Plan a lesson teardown: enumerate the subtree (so the image purge has the sub_segment ids
// WHILE the rows still exist — cascade would remove them before we could read them) and
// count every CASCADE descendant for the dry-run confirm modal. Reads only; deletes nothing.
export async function planLessonDelete(lessonId: string): Promise<LessonDeletePlan> {
  const { data: lesson } = await db.from("lessons").select("id").eq("id", lessonId).maybeSingle();
  if (!lesson) return { found: false };

  const { data: segRows } = await db.from("segments").select("id").eq("lesson_id", lessonId);
  const segmentIds = ((segRows ?? []) as Array<{ id: string }>).map((r) => r.id);

  const { data: subRows } = segmentIds.length
    ? await db.from("sub_segments").select("id").in("seg_id", segmentIds)
    : { data: [] as Array<{ id: string }> };
  const subSegmentIds = ((subRows ?? []) as Array<{ id: string }>).map((r) => r.id);

  const { data: qqRows } = segmentIds.length
    ? await db.from("quiz_questions").select("question_id").in("segment_id", segmentIds)
    : { data: [] as Array<{ question_id: string }> };
  const quizQuestionIds = ((qqRows ?? []) as Array<{ question_id: string }>).map((r) => r.question_id);

  // Orphan-risk images: lesson-level (lesson_id set) + segment-level (segment_id in this
  // lesson's segments). Both have sub_segment_id NULL by the content_images check constraint.
  const lessonLevelImages = await countBy("content_images", "lesson_id", lessonId);
  const segmentLevelImages = await countBy("content_images", "segment_id", segmentIds);
  const orphanImageCount = lessonLevelImages + segmentLevelImages;

  const counts: Record<string, number> = {
    segments: segmentIds.length,
    sub_segments: subSegmentIds.length,
    quiz_questions: quizQuestionIds.length,
    quiz_answers: await countBy("quiz_answers", "question_id", quizQuestionIds),
    content_images_cards: await countBy("content_images", "sub_segment_id", subSegmentIds),
    content_images_lesson_or_segment_level: orphanImageCount,
    content_findings: await countBy("content_findings", "lesson_id", lessonId),
    lesson_tags: await countBy("lesson_tags", "lesson_id", lessonId),
    lesson_source_documents: await countBy("lesson_source_documents", "lesson_id", lessonId),
    completed_items: await countBy("completed_items", "lesson_id", lessonId),
    starred_items: await countBy("starred_items", "lesson_id", lessonId),
    user_lesson_progress: await countBy("user_lesson_progress", "lesson_id", lessonId),
    quiz_response: await countBy("quiz_response", "lesson_id", lessonId),
    quiz_user_progress: await countBy("quiz_user_progress", "lesson_id", lessonId),
    questions_legacy: await countBy("questions_legacy", "lesson_id", lessonId),
  };

  return { found: true, segmentIds, subSegmentIds, orphanImageCount, counts };
}

export type QuestionnaireDeletePlan =
  | { found: false }
  | { found: true; kind: string | null; counts: Record<string, number> };

// Plan a questionnaire teardown. No images. Counts every CASCADE descendant for the dry-run.
// child_milestones is intentionally NOT counted/cleaned: source_ref is plain TEXT with no
// FK, so recorded milestone facts SURVIVE (monotonic, deliberate).
export async function planQuestionnaireDelete(qId: string): Promise<QuestionnaireDeletePlan> {
  const { data: q } = await db.from("questionnaire").select("id, kind").eq("id", qId).maybeSingle();
  if (!q) return { found: false };

  const { data: qqRows } = await db.from("questionnaire_questions").select("question_id").eq("questionnaire_id", qId);
  const questionIds = ((qqRows ?? []) as Array<{ question_id: string }>).map((r) => r.question_id);

  const { data: ansRows } = questionIds.length
    ? await db.from("questionnaire_answers").select("id").in("question_id", questionIds)
    : { data: [] as Array<{ id: string }> };
  const answerIds = ((ansRows ?? []) as Array<{ id: string }>).map((r) => r.id);

  const counts: Record<string, number> = {
    questionnaire_questions: questionIds.length,
    questionnaire_answers: answerIds.length,
    questionnaire_answer_actions: await countBy("questionnaire_answer_actions", "answer_id", answerIds),
    questionnaire_response: await countBy("questionnaire_response", "questionnaire_id", qId),
    questionnaire_user_answers: await countBy("questionnaire_user_answers", "questionnaire_id", qId),
    user_questionnaire_progress: await countBy("user_questionnaire_progress", "questionnaire_id", qId),
    completed_items: await countBy("completed_items", "questionnaire_id", qId),
    starred_items: await countBy("starred_items", "questionnaire_id", qId),
  };

  return { found: true, kind: (q as { kind: string | null }).kind, counts };
}
