// Tests for domain-scoped image prompt resolution (src/prompts/assemble.ts). Run: `npm test`
// (from the repo root — prompt files resolve against process.cwd()).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { assembleImagePrompt, imagePromptRoot, validateImagePrompts, type ImagePromptMetadata } from "../assemble";

const META: ImagePromptMetadata = {
  trackName: "T", trackDescription: "TD", lessonTitle: "L", lessonDescription: "LD",
  subSegmentHeading: "S", content: "C",
};
const ROOT = path.join(process.cwd(), "prompts", "image");

const MOOSII_TOPICS = ["baby_sleep", "feeding", "parent_mental", "safety", "_generic", "nonexistent_topic"];
const FINANCIAL_TOPICS = ["credit", "debt", "spending", "saving", "income", "accounts", "planning", "money mindset"];

test("moosii has no domain folder, so it resolves from the root — same as no domain", () => {
  assert.equal(imagePromptRoot("moosii"), ROOT);
  assert.equal(imagePromptRoot(undefined), ROOT);
});

test("moosii output is identical to the pre-change (no-domain) resolution for every case", async () => {
  for (const t of MOOSII_TOPICS) {
    assert.deepEqual(await assembleImagePrompt(t, META, undefined, undefined, "moosii"), await assembleImagePrompt(t, META));
    assert.deepEqual(await assembleImagePrompt(t, META, undefined, "scene", "moosii"), await assembleImagePrompt(t, META, undefined, "scene"));
    assert.deepEqual(await assembleImagePrompt(t, META, "OVERRIDE", undefined, "moosii"), await assembleImagePrompt(t, META, "OVERRIDE"));
  }
});

test("financial resolves from prompts/image/financial", () => {
  assert.equal(imagePromptRoot("financial"), path.join(ROOT, "financial"));
});

test("each financial topic gets its own overlay and the financial base — never a parenting file", async () => {
  for (const t of FINANCIAL_TOPICS) {
    const r = await assembleImagePrompt(t, META, undefined, undefined, "financial");
    assert.equal(r.overlayUsed, t, `overlay for ${t}`);
    assert.match(r.instructions, /Financial — Base Image-Prompt Instructions/);
    // Whole words: the base legitimately says money clichés are "infantilising".
    assert.doesNotMatch(r.instructions, /\b(crib|bassinet|nursery|parenting|parents?|baby|babies|infant|newborn|toddler)\b/i, `parenting wording in ${t}`);
    assert.deepEqual(r.versions, { base: "3", overlay: "3" });   // financial base + overlays are at v3
  }
});

test("an unknown financial topic falls back to FINANCIAL's _generic, not the parenting one", async () => {
  const r = await assembleImagePrompt("nonexistent_topic", META, undefined, undefined, "financial");
  assert.equal(r.overlayUsed, "_generic");
  assert.match(r.instructions, /any topic without its own overlay/);
  assert.doesNotMatch(r.instructions, /\b(parents?|infant|baby)\b/i);
});

test("the financial base states the hard constraints the brief requires", async () => {
  const r = await assembleImagePrompt("credit", META, undefined, undefined, "financial");
  for (const phrase of [/NO text, letters, words, numbers or digits/, /NO currency symbols, percentage signs, charts, graphs/,
    /score gauges/, /NO brand marks, logos, real institution names, payment-card networks/, /piggy banks/]) {
    assert.match(r.instructions, phrase);
  }
});

test("overrides behave the same in every domain (no files read)", async () => {
  const r = await assembleImagePrompt("credit", META, "OVERRIDE", undefined, "financial");
  assert.deepEqual(r.versions, { base: "override", overlay: "override" });
  assert.equal(r.instructions, "OVERRIDE");
});

test("boot validation passes over the root set and the financial folder", async () => {
  await validateImagePrompts();
});
