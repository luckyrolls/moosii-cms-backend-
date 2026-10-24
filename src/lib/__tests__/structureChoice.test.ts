// "## Structure" selection for segment content (src/lib/structureChoice.ts; api-contract §2b/§2c). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planStructure, resolveStructure, ACTIVITY_STRUCTURE_BLOCK, type BlockRow, type StructureDeps } from "../structureChoice";
import { composeUserMessage } from "../segmentPrompt";

const TONE_BLOCK: BlockRow = { id: "tone-structure-id", name: "standard_arc", content: "STRUCT", is_active: true };
const SWAP_BLOCK: BlockRow = { id: "swap-id", name: "sturdy_6_card_arc", content: "SWAPPED", is_active: true };
const ACTIVITY: BlockRow = { id: "activity-id", name: ACTIVITY_STRUCTURE_BLOCK, content: "Write this as an activity, not a lesson.", is_active: true };

function deps(activity: BlockRow | null = ACTIVITY) {
  const calls: string[] = [];
  const d: StructureDeps = {
    async loadBlockById(id) {
      calls.push(`id:${id}`);
      if (id === null) return null;
      const b = [TONE_BLOCK, SWAP_BLOCK].find((x) => x.id === id);
      if (!b) throw new Error(`Failed to load structure block (id: ${id}): not found`);
      return b;
    },
    async loadStructureBlockByName(name) { calls.push(`name:${name}`); return activity; },
  };
  return { d, calls };
}

test("plan: override text > block override > activity rule > tone default", () => {
  const base = { toneBlockId: TONE_BLOCK.id, activityRule: true };
  assert.deepEqual(planStructure({ ...base, kind: "activity", overrideText: "MINE", overrideBlockId: "swap-id" }), { source: "override", text: "MINE" });
  assert.deepEqual(planStructure({ ...base, kind: "activity", overrideBlockId: "swap-id" }), { source: "block", blockId: "swap-id", reason: "override_block" });
  assert.deepEqual(planStructure({ ...base, kind: "activity" }), { source: "activity" });
  assert.deepEqual(planStructure({ ...base, kind: "lesson" }), { source: "block", blockId: TONE_BLOCK.id, reason: "tone_default" });
  assert.deepEqual(planStructure({ ...base, kind: null }), { source: "block", blockId: TONE_BLOCK.id, reason: "tone_default" });
  // whitespace-only overrides fall through, as before
  assert.deepEqual(planStructure({ ...base, kind: "activity", overrideText: "   ", overrideBlockId: " " }), { source: "activity" });
});

test("an activity generate uses activity_v1 (by name) and records it", async () => {
  const { d, calls } = deps();
  const r = await resolveStructure(planStructure({ kind: "activity", toneBlockId: TONE_BLOCK.id, activityRule: true }), d);
  assert.deepEqual(r, { content: ACTIVITY.content, applied: "activity_v1", blockId: "activity-id" });
  assert.deepEqual(calls, ["name:activity_v1"]);                   // the tone default is not even loaded
});

test("an explicit override wins on an activity: prose → 'override'; block override → that block's name", async () => {
  const a = deps();
  assert.deepEqual(await resolveStructure(planStructure({ kind: "activity", overrideText: "MINE", toneBlockId: TONE_BLOCK.id, activityRule: true }), a.d),
    { content: "MINE", applied: "override", blockId: null });
  const b = deps();
  assert.deepEqual(await resolveStructure(planStructure({ kind: "activity", overrideBlockId: "swap-id", toneBlockId: TONE_BLOCK.id, activityRule: true }), b.d),
    { content: "SWAPPED", applied: "sturdy_6_card_arc", blockId: "swap-id" });
  assert.deepEqual([...a.calls, ...b.calls], ["id:swap-id"]);       // activity_v1 never consulted
});

test("a caller that does not opt in (rule off) keeps the tone default even for an activity", async () => {
  const { d, calls } = deps();
  const r = await resolveStructure(planStructure({ kind: "activity", toneBlockId: TONE_BLOCK.id, activityRule: false }), d);
  assert.deepEqual(r, { content: "STRUCT", applied: "standard_arc", blockId: TONE_BLOCK.id });
  assert.deepEqual(calls, [`id:${TONE_BLOCK.id}`]);
});

// The composer's golden (src/lib/__tests__/segmentPrompt.test.ts): a lesson whose tone structure block holds "STRUCT".
const GOLDEN_FULL = "SCOPE TEXT\n\n## Tone\n\nTONE\n\n## Structure\n\nSTRUCT\n\n## Card Positions\n\nCP\n\n## Length\n\nLEN\n\n## Avoid\n\nAVOID\n\n## Context\n\nLesson title: Safe sleep\nChild age range: 0–6 months\nThis is a lesson. Refer to it as \"this lesson\", never as a segment.\nDescription: Desc";

test("a lesson's prompt is byte-identical: the tone block's own text, never the activity block", async () => {
  for (const activityRule of [true, false]) {
    const { d, calls } = deps();
    const s = await resolveStructure(planStructure({ kind: "lesson", toneBlockId: TONE_BLOCK.id, activityRule }), d);
    assert.equal(s.content, TONE_BLOCK.content);
    assert.ok(!calls.some((c) => c.startsWith("name:")), "activity block must not be read for a lesson");
    const prompt = composeUserMessage({
      scope: "SCOPE TEXT", toneContent: "TONE", structureContent: s.content, cardPositionsContent: "CP", lengthContent: "LEN",
      lessonTitle: "Safe sleep", minChildAge: 0, maxChildAge: 6, segmentName: "Safe sleep", segmentDescription: "Desc", kind: "lesson", avoid: "AVOID",
    });
    assert.equal(prompt, GOLDEN_FULL);
  }
  // a tone with no structure block: no layer, exactly as loadBlock(null) gave
  const { d } = deps();
  assert.deepEqual(await resolveStructure(planStructure({ kind: "lesson", toneBlockId: null, activityRule: true }), d), { content: "", applied: "none", blockId: null });
});

test("a missing / inactive / empty activity block fails legibly (before any model call — no text fallback)", async () => {
  const plan = planStructure({ kind: "activity", toneBlockId: TONE_BLOCK.id, activityRule: true });
  await assert.rejects(resolveStructure(plan, deps(null).d), /structure\/activity_v1\) not found — apply migration 117/);
  await assert.rejects(resolveStructure(plan, deps({ ...ACTIVITY, is_active: false }).d), /activity_v1\) is inactive/);
  await assert.rejects(resolveStructure(plan, deps({ ...ACTIVITY, content: "  " }).d), /activity_v1\) is empty/);
});
