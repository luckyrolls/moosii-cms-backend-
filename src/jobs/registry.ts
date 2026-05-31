import { dummyHandler } from "./handlers/dummy";

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
};

export function getHandler(type: string): JobHandler {
  const handler = registry[type];
  if (!handler) throw new Error(`Unknown job type: "${type}"`);
  return handler;
}
