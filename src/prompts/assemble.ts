import fs from "fs/promises";
import path from "path";

// prompts/ lives at the repo root. process.cwd() is the repo root in both
// dev (tsx) and prod (node dist/index.js on Render), so no copy step needed.
const PROMPTS_ROOT = path.join(process.cwd(), "prompts", "image");

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
  instructionsOverride?: string
): Promise<AssembledPrompt> {
  const userPrompt = buildUserPrompt(metadata);

  if (instructionsOverride !== undefined) {
    return {
      instructions: instructionsOverride,
      userPrompt,
      versions: { base: "override", overlay: "override" },
      overlayUsed: "override",
    };
  }

  const base = await loadPromptFile(path.join(PROMPTS_ROOT, "base.md"));

  const topicPath = path.join(PROMPTS_ROOT, "topics", `${topicName}.md`);
  const genericPath = path.join(PROMPTS_ROOT, "topics", "_generic.md");

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
