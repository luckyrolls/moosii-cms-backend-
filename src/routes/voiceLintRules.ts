import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// voice_lint_rules is not in database.types.ts (added by migration 012). Untyped
// bridge, same pattern as the other post-0001 reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

const SELECT =
  "id, rule_key, type, pattern, max, scope, requires, within_chars, min_words, severity, message, tone, is_active, created_at, updated_at";

const TYPES = ["ban", "opener", "limit", "conditional", "repeat"];
const SEVERITIES = ["error", "warn"];
const SCOPES = ["card", "segment"];

class ValidationError extends Error {}

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

type RuleInput = Record<string, unknown>;

// Validate a COMPLETE logical rule and return the normalized column object.
// Type-irrelevant fields are forced to null so rows stay clean and match the
// matcher's expectations (src/lib/voiceLint.ts). Throws ValidationError on any
// missing/invalid field. `conditional` severity is forced to "warn" (heuristic).
function normalizeRule(r: RuleInput): Record<string, unknown> {
  if (!nonEmpty(r.rule_key)) throw new ValidationError("rule_key is required");
  if (!nonEmpty(r.type) || !TYPES.includes(r.type as string))
    throw new ValidationError(`type must be one of: ${TYPES.join(", ")}`);
  if (!nonEmpty(r.message)) throw new ValidationError("message is required");

  const type = r.type as string;

  let severity: string;
  if (type === "conditional") {
    severity = "warn";
  } else {
    if (!nonEmpty(r.severity) || !SEVERITIES.includes(r.severity as string))
      throw new ValidationError(`severity must be one of: ${SEVERITIES.join(", ")}`);
    severity = r.severity as string;
  }

  const out: Record<string, unknown> = {
    rule_key: (r.rule_key as string).trim(),
    type,
    pattern: null,
    max: null,
    scope: null,
    requires: null,
    within_chars: null,
    min_words: null,
    severity,
    message: r.message,
    tone: nonEmpty(r.tone) ? r.tone : null,
  };
  if (typeof r.is_active === "boolean") out.is_active = r.is_active;

  switch (type) {
    case "ban":
    case "opener":
      if (!nonEmpty(r.pattern)) throw new ValidationError(`${type} requires a non-empty pattern`);
      out.pattern = r.pattern;
      break;
    case "limit":
      if (!nonEmpty(r.pattern)) throw new ValidationError("limit requires a pattern");
      if (!isInt(r.max) || (r.max as number) < 1) throw new ValidationError("limit requires max (integer >= 1)");
      if (!nonEmpty(r.scope) || !SCOPES.includes(r.scope as string))
        throw new ValidationError(`limit requires scope (${SCOPES.join(" | ")})`);
      out.pattern = r.pattern;
      out.max = r.max;
      out.scope = r.scope;
      break;
    case "conditional":
      if (!nonEmpty(r.pattern)) throw new ValidationError("conditional requires a pattern");
      if (!nonEmpty(r.requires)) throw new ValidationError("conditional requires a `requires` value");
      if (!isInt(r.within_chars) || (r.within_chars as number) < 1)
        throw new ValidationError("conditional requires within_chars (integer >= 1)");
      out.pattern = r.pattern;
      out.requires = r.requires;
      out.within_chars = r.within_chars;
      break;
    case "repeat":
      if (!isInt(r.min_words) || (r.min_words as number) < 2)
        throw new ValidationError("repeat requires min_words (integer >= 2)");
      if (!nonEmpty(r.scope) || !SCOPES.includes(r.scope as string))
        throw new ValidationError(`repeat requires scope (${SCOPES.join(" | ")})`);
      out.min_words = r.min_words;
      out.scope = r.scope;
      break;
  }

  return out;
}

// GET /voice-lint-rules — all rules (active + inactive)
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("voice_lint_rules")
    .select(SELECT)
    .order("type", { ascending: true })
    .order("rule_key", { ascending: true });
  if (error) {
    apiError(res, 500, "db_error", error.message);
    return;
  }
  res.json({ rules: data ?? [] });
});

// POST /voice-lint-rules — create
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const row = normalizeRule(req.body ?? {});
    const { data, error } = await db.from("voice_lint_rules").insert(row).select(SELECT).single();
    if (error) {
      if (error.code === "23505") {
        apiError(res, 409, "duplicate_rule_key", `rule_key "${row.rule_key}" already exists`);
        return;
      }
      apiError(res, 500, "db_error", error.message);
      return;
    }
    res.status(201).json({ rule: data });
  } catch (e) {
    if (e instanceof ValidationError) { apiError(res, 400, "invalid_rule", e.message); return; }
    apiError(res, 500, "server_error", e instanceof Error ? e.message : String(e));
  }
});

// PATCH /voice-lint-rules/:id — partial update (merge with existing, then validate whole)
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: existing, error: fErr } = await db
      .from("voice_lint_rules").select(SELECT).eq("id", req.params.id).single();
    if (fErr || !existing) { apiError(res, 404, "not_found", "rule not found"); return; }

    const merged = { ...existing, ...(req.body ?? {}) };
    const row = normalizeRule(merged);
    row.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from("voice_lint_rules").update(row).eq("id", req.params.id).select(SELECT).single();
    if (error) {
      if (error.code === "23505") {
        apiError(res, 409, "duplicate_rule_key", `rule_key "${row.rule_key}" already exists`);
        return;
      }
      apiError(res, 500, "db_error", error.message);
      return;
    }
    res.json({ rule: data });
  } catch (e) {
    if (e instanceof ValidationError) { apiError(res, 400, "invalid_rule", e.message); return; }
    apiError(res, 500, "server_error", e instanceof Error ? e.message : String(e));
  }
});

// DELETE /voice-lint-rules/:id — hard delete (use PATCH is_active=false to disable)
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("voice_lint_rules").delete().eq("id", req.params.id).select("id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data || data.length === 0) { apiError(res, 404, "not_found", "rule not found"); return; }
  res.status(204).end();
});

export default router;
