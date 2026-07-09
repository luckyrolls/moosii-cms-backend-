import { execSync } from "node:child_process";

export type VersionInfo = {
  commit: string; // full SHA, or "unknown"
  short: string; // 7-char SHA, or "unknown"
  branch: string | null;
  source: "render" | "git" | "none";
};

// Resolved once per process — the deployed commit can't change while the process runs.
let cached: VersionInfo | null = null;

// What commit is this running instance? On Render, RENDER_GIT_COMMIT is injected at
// build/deploy — authoritative in prod, no shelling out. Locally it's unset, so we read
// git directly. Either way, /health only says "ok"; this says WHICH code is live.
export function getVersionInfo(): VersionInfo {
  if (cached) return cached;

  const renderCommit = process.env.RENDER_GIT_COMMIT;
  if (renderCommit) {
    cached = {
      commit: renderCommit,
      short: renderCommit.slice(0, 7),
      branch: process.env.RENDER_GIT_BRANCH ?? null,
      source: "render",
    };
    return cached;
  }

  try {
    const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    let branch: string | null = null;
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    } catch {
      // branch is best-effort; a detached HEAD or missing git is fine.
    }
    cached = { commit, short: commit.slice(0, 7), branch, source: "git" };
    return cached;
  } catch {
    // No RENDER_GIT_COMMIT and no git available (e.g. a runtime without the repo).
    cached = { commit: "unknown", short: "unknown", branch: null, source: "none" };
    return cached;
  }
}
