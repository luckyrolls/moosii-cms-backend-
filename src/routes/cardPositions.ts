import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// prompt_blocks isn't in database.types.ts. Untyped bridge (same as structureBlocks).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

// Edit-only management of CARD-POSITIONS blocks (prompt_blocks where
// block_type='card_positions') — the per-position card rules shared by BOTH generation
// (## Card Positions section) and review ({{card_positions}} token). Referenced by
// prompts.card_positions_block_id. No POST/DELETE: it's a shared singleton, and `name`
// is immutable (it's the composition key the handlers resolve by).

const SELECT = "id, name, label, content, is_active, created_at, updated_at";
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

// used_by, computed per response (no caching): count prompts referencing each block,
// split segment vs review. Returns a map keyed by block id.
type UsedBy = { segment_prompts: number; review_prompts: number };
async function usedByMap(): Promise<Map<string, UsedBy>> {
  const { data } = await db
    .from("prompts").select("card_positions_block_id, prompt_type").not("card_positions_block_id", "is", null);
  const map = new Map<string, UsedBy>();
  for (const r of (data ?? []) as Array<{ card_positions_block_id: string | null; prompt_type: string | null }>) {
    const id = r.card_positions_block_id;
    if (!id) continue;
    const e = map.get(id) ?? { segment_prompts: 0, review_prompts: 0 };
    if (r.prompt_type === "segment") e.segment_prompts += 1;
    else if (typeof r.prompt_type === "string" && r.prompt_type.startsWith("review")) e.review_prompts += 1;
    map.set(id, e);
  }
  return map;
}
const withUsedBy = (block: Record<string, unknown>, m: Map<string, UsedBy>) => ({
  ...block,
  used_by: m.get(block.id as string) ?? { segment_prompts: 0, review_prompts: 0 },
});

// GET /card-positions
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("prompt_blocks").select(SELECT).eq("block_type", "card_positions").order("name", { ascending: true });
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  const m = await usedByMap();
  res.json({ card_positions_blocks: (data ?? []).map((b: Record<string, unknown>) => withUsedBy(b, m)) });
});

// PATCH /card-positions/:id — edit label / content / is_active. `name` is immutable.
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data: existing, error: fErr } = await db
    .from("prompt_blocks").select("id").eq("id", req.params.id).eq("block_type", "card_positions").single();
  if (fErr || !existing) { apiError(res, 404, "not_found", "card positions block not found"); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (nonEmpty(body.label))                 patch.label = body.label;
  if (nonEmpty(body.content))               patch.content = body.content;
  if (typeof body.is_active === "boolean")  patch.is_active = body.is_active;
  if (Object.keys(patch).length === 0) {
    apiError(res, 400, "invalid_block", "provide at least one of label, content, is_active (name is immutable)");
    return;
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("prompt_blocks").update(patch).eq("id", req.params.id).select(SELECT).single();
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  const m = await usedByMap();
  res.json({ card_positions_block: withUsedBy(data, m) });
});

export default router;
