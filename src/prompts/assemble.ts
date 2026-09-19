import fs from "fs/promises";
import { existsSync, readdirSync } from "fs";
import path from "path";
// Type-only: erased at compile time, so this module never runs domain.ts's validate-and-exit.
import type { Domain } from "../lib/domain";

// prompts/ lives at the repo root. process.cwd() is the repo root in both
// dev (tsx) and prod (node dist/index.js on Render), so no copy step needed.
const PROMPTS_ROOT = path.join(process.cwd(), "prompts", "image");

// Domain-scoped image prompts (2026-09-18). A deployment whose domain has its own folder —
// prompts/image/<domain>/ containing a base.md — resolves base, topics/<name>.md and
// topics/_generic.md entirely from that folder (it never falls back to another domain's
// overlays). Any other domain, or no domain, uses the root exactly as before: moosii has no
// folder, so its resolution — paths, bodies, versions, overlayUsed — is unchanged.
export function imagePromptRoot(domain?: Domain): string {
  if (domain) {
    const scoped = path.join(PROMPTS_ROOT, domain);
    if (existsSync(path.join(scoped, "base.md"))) return scoped;
  }
  return PROMPTS_ROOT;
}

export type ImagePromptMetadata = {
  trackName: string;
  trackDescription: string;
  lessonTitle: string;
  lessonDescription: string;
  subSegmentHeading: string;
  content: string;
};

export type AssembledPrompt = {
  instructions: string;
  userPrompt: string;
  versions: { base: string; overlay: string };
  overlayUsed: string;
};

function parseFrontmatter(raw: string, filePath: string): { version: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing or malformed frontmatter in ${filePath}`);
  const versionLine = match[1].match(/version:\s*(.+)/);
  if (!versionLine) throw new Error(`No version field in frontmatter of ${filePath}`);
  return { version: versionLine[1].trim(), body: match[2].trim() };
}

async function loadPromptFile(filePath: string): Promise<{ version: string; body: string }> {
  const raw = await fs.readFile(filePath, "utf-8");
  return parseFrontmatter(raw, filePath);
}

// Parse every image prompt file (base + all topic overlays) so a missing/
// malformed frontmatter block fails at startup (deploy-time) instead of when a
// user triggers an image job. Throws with all offending files listed. Covers the
// root set AND every domain folder (prompts/image/<domain>/ with a base.md), each of
// which must also carry its own topics/_generic.md — the fallback never leaves the folder.
export async function validateImagePrompts(): Promise<void> {
  const roots = [PROMPTS_ROOT];
  for (const entry of readdirSync(PROMPTS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "topics" && existsSync(path.join(PROMPTS_ROOT, entry.name, "base.md"))) {
      roots.push(path.join(PROMPTS_ROOT, entry.name));
    }
  }

  const files: string[] = [];
  for (const root of roots) {
    files.push(path.join(root, "base.md"));
    const topicsDir = path.join(root, "topics");
    const topicFiles = (await fs.readdir(topicsDir)).filter((f) => f.endsWith(".md"));
    if (!topicFiles.includes("_generic.md")) files.push(path.join(topicsDir, "_generic.md")); // reported as missing below
    for (const f of topicFiles) files.push(path.join(topicsDir, f));
  }

  const errors: string[] = [];
  for (const file of files) {
    try {
      await loadPromptFile(file);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Image prompt validation failed:\n  - ${errors.join("\n  - ")}`);
  }
  console.log(`[prompts] validated ${files.length} image prompt files`);
}

function buildUserPrompt(metadata: ImagePromptMetadata): string {
  return [
    `Track: ${metadata.trackName}`,
    `Track description: ${metadata.trackDescription}`,
    `Lesson: ${metadata.lessonTitle}`,
    `Lesson description: ${metadata.lessonDescription}`,
    `Sub-segment: ${metadata.subSegmentHeading}`,
    `Content: ${metadata.content}`,
  ].join("\n");
}

export async function assembleImagePrompt(
  topicName: string,
  metadata: ImagePromptMetadata,
  instructionsOverride?: string,
  sceneOverride?: string,
  domain?: Domain            // selects prompts/image/<domain>/ when it exists (imagePromptRoot)
): Promise<AssembledPrompt> {
  // sceneOverride replaces the derived card-content scene (the userPrompt). It is
  // the SCENE layer; instructionsOverride is the STYLE layer — orthogonal, both may
  // be set. Caller passes a trimmed non-empty string or undefined.
  const userPrompt = sceneOverride ?? buildUserPrompt(metadata);

  if (instructionsOverride !== undefined) {
    return {
      instructions: instructionsOverride,
      userPrompt,
      versions: { base: "override", overlay: "override" },
      overlayUsed: "override",
    };
  }

  const root = imagePromptRoot(domain);
  const base = await loadPromptFile(path.join(root, "base.md"));

  const topicPath = path.join(root, "topics", `${topicName}.md`);
  const genericPath = path.join(root, "topics", "_generic.md");

  let overlay: { version: string; body: string };
  let overlayUsed: string;

  try {
    await fs.access(topicPath);
    overlay = await loadPromptFile(topicPath);
    overlayUsed = topicName;
  } catch {
    overlay = await loadPromptFile(genericPath);
    overlayUsed = "_generic";
  }

  return {
    instructions: `${base.body}\n\n${overlay.body}`,
    userPrompt,
    versions: { base: base.version, overlay: overlay.version },
    overlayUsed,
  };
}
