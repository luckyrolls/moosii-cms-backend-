import "dotenv/config";
import express from "express";
import { authMiddleware } from "./auth";
import { corsMiddleware } from "./middleware/cors";
import { jwtAuthMiddleware } from "./middleware/jwtAuth";
import jobsRouter from "./routes/jobs";
import contentImagesRouter from "./routes/images";
import segmentsRouter from "./routes/segments";
import subSegmentsRouter from "./routes/subSegments";
import lessonsRouter from "./routes/lessons";
import { reapStaleJobs } from "./jobs/runner";

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

// Server-to-server / internal tooling — shared secret
app.use("/jobs", authMiddleware, jobsRouter);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  reapStaleJobs().catch((err) => console.error("reapStaleJobs failed:", err));
});
