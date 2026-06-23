import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// prompts / prompt_blocks post-0001 columns aren't in database.types.ts. Untyped
// bridge, same pattern as the other prompt-domain handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

// A "tone" = one segment `prompts` row + its 1:1 voice block (prompt_blocks,
// block_type='tone', id = prompts.tone_block_id). Selection everywhere is by the
// stable prompts.id; the `tone` string is just the editable display name.

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "tone";
}

type VoiceBlock = { id: string; name: string | null; label: string | null; content: string | null };

// Assemble the API shape for one or more tone rows (joins their voice blocks).
async function assembleTones(rows: any[]): Promise<any[]> {
  const blockIds = rows.map((r) => r.tone_block_id).filter(Boolean);
  let blocks: Record<string, VoiceBlock> = {};
  if (blockIds.length > 0) {
    const { data: blkRows } = await db
      .from("prompt_blocks")
      .select("id, name, label, content")
      .in("id", blockIds);
    blocks = Object.fromEntries((blkRows ?? []).map((b: VoiceBlock) => [b.id, b]));
  }
  return rows.map((r) => ({
    id:                 r.id,
    tone:               r.tone,
    is_active:          r.is_active,
    model:              r.model,
    temperature:        r.temperature,
    max_tokens:         r.max_tokens,
    system_message:     r.system_message, // read-only context
    scope:              r.scope,           // read-only context
    structure_block_id: r.structure_block_id,
    length_block_id:    r.length_block_id,
    voice: r.tone_block_id && blocks[r.tone_block_id]
      ? {
          block_id: r.tone_block_id,
          name:     blocks[r.tone_block_id].name,
          label:    blocks[r.tone_block_id].label,
          content:  blocks[r.tone_block_id].content,
        }
      : null,
  }));
}

const TONE_SELECT =
  "id, tone, is_active, model, temperature, max_tokens, system_message, scope, tone_block_id, structure_block_id, length_block_id";

// GET /tones — all segment tones (active + inactive) with their voice block
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("prompts")
    .select(TONE_SELECT)
    .eq("prompt_type", "segment")
    .order("tone", { ascending: true });
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  res.json({ tones: await assembleTones(data ?? []) });
});

// GET /tones/:id — one tone
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("prompts").select(TONE_SELECT).eq("id", req.params.id).eq("prompt_type", "segment").single();
  if (error || !data) { apiError(res, 404, "not_found", "tone not found"); return; }
  res.json({ tone: (await assembleTones([data]))[0] });
});

// POST /tones — create from template. Clones the shared technical layers
// (system_message / scope / output_schema / structure & length blocks / model /
// params) from an existing active tone; caller supplies the display name + voice.
router.post("/", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!nonEmpty(body.tone))          { apiError(res, 400, "invalid_tone", "tone (display name) is required"); return; }
  if (!nonEmpty(body.voice_content)) { apiError(res, 400, "invalid_tone", "voice_content is required"); return; }

  // 1. Template: any active segment tone supplies the shared technical fields.
  const { data: tmpl, error: tErr } = await db
    .from("prompts")
    .select("system_message, scope, output_schema, structure_block_id, length_block_id, model, temperature, max_tokens")
    .eq("prompt_type", "segment").eq("is_active", true)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (tErr) { apiError(res, 500, "db_error", tErr.message); return; }
  if (!tmpl) { apiError(res, 409, "no_template", "no active segment tone exists to use as a template"); return; }

  // 2. Voice block (1:1 with the new tone).
  const name = slugify(body.tone as string);
  const { data: block, error: bErr } = await db
    .from("prompt_blocks")
    .insert({
      block_type: "tone",
      name,
      label:   nonEmpty(body.label) ? body.label : (body.tone as string).trim(),
      content: body.voice_content,
      is_active: true,
    })
    .select("id").single();
  if (bErr || !block) {
    if (bErr?.code === "23505") { apiError(res, 409, "duplicate_voice", `a voice block named "${name}" already exists — use a different tone name`); return; }
    apiError(res, 500, "db_error", bErr?.message ?? "failed to create voice block"); return;
  }

  // 3. The tone row, cloning the template's technical layers.
  const { data: row, error: pErr } = await db
    .from("prompts")
    .insert({
      prompt_type:        "segment",
      tone:               (body.tone as string).trim(),
      system_message:     tmpl.system_message,
      scope:              tmpl.scope,
      output_schema:      tmpl.output_schema,
      structure_block_id: tmpl.structure_block_id,
      length_block_id:    tmpl.length_block_id,
      model:              nonEmpty(body.model) ? body.model : tmpl.model,
      temperature:        typeof body.temperature === "number" ? body.temperature : tmpl.temperature,
      max_tokens:         tmpl.max_tokens,
      tone_block_id:      block.id,
      is_active:          true,
    })
    .select(TONE_SELECT).single();
  if (pErr || !row) {
    // best-effort cleanup of the orphaned voice block
    await db.from("prompt_blocks").delete().eq("id", block.id);
    apiError(res, 500, "db_error", pErr?.message ?? "failed to create tone row"); return;
  }

  res.status(201).json({ tone: (await assembleTones([row]))[0] });
});

// PATCH /tones/:id — update display name / model / params / is_active and/or the
// voice block (content, label). Technical layers (system_message, scope,
// output_schema, structure/length) are not editable here.
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { data: existing, error: fErr } = await db
    .from("prompts").select("id, tone_block_id").eq("id", req.params.id).eq("prompt_type", "segment").single();
  if (fErr || !existing) { apiError(res, 404, "not_found", "tone not found"); return; }

  // Row fields
  const rowPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (nonEmpty(body.tone))                       rowPatch.tone = (body.tone as string).trim();
  if (nonEmpty(body.model))                      rowPatch.model = body.model;
  if (typeof body.temperature === "number")      rowPatch.temperature = body.temperature;
  if (typeof body.is_active === "boolean")       rowPatch.is_active = body.is_active;

  const { error: uErr } = await db.from("prompts").update(rowPatch).eq("id", req.params.id);
  if (uErr) { apiError(res, 500, "db_error", uErr.message); return; }

  // Voice block fields
  if ((nonEmpty(body.voice_content) || nonEmpty(body.voice_label)) && existing.tone_block_id) {
    const blkPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (nonEmpty(body.voice_content)) blkPatch.content = body.voice_content;
    if (nonEmpty(body.voice_label))   blkPatch.label = body.voice_label;
    const { error: bErr } = await db.from("prompt_blocks").update(blkPatch).eq("id", existing.tone_block_id);
    if (bErr) { apiError(res, 500, "db_error", bErr.message); return; }
  }

  const { data: row } = await db.from("prompts").select(TONE_SELECT).eq("id", req.params.id).single();
  res.json({ tone: (await assembleTones([row]))[0] });
});

// DELETE /tones/:id — removes the tone row and its voice block (only if no other
// row still references that block).
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data: existing, error: fErr } = await db
    .from("prompts").select("id, tone_block_id").eq("id", req.params.id).eq("prompt_type", "segment").single();
  if (fErr || !existing) { apiError(res, 404, "not_found", "tone not found"); return; }

  const { error: dErr } = await db.from("prompts").delete().eq("id", req.params.id);
  if (dErr) { apiError(res, 500, "db_error", dErr.message); return; }

  if (existing.tone_block_id) {
    const { data: others } = await db
      .from("prompts").select("id").eq("tone_block_id", existing.tone_block_id).limit(1);
    if (!others || others.length === 0) {
      await db.from("prompt_blocks").delete().eq("id", existing.tone_block_id);
    }
  }
  res.status(204).end();
});

export default router;
