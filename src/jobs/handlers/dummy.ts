import { Job } from "../registry";

export async function dummyHandler(job: Job): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 3000));
  return { message: "dummy job complete", echo: job.input };
}
