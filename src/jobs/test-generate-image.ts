/**
 * Manual end-to-end test for generate_sub_segment_image.
 * Usage: npx tsx src/jobs/test-generate-image.ts <sub_segment_id>
 *
 * Posts a real job, polls until terminal, then prints the job row
 * and the created content_images row.
 */
import "dotenv/config";
import { supabase } from "../supabase";

const BASE = `http://localhost:3000`;
const KEY = process.env.INTERNAL_API_KEY ?? "";
const SUB_SEGMENT_ID = process.argv[2];

if (!SUB_SEGMENT_ID) {
  console.error("Usage: npx tsx src/jobs/test-generate-image.ts <sub_segment_id>");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function poll(jobId: string, intervalMs = 3000, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/jobs/${jobId}`, { headers });
    const job = await res.json() as Record<string, unknown>;
    const status = job.status as string;
    process.stdout.write(`\r  status: ${status.padEnd(12)}`);
    if (status === "succeeded" || status === "failed") {
      console.log(); // newline after the overwritten line
      return job;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for job to complete");
}

async function run() {
  console.log(`\nPosting generate_sub_segment_image job for sub_segment: ${SUB_SEGMENT_ID}\n`);

  const res = await fetch(`${BASE}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "generate_sub_segment_image",
      input: { sub_segment_id: SUB_SEGMENT_ID, auto_approve: false },
    }),
  });

  if (!res.ok) {
    console.error("POST /jobs failed:", res.status, await res.text());
    process.exit(1);
  }

  const { job_id } = await res.json() as { job_id: string };
  console.log(`Job created: ${job_id}`);
  console.log("Polling...");

  const job = await poll(job_id);

  console.log("\n=== Job row ===");
  console.log(JSON.stringify(job, null, 2));

  if (job.status === "succeeded") {
    const result = job.result as Record<string, unknown>;
    const contentImageId = result?.content_image_id as string | undefined;

    if (contentImageId) {
      const { data: ci } = await supabase
        .from("content_images")
        .select("*")
        .eq("id", contentImageId)
        .single();

      console.log("\n=== content_images row ===");
      console.log(JSON.stringify(ci, null, 2));
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
