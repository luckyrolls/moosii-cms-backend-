import { dummyHandler } from "./handlers/dummy";
import { generateSubSegmentImageHandler } from "./handlers/generateSubSegmentImage";
import { generateLessonsHandler } from "./handlers/generateLessons";

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
};

export function getHandler(type: string): JobHandler {
  const handler = registry[type];
  if (!handler) throw new Error(`Unknown job type: "${type}"`);
  return handler;
}
