import { supabase } from "../supabase";
import { prepareGroundingDocs, type SourceDoc } from "./grounding";

export type { SourceDoc } from "./grounding";

// source_documents / lesson_source_documents postdate database.types.ts (migration 036).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Load the docs linked to a lesson (lesson-level linkage, migration 036). Shared by the
// doc_grounded review (moved verbatim from reviewLesson.ts) and grounded generation. No
// ORDER BY — the review keeps its historical behaviour; generation sorts via prepareGroundingDocs.
export async function loadLinkedDocs(lessonId: string): Promise<SourceDoc[]> {
  const { data: links, error: lErr } = await db
    .from("lesson_source_documents").select("source_document_id").eq("lesson_id", lessonId);
  if (lErr) throw new Error(`Failed to load linked documents for lesson ${lessonId}: ${lErr.message}`);
  const ids = (links ?? []).map((l: { source_document_id: string }) => l.source_document_id);
  if (ids.length === 0) return [];
  const { data: docs, error: dErr } = await db
    .from("source_documents").select("id, name, version_label, authority_note, body").in("id", ids);
  if (dErr) throw new Error(`Failed to load source documents for lesson ${lessonId}: ${dErr.message}`);
  return (docs ?? []) as SourceDoc[];
}

// Loader + zero-docs / size guard + stable order, for use_source_documents.
export async function loadDocsForGrounding(lessonId: string): Promise<SourceDoc[]> {
  return prepareGroundingDocs(lessonId, await loadLinkedDocs(lessonId));
}
