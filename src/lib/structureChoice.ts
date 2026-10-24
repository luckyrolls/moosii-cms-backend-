// Which "## Structure" text a segment-content run uses (api-contract §2b/§2c). Precedence:
//   1. an explicit structure prose override (regen `overrides.structure`)              → applied "override"
//   2. an explicit structure block override (regen `overrides.structure_block_id`)       → applied <that block's name>
//   3. the activity rule: the lesson is kind 'activity' and the caller opted in          → applied "activity_v1"
//      (the DB block prompt_blocks structure/activity_v1, migration 117, resolved by name)
//   4. the tone's default structure block                                                → applied <its name>
// Lessons never reach 3, so their structure text — and the whole prompt — is byte-identical to before.
// The activity block missing / inactive / empty fails BEFORE any model call; there is never a fallback text in code.
// Opted in: the generate_segment_content and regen_segment_content jobs, and the track batch (generate_track_content).

export const ACTIVITY_STRUCTURE_BLOCK = "activity_v1";

export type StructurePlan =
  | { source: "override"; text: string }
  | { source: "block"; blockId: string | null; reason: "override_block" | "tone_default" }
  | { source: "activity" };

const nonEmpty = (v: string | null | undefined): string | undefined => (v && v.trim() ? v : undefined);

export function planStructure(o: {
  kind: string | null | undefined;
  overrideText?: string | null;
  overrideBlockId?: string | null;
  toneBlockId: string | null;
  activityRule: boolean;
}): StructurePlan {
  const text = nonEmpty(o.overrideText);
  if (text !== undefined) return { source: "override", text };
  const blockId = nonEmpty(o.overrideBlockId);
  if (blockId !== undefined) return { source: "block", blockId, reason: "override_block" };
  if (o.activityRule && o.kind === "activity") return { source: "activity" };
  return { source: "block", blockId: o.toneBlockId, reason: "tone_default" };
}

export type BlockRow = { id: string; name: string; content: string; is_active: boolean };

export type StructureDeps = {
  // The block by id; null when the id is null (no structure layer). Throws when set but missing.
  loadBlockById(id: string | null): Promise<BlockRow | null>;
  // A structure block by its immutable name; null when there is none.
  loadStructureBlockByName(name: string): Promise<BlockRow | null>;
};

export type ResolvedStructure = {
  content: string;    // the ## Structure text ("" = no layer)
  applied: string;    // jobs.result.structure: "override" | the block's name | "none"
  blockId: string | null; // for ai_generation_log.blocks.structure
};

export async function resolveStructure(plan: StructurePlan, deps: StructureDeps): Promise<ResolvedStructure> {
  if (plan.source === "override") return { content: plan.text, applied: "override", blockId: null };
  if (plan.source === "activity") {
    const b = await deps.loadStructureBlockByName(ACTIVITY_STRUCTURE_BLOCK);
    const ref = `Activity structure block (prompt_blocks structure/${ACTIVITY_STRUCTURE_BLOCK})`;
    if (!b) throw new Error(`${ref} not found — apply migration 117, or pass an explicit structure override.`);
    if (!b.is_active) throw new Error(`${ref} is inactive — activate it, or pass an explicit structure override.`);
    if (!b.content.trim()) throw new Error(`${ref} is empty — fill it, or pass an explicit structure override.`);
    return { content: b.content, applied: b.name, blockId: b.id };
  }
  const b = await deps.loadBlockById(plan.blockId);
  if (!b) return { content: "", applied: "none", blockId: null };
  return { content: b.content, applied: b.name, blockId: b.id };
}
