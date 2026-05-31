import "dotenv/config";
import express from "express";
import { authMiddleware } from "./auth";
import jobsRouter from "./routes/jobs";
import { reapStaleJobs } from "./jobs/runner";

const app = express();
const port = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/jobs", authMiddleware, jobsRouter);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  reapStaleJobs().catch((err) => console.error("reapStaleJobs failed:", err));
});
