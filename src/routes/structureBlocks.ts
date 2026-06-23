import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// prompt_blocks isn't in database.types.ts (post-0001). Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

// Reusable library of STRUCTURE blocks (prompt_blocks where block_type='structure').
// A tone references one via prompts.structure_block_id (set in tone CRUD). Voice
// (tone) blocks and length are managed elsewhere — this router only touches
// block_type='structure'.

const SELECT = "id, name, label, content, is_active, created_at, updated_at";
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "structure";

// GET /structure-blocks
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("prompt_blocks").select(SELECT).eq("block_type", "structure").order("name", { ascending: true });
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  res.json({ structure_blocks: data ?? [] });
});

// POST /structure-blocks
router.post("/", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!nonEmpty(body.name))    { apiError(res, 400, "invalid_block", "name is required"); return; }
  if (!nonEmpty(body.content)) { apiError(res, 400, "invalid_block", "content is required"); return; }

  const row = {
    block_type: "structure",
    name:       slugify(body.name as string),
    label:      nonEmpty(body.label) ? body.label : (body.name as string).trim(),
    content:    body.content,
    is_active:  typeof body.is_active === "boolean" ? body.is_active : true,
  };
  const { data, error } = await db.from("prompt_blocks").insert(row).select(SELECT).single();
  if (error) {
    if (error.code === "23505") { apiError(res, 409, "duplicate_name", `a structure block named "${row.name}" already exists`); return; }
    apiError(res, 500, "db_error", error.message); return;
  }
  res.status(201).json({ structure_block: data });
});

// PATCH /structure-blocks/:id
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data: existing, error: fErr } = await db
    .from("prompt_blocks").select("id").eq("id", req.params.id).eq("block_type", "structure").single();
  if (fErr || !existing) { apiError(res, 404, "not_found", "structure block not found"); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (nonEmpty(body.name))                  patch.name = slugify(body.name as string);
  if (nonEmpty(body.label))                 patch.label = body.label;
  if (nonEmpty(body.content))               patch.content = body.content;
  if (typeof body.is_active === "boolean")  patch.is_active = body.is_active;

  const { data, error } = await db.from("prompt_blocks").update(patch).eq("id", req.params.id).select(SELECT).single();
  if (error) {
    if (error.code === "23505") { apiError(res, 409, "duplicate_name", "name already exists"); return; }
    apiError(res, 500, "db_error", error.message); return;
  }
  res.json({ structure_block: data });
});

// DELETE /structure-blocks/:id — blocked if any tone still references it (FK is
// RESTRICT), surfaced as 409 rather than a raw FK error.
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data: existing, error: fErr } = await db
    .from("prompt_blocks").select("id").eq("id", req.params.id).eq("block_type", "structure").single();
  if (fErr || !existing) { apiError(res, 404, "not_found", "structure block not found"); return; }

  const { data: users } = await db.from("prompts").select("id").eq("structure_block_id", req.params.id).limit(1);
  if (users && users.length > 0) {
    apiError(res, 409, "in_use", "structure block is referenced by one or more tones — repoint them first");
    return;
  }

  const { error } = await db.from("prompt_blocks").delete().eq("id", req.params.id);
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  res.status(204).end();
});

export default router;
