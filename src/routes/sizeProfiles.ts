import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// content_size_profiles isn't in database.types.ts (migration 014). Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

const SELECT =
  "id, name, label, total_words_min, total_words_max, words_per_card_min, words_per_card_max, max_sentence_words, max_bullet_words, max_bullets_per_card, is_active, created_at, updated_at";

const NUM_FIELDS = [
  "total_words_min", "total_words_max", "words_per_card_min", "words_per_card_max",
  "max_sentence_words", "max_bullet_words", "max_bullets_per_card",
];

class ValidationError extends Error {}
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "profile";

// Build a validated column patch from the body. Numeric fields must be a
// non-negative integer or null; absent fields are left untouched (PATCH-friendly).
function buildPatch(body: Record<string, unknown>, requireName: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (requireName && !nonEmpty(body.name)) throw new ValidationError("name is required");
  if (nonEmpty(body.name))  out.name = slugify(body.name as string);
  if (nonEmpty(body.label)) out.label = body.label;
  if (typeof body.is_active === "boolean") out.is_active = body.is_active;

  for (const f of NUM_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v === null) { out[f] = null; continue; }
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) { out[f] = v; continue; }
    throw new ValidationError(`${f} must be a non-negative integer or null`);
  }
  return out;
}

// GET /size-profiles
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("content_size_profiles").select(SELECT).order("total_words_min", { ascending: true });
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  res.json({ profiles: data ?? [] });
});

// POST /size-profiles
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const row = buildPatch((req.body ?? {}) as Record<string, unknown>, true);
    const { data, error } = await db.from("content_size_profiles").insert(row).select(SELECT).single();
    if (error) {
      if (error.code === "23505") { apiError(res, 409, "duplicate_name", `a size profile named "${row.name}" already exists`); return; }
      apiError(res, 500, "db_error", error.message); return;
    }
    res.status(201).json({ profile: data });
  } catch (e) {
    if (e instanceof ValidationError) { apiError(res, 400, "invalid_profile", e.message); return; }
    apiError(res, 500, "server_error", e instanceof Error ? e.message : String(e));
  }
});

// PATCH /size-profiles/:id
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const row = buildPatch((req.body ?? {}) as Record<string, unknown>, false);
    row.updated_at = new Date().toISOString();
    const { data, error } = await db
      .from("content_size_profiles").update(row).eq("id", req.params.id).select(SELECT).single();
    if (error) {
      if (error.code === "23505") { apiError(res, 409, "duplicate_name", "name already exists"); return; }
      apiError(res, 500, "db_error", error.message); return;
    }
    if (!data) { apiError(res, 404, "not_found", "size profile not found"); return; }
    res.json({ profile: data });
  } catch (e) {
    if (e instanceof ValidationError) { apiError(res, 400, "invalid_profile", e.message); return; }
    apiError(res, 500, "server_error", e instanceof Error ? e.message : String(e));
  }
});

// DELETE /size-profiles/:id — tones referencing it fall back to the length block
// (prompts.size_profile_id FK is ON DELETE SET NULL).
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("content_size_profiles").delete().eq("id", req.params.id).select("id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data || data.length === 0) { apiError(res, 404, "not_found", "size profile not found"); return; }
  res.status(204).end();
});

export default router;
