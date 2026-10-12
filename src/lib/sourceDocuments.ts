import { supabase } from "../supabase";
import {
  sortSourceDocs, requireGroundingInstructions, parseGroundingMaxChars, checkGroundingDocs,
  GROUNDING_BLOCK_TYPE, GROUNDING_BLOCK_NAME, GROUNDING_MAX_CHARS_KEY, type SourceDoc,
} from "./grounding";

export type { SourceDoc } from "./grounding";

// source_documents / lesson_source_documents / prompt_blocks / app_settings postdate or sit
// outside database.types.ts. Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Load the docs linked to a lesson (lesson-level linkage, migration 036), in a deterministic
// order (name, then id). Shared by the doc_grounded review — which applies NO size cap —
// and grounded generation.
export async function loadLinkedDocs(lessonId: string): Promise<SourceDoc[]> {
  const { data: links, error: lErr } = await db
    .from("lesson_source_documents").select("source_document_id").eq("lesson_id", lessonId);
  if (lErr) throw new Error(`Failed to load linked documents for lesson ${lessonId}: ${lErr.message}`);
  const ids = (links ?? []).map((l: { source_document_id: string }) => l.source_document_id);
  if (ids.length === 0) return [];
  const { data: docs, error: dErr } = await db
    .from("source_documents").select("id, name, version_label, authority_note, body").in("id", ids);
  if (dErr) throw new Error(`Failed to load source documents for lesson ${lessonId}: ${dErr.message}`);
  return sortSourceDocs((docs ?? []) as SourceDoc[]);
}

// Everything use_source_documents needs, guarded, BEFORE any LLM spend or destructive step:
// the DB-owned instructions block, the DB-owned cap, and the lesson's docs within that cap.
export async function loadGrounding(lessonId: string): Promise<{ instructions: string; docs: SourceDoc[]; maxChars: number }> {
  const { data: block, error: bErr } = await db
    .from("prompt_blocks").select("content, is_active")
    .eq("block_type", GROUNDING_BLOCK_TYPE).eq("name", GROUNDING_BLOCK_NAME).maybeSingle();
  if (bErr) throw new Error(`Failed to load grounding instructions block: ${bErr.message}`);
  const instructions = requireGroundingInstructions(block);

  const { data: setting, error: sErr } = await db
    .from("app_settings").select("value").eq("key", GROUNDING_MAX_CHARS_KEY).maybeSingle();
  if (sErr) throw new Error(`Failed to read app_settings.${GROUNDING_MAX_CHARS_KEY}: ${sErr.message}`);
  const maxChars = parseGroundingMaxChars(setting?.value);

  const docs = checkGroundingDocs(lessonId, await loadLinkedDocs(lessonId), maxChars);
  return { instructions, docs, maxChars };
}

// GET /lessons/:id/source-documents — metadata only (no body).
export async function listLessonSourceDocuments(lessonId: string): Promise<{ id: string; name: string; version_label: string; chars: number }[]> {
  const docs = await loadLinkedDocs(lessonId);
  return docs.map((d) => ({ id: d.id, name: d.name, version_label: d.version_label, chars: (d.body ?? "").length }));
}
