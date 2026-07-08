import { dummyHandler } from "./handlers/dummy";
import { generateSubSegmentImageHandler } from "./handlers/generateSubSegmentImage";
import { generateLessonsHandler } from "./handlers/generateLessons";
import { generateSegmentContentHandler } from "./handlers/generateSegmentContent";
import { regenSegmentContentHandler } from "./handlers/regenSegmentContent";
import { generateQuizHandler } from "./handlers/generateQuiz";
import { generateTrackContentHandler } from "./handlers/generateTrackContent";
import { generateTrackImagesHandler } from "./handlers/generateTrackImages";
import { rebuildMlpHandler } from "./handlers/rebuildMlp";
import { generateQuestionnaireHandler } from "./handlers/generateQuestionnaire";
import { reviewLessonHandler } from "./handlers/reviewLesson";

export type Job = {
  id: string;
  type: string;
  status: string;
  input: Record<string, unknown>;
  result: unknown;
  error: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type JobHandler = (job: Job) => Promise<unknown>;

const registry: Record<string, JobHandler> = {
  dummy: dummyHandler,
  generate_sub_segment_image: generateSubSegmentImageHandler,
  generate_lessons: generateLessonsHandler,
  generate_segment_content: generateSegmentContentHandler,
  regen_segment_content:    regenSegmentContentHandler,
  generate_quiz:            generateQuizHandler,
  generate_track_content:   generateTrackContentHandler,
  generate_track_images:    generateTrackImagesHandler,
  rebuild_mlp:              rebuildMlpHandler,
  generate_questionnaire:   generateQuestionnaireHandler,
  review_lesson:            reviewLessonHandler,
};

export function getHandler(type: string): JobHandler {
  const handler = registry[type];
  if (!handler) throw new Error(`Unknown job type: "${type}"`);
  return handler;
}
