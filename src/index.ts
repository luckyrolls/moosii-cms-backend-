import "dotenv/config";
// DOMAIN is validated at import and exits the process if unset/unknown — keep this the
// first import after dotenv so a mislabelled deploy fails before anything else boots.
import { DOMAIN, assertDomainMatchesDatabase } from "./lib/domain";
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
import structureBlocksRouter from "./routes/structureBlocks";
import cardPositionsRouter from "./routes/cardPositions";
import questionnairesRouter from "./routes/questionnaires";
import questionnairePromptRouter from "./routes/questionnairePrompt";
import classifyUpdateRouter from "./routes/classifyUpdate";
import quizRouter from "./routes/quiz";
import mlpRouter from "./routes/mlp";
import sourceDocumentsRouter from "./routes/sourceDocuments";
import { reapStaleJobs } from "./jobs/runner";
import { validateImagePrompts } from "./prompts/assemble";
import { getVersionInfo } from "./lib/version";

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

// Unauthenticated — reports the commit this instance is running so "what's deployed?"
// is a one-line curl, not a dashboard hunt. Low sensitivity (a git SHA), like /health.
// Also carries `domain` (src/lib/domain.ts): the CMS reads it at bootstrap and refuses to
// render against a backend whose domain differs from its own build-time one.
app.get("/version", (_req, res) => {
  res.status(200).json({ ...getVersionInfo(), domain: DOMAIN });
});

// SPA routes — JWT auth (Supabase access token)
app.use("/sub-segments", jwtAuthMiddleware, subSegmentsRouter);
app.use("/segments", jwtAuthMiddleware, segmentsRouter);
app.use("/content-images", jwtAuthMiddleware, contentImagesRouter);
app.use("/lessons", jwtAuthMiddleware, lessonsRouter);
app.use("/voice-lint-rules", jwtAuthMiddleware, voiceLintRulesRouter);
app.use("/tones", jwtAuthMiddleware, tonesRouter);
app.use("/size-profiles", jwtAuthMiddleware, sizeProfilesRouter);
app.use("/structure-blocks", jwtAuthMiddleware, structureBlocksRouter);
app.use("/card-positions", jwtAuthMiddleware, cardPositionsRouter);
app.use("/questionnaires", jwtAuthMiddleware, questionnairesRouter);
app.use("/questionnaire-prompt", jwtAuthMiddleware, questionnairePromptRouter);
app.use("/quiz", jwtAuthMiddleware, quizRouter);
app.use("/source-documents", jwtAuthMiddleware, sourceDocumentsRouter);

// App-facing (mobile) AND admin console: /classify-update and /mlp verify the
// end-user's Supabase JWT themselves (NOT the admin-only gate). classify-update has
// two caller modes — admin console (arbitrary user_id) vs app parent (self-scoped);
// see resolveCallerScope. Mounted WITHOUT jwtAuthMiddleware.
app.use("/classify-update", classifyUpdateRouter);
app.use("/mlp", mlpRouter);

// Job creation — accepts the internal shared secret (server-to-server) OR a
// CMS admin's Supabase JWT (browser).
app.use("/jobs", jobsAuthMiddleware, jobsRouter);

async function start() {
  // Fail fast at boot if any image prompt file is malformed, so a bad prompt
  // breaks the deploy (Render keeps the old version) rather than a user's job.
  await validateImagePrompts();

  // Same fail-fast posture for the domain: the DB enforces the published-content edit policy
  // from its own app_settings.domain row, so a disagreement with DOMAIN means half the
  // deployment is applying the wrong domain's rules. Exits on mismatch; tolerates the row
  // being absent (migration 064 not applied yet).
  await assertDomainMatchesDatabase();

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    reapStaleJobs().catch((err) => console.error("reapStaleJobs failed:", err));
  });
}

start().catch((err) => {
  console.error("FATAL: startup failed:", err);
  process.exit(1);
});
