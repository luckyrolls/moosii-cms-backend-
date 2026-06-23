import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// prompts post-0001 columns aren't in database.types.ts. Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

// The single active prompt_type='questionnaire' row (seeded in 0005). Editable:
// system_message + model/params. output_schema is the response contract and is
// intentionally NOT editable here.
const SELECT =
  "id, prompt_type, is_active, system_message, output_schema, model, temperature, max_tokens, updated_at";

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

// GET /questionnaire-prompt
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("prompts").select(SELECT).eq("prompt_type", "questionnaire").eq("is_active", true).single();
  if (error || !data) { apiError(res, 404, "not_found", "no active questionnaire prompt row"); return; }
  res.json({ prompt: data });
});

// PATCH /questionnaire-prompt — edit system_message and/or model/params on the
// active row. output_schema is not accepted (protected contract). An empty/blank
// system_message is ignored (can't blank the prompt).
router.patch("/", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (nonEmpty(body.system_message)) patch.system_message = body.system_message;
  if ("model" in body)       patch.model = nonEmpty(body.model) ? body.model : null;
  if ("temperature" in body) patch.temperature = typeof body.temperature === "number" ? body.temperature : null;
  if ("max_tokens" in body)  patch.max_tokens = typeof body.max_tokens === "number" ? body.max_tokens : null;

  const { data, error } = await db
    .from("prompts").update(patch).eq("prompt_type", "questionnaire").eq("is_active", true).select(SELECT).single();
  if (error || !data) { apiError(res, 404, "not_found", `no active questionnaire prompt row: ${error?.message ?? ""}`); return; }
  res.json({ prompt: data });
});

export default router;
