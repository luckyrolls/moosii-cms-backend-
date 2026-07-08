import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

// source_documents / lesson_source_documents postdate database.types.ts (migration 036).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

const SELECT = "id, name, body, origin_url, version_label, authority_note, created_at, updated_at";

class ValidationError extends Error {}
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

// Ingestion is PASTE-ONLY for v1: body is already-extracted text. PDF upload is deferred
// (no PDF/multipart lib in the stack) — a later slice can add extraction that writes the
// same `body` column; reviews only ever read stored text.
function buildPatch(body: Record<string, unknown>, isCreate: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isCreate) {
    if (!nonEmpty(body.name)) throw new ValidationError("name is required");
    if (!nonEmpty(body.body)) throw new ValidationError("body (the document text) is required");
    if (!nonEmpty(body.version_label)) throw new ValidationError("version_label is required");
  }
  if (nonEmpty(body.name)) out.name = body.name.trim();
  if (nonEmpty(body.body)) out.body = body.body;                 // extracted text
  if (nonEmpty(body.version_label)) out.version_label = body.version_label.trim();
  if ("origin_url" in body) out.origin_url = nonEmpty(body.origin_url) ? body.origin_url.trim() : null;
  if ("authority_note" in body) out.authority_note = nonEmpty(body.authority_note) ? body.authority_note : null;
  return out;
}

// GET /source-documents — library list (body omitted; it's large).
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("source_documents")
    .select("id, name, origin_url, version_label, authority_note, created_at, updated_at")
    .order("created_at", { ascending: false });
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  res.json({ source_documents: data ?? [] });
});

// GET /source-documents/:id — one doc (full body) + the lessons it's linked to.
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db.from("source_documents").select(SELECT).eq("id", req.params.id).maybeSingle();
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data) { apiError(res, 404, "not_found", "source document not found"); return; }
  const { data: links } = await db
    .from("lesson_source_documents").select("lesson_id, created_at").eq("source_document_id", req.params.id);
  res.json({ source_document: data, linked_lessons: (links ?? []).map((l: { lesson_id: string }) => l.lesson_id) });
});

// POST /source-documents — create from pasted text.
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const row = buildPatch((req.body ?? {}) as Record<string, unknown>, true);
    const { data, error } = await db.from("source_documents").insert(row).select(SELECT).single();
    if (error) { apiError(res, 500, "db_error", error.message); return; }
    res.status(201).json({ source_document: data });
  } catch (e) {
    if (e instanceof ValidationError) { apiError(res, 400, "invalid_source_document", e.message); return; }
    apiError(res, 500, "server_error", e instanceof Error ? e.message : String(e));
  }
});

// PATCH /source-documents/:id — update body/version/etc. A new body + version_label is
// how a doc is revised. Existing findings KEEP their recorded version (staleness signal),
// so this deliberately does NOT touch content_findings.
router.patch("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const row = buildPatch((req.body ?? {}) as Record<string, unknown>, false);
    if (Object.keys(row).length === 0) { apiError(res, 400, "invalid_source_document", "no updatable fields provided"); return; }
    row.updated_at = new Date().toISOString();
    const { data, error } = await db.from("source_documents").update(row).eq("id", req.params.id).select(SELECT).maybeSingle();
    if (error) { apiError(res, 500, "db_error", error.message); return; }
    if (!data) { apiError(res, 404, "not_found", "source document not found"); return; }
    res.json({ source_document: data });
  } catch (e) {
    if (e instanceof ValidationError) { apiError(res, 400, "invalid_source_document", e.message); return; }
    apiError(res, 500, "server_error", e instanceof Error ? e.message : String(e));
  }
});

// DELETE /source-documents/:id — removes the doc + its links (FK cascade). Findings keep
// their version snapshot but lose the live link (content_findings FK ON DELETE SET NULL).
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db.from("source_documents").delete().eq("id", req.params.id).select("id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data || data.length === 0) { apiError(res, 404, "not_found", "source document not found"); return; }
  res.status(204).end();
});

// POST /source-documents/:id/links — link a lesson (idempotent: PK on the pair).
router.post("/:id/links", async (req: Request, res: Response): Promise<void> => {
  const lessonId = (req.body ?? {}).lesson_id;
  if (!nonEmpty(lessonId)) { apiError(res, 400, "invalid_link", "lesson_id is required"); return; }
  const { error } = await db
    .from("lesson_source_documents")
    .upsert({ lesson_id: lessonId, source_document_id: req.params.id }, { onConflict: "lesson_id,source_document_id" });
  if (error) {
    if (error.code === "23503") { apiError(res, 404, "not_found", "lesson or source document does not exist"); return; }
    apiError(res, 500, "db_error", error.message); return;
  }
  res.status(201).json({ ok: true, lesson_id: lessonId, source_document_id: req.params.id });
});

// DELETE /source-documents/:id/links/:lesson_id — unlink.
router.delete("/:id/links/:lesson_id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from("lesson_source_documents").delete()
    .eq("source_document_id", req.params.id).eq("lesson_id", req.params.lesson_id).select("lesson_id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  if (!data || data.length === 0) { apiError(res, 404, "not_found", "link not found"); return; }
  res.status(204).end();
});

export default router;
