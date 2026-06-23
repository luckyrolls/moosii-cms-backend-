import "dotenv/config";
import express from "express";
import { jobsAuthMiddleware } from "./auth";
import { corsMiddleware } from "./middleware/cors";
import { jwtAuthMiddleware } from "./middleware/jwtAuth";
import jobsRouter from "./routes/jobs";
import contentImagesRouter from "./routes/images";
import segmentsRouter from "./routes/segments";
import subSegmentsRouter from "./routes/subSegments";
import lessonsRouter from "./routes/lessons";
import voiceLintRulesRouter from "./routes/voiceLintRules";
import tonesRouter from "./routes/tones";
import sizeProfilesRouter from "./routes/sizeProfiles";
import { reapStaleJobs } from "./jobs/runner";
import { validateImagePrompts } from "./prompts/assemble";

const app = express();
const port = process.env.PORT ?? 3000;

// CORS — must come before auth so unauthenticated OPTIONS preflights are
// answered with 2xx + CORS headers (preflights carry no Authorization header).
app.use(corsMiddleware);

app.use(express.json());

// Unauthenticated
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// SPA routes — JWT auth (Supabase access token)
app.use("/sub-segments", jwtAuthMiddleware, subSegmentsRouter);
app.use("/segments", jwtAuthMiddleware, segmentsRouter);
app.use("/content-images", jwtAuthMiddleware, contentImagesRouter);
app.use("/lessons", jwtAuthMiddleware, lessonsRouter);
app.use("/voice-lint-rules", jwtAuthMiddleware, voiceLintRulesRouter);
app.use("/tones", jwtAuthMiddleware, tonesRouter);
app.use("/size-profiles", jwtAuthMiddleware, sizeProfilesRouter);

// Job creation — accepts the internal shared secret (server-to-server) OR a
// CMS admin's Supabase JWT (browser).
app.use("/jobs", jobsAuthMiddleware, jobsRouter);

async function start() {
  // Fail fast at boot if any image prompt file is malformed, so a bad prompt
  // breaks the deploy (Render keeps the old version) rather than a user's job.
  await validateImagePrompts();

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    reapStaleJobs().catch((err) => console.error("reapStaleJobs failed:", err));
  });
}

start().catch((err) => {
  console.error("FATAL: startup failed:", err);
  process.exit(1);
});
