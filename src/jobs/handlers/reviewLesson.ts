import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import type { Job } from "../registry";

// content_findings + the review prompt rows postdate database.types.ts. Untyped bridge
// (same pattern as the other content handlers); regenerate types after migration 035.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// AI content review — slice 1. READ-ONLY reviewer: it produces FINDINGS for human
// judgment and writes ONLY content_findings (+ the ai_generation_log, like every AI
// call). It never edits content, never approves/rejects, never emits a verdict/score.
// Findings-or-silence: the output shape is a list of flagged issues (possibly empty);
// there is no pass/score/verdict field anywhere. An empty list = nothing flagged, NOT
// an endorsement.
//
// Two prompt-only review types this slice (seeded in migration 035):
//   best_practices — voice, AI-tells, reading level, structure.
//   factual_smell  — confident specifics that warrant a HUMAN check (flagging, not
//                    fact-checking).
// Slice 2 (doc-grounded proofing) adds more review_types; nothing here blocks that.
// ---------------------------------------------------------------------------

type ReviewType = string; // free text; the seeded types are best_practices | factual_smell
type Provider = "openai" | "gemini";

type ReviewPromptRow = {
  id: string;
  system_message: string;
  output_schema: Record<string, unknown>;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  card_positions_block_id: string | null;  // block substituted into {{card_positions}}
};

// The model's structured output. NOTE: findings-or-silence — the shape is ONLY a
// findings array; there is no pass/verdict/score field to parse. The doc_grounded type
// adds the classification + quote/passage/source fields (undefined for the other types).
type RawFinding = {
  // factual_smell / doc_grounded shape:
  card_ref?: string | null;
  finding?: string;
  severity?: string;
  kind?: string;                 // doc_grounded: contradicted | unsupported | cross_doc_disagreement
  claim_quote?: string;
  source_passage?: string;
  source_document_ref?: string | null;  // doc_grounded: the doc_id the finding concerns
  // best_practices shape (new schema): category / card_title / note / quote
  category?: string;
  card_title?: string;
  note?: string;
  quote?: string;
};

const VALID_SEVERITY = new Set(["info", "warning", "issue"]);
const DOC_GROUNDED = "doc_grounded";
const BEST_PRACTICES = "best_practices";
// The ONLY doc_grounded outcomes that become findings (three-way rule: supported /
// not-addressed are NOT findings — that's the noise guard).
const VALID_DOC_KINDS = new Set(["contradicted", "unsupported", "cross_doc_disagreement"]);
// best_practices findings MUST carry one of these five categories (from the DB schema's
// enum). Any other category = a rubric miss → drop + log (never persist).
const VALID_CATEGORIES = new Set(["DEPENDENCY", "REPETITION", "REGISTER", "AI_TELL", "TAKEAWAY_RESTATE"]);
const CARD_POSITIONS_TOKEN = "{{card_positions}}";

// A review prompt's output_schema may be stored bare ({type:object,…}) OR in OpenAI's
// wrapped form ({name, schema, strict}). Providers expect the BARE schema as
// responseSchema (Gemini passes it straight through; OpenAI strictifies it), and the
// category enum must survive — so unwrap the wrapper here.
function toBareSchema(raw: unknown): Record<string, unknown> {
  const o = raw as Record<string, unknown> | null;
  if (o && typeof o === "object" && !("type" in o) && o.schema && typeof o.schema === "object") {
    return o.schema as Record<string, unknown>;
  }
  return (o ?? {}) as Record<string, unknown>;
}

type SourceDoc = { id: string; name: string; version_label: string; authority_note: string | null; body: string };

// Load the docs linked to a lesson (lesson-level linkage). Used only for doc_grounded.
async function loadLinkedDocs(lessonId: string): Promise<SourceDoc[]> {
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

function resolveProvider(): Provider {
  const p = (process.env.REVIEW_WRITER || "openai").toLowerCase();
  if (p !== "openai" && p !== "gemini") {
    throw new Error(`Invalid REVIEW_WRITER="${p}" (expected "openai" or "gemini")`);
  }
  return p;
}

// Thin load — a review prompt is one `prompts` row keyed by prompt_type=review_<type>.
// NOT the tone/structure/length block-composition path (review isn't toned).
// Resolve a review prompt's system_message: substitute {{card_positions}} with the
// linked block's content. GENERIC — any review type whose system_message contains the
// token gets it. If the token is present but the FK is null or the block fetch fails,
// ABORT: a reviewer running without its policy is the exact failure this prevents — the
// raw token must NEVER reach the model. Exported so the dry-run verifies the real path.
export async function resolveReviewSystemMessage(promptRow: ReviewPromptRow, reviewType: ReviewType): Promise<string> {
  const sys = promptRow.system_message;
  if (!sys.includes(CARD_POSITIONS_TOKEN)) return sys;
  if (!promptRow.card_positions_block_id) {
    throw new Error(`Review prompt review_${reviewType} contains ${CARD_POSITIONS_TOKEN} but has no card_positions_block_id — cannot run the reviewer without its policy.`);
  }
  const { data: blk, error: blkErr } = await db
    .from("prompt_blocks").select("content").eq("id", promptRow.card_positions_block_id).single();
  if (blkErr || !blk?.content) {
    throw new Error(`Failed to load card_positions block ${promptRow.card_positions_block_id} for review_${reviewType}: ${blkErr?.message ?? "empty content"}`);
  }
  return sys.split(CARD_POSITIONS_TOKEN).join(blk.content as string);
}

export async function loadReviewPromptRow(reviewType: ReviewType): Promise<ReviewPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, output_schema, model, temperature, max_tokens, card_positions_block_id")
    .eq("prompt_type", `review_${reviewType}`)
    .eq("is_active", true)
    .single();
  if (error || !data) {
    throw new Error(`No active review prompt for review_type "${reviewType}" (prompt_type=review_${reviewType}): ${error?.message ?? "not found"}`);
  }
  const row = data as ReviewPromptRow;
  if (!row.system_message) throw new Error(`Review prompt review_${reviewType} has no system_message`);
  if (!row.output_schema)  throw new Error(`Review prompt review_${reviewType} has no output_schema`);
  return row;
}

type Card = { id: string; title: string | null; content: string | null; sequence: number | null };

async function loadLessonCards(lessonId: string): Promise<{ lessonName: string; cards: Card[] }> {
  const { data: lesson, error: lErr } = await supabase
    .from("lessons").select("id, lesson_name").eq("id", lessonId).single();
  if (lErr || !lesson) throw new Error(`Lesson not found: ${lessonId} (${lErr?.message ?? "no row"})`);

  const { data: segs, error: sErr } = await supabase
    .from("segments").select("id").eq("lesson_id", lessonId);
  if (sErr) throw new Error(`Failed to load segments for lesson ${lessonId}: ${sErr.message}`);
  const segIds = (segs ?? []).map((s) => s.id);
  if (segIds.length === 0) throw new Error(`Lesson ${lessonId} has no segments — nothing to review`);

  const { data: cards, error: cErr } = await supabase
    .from("sub_segments").select("id, title, content, sequence, seg_id")
    .in("seg_id", segIds)
    .order("seg_id", { ascending: true })
    .order("sequence", { ascending: true });
  if (cErr) throw new Error(`Failed to load sub_segments for lesson ${lessonId}: ${cErr.message}`);
  const withContent = (cards ?? []).filter((c) => c.content && c.content.trim()) as Card[];
  if (withContent.length === 0) throw new Error(`Lesson ${lessonId} has no content cards — generate content first`);
  return { lessonName: lesson.lesson_name ?? "", cards: withContent };
}

// Present each card prefixed with its card_id; the model echoes that id back as
// card_ref (or null for a lesson-level finding). For doc_grounded, the linked authority
// documents are appended, each prefixed with its doc_id (echoed back as source_document_ref).
function composeReviewUserMessage(lessonName: string, cards: Card[], docs: SourceDoc[] = []): string {
  const cardText = cards
    .map((c) => `[card_id: ${c.id}] Card ${c.sequence ?? "?"}: ${c.title ?? ""}\n${c.content ?? ""}`)
    .join("\n\n");
  const docSection = docs.length === 0 ? "" :
    `\n\n## Source documents (designated authority — check the cards for CONSISTENCY with these)\n` +
    `Each is prefixed with its doc_id; set source_document_ref to the doc_id a finding concerns.\n\n` +
    docs.map((d) =>
      `[doc_id: ${d.id}] ${d.name} (version: ${d.version_label})` +
      (d.authority_note ? `\nAuthority: ${d.authority_note}` : "") +
      `\n${d.body}`
    ).join("\n\n---\n\n");
  return (
    `## Lesson: ${lessonName}\n\n` +
    `## Cards to review\n` +
    `Each card below is prefixed with its card_id. In each finding, set card_ref to the ` +
    `EXACT card_id it concerns, or null for a lesson-level / cross-card finding.\n\n` +
    cardText +
    docSection
  );
}

export type ReviewLessonResult = {
  lesson_id: string;
  review_type: ReviewType;
  correlation_id: string;
  provider: Provider;
  model: string;
  findings_count: number;
  lesson_level_count: number;
  card_level_count: number;
};

// Core — exported so a later batch (slice 3) can drive it with a shared correlationId.
export async function reviewLesson(opts: {
  lesson_id: string;
  review_type: ReviewType;
  correlationId: string;
}): Promise<ReviewLessonResult> {
  const { lesson_id, review_type, correlationId } = opts;
  const provider = resolveProvider();

  const promptRow = await loadReviewPromptRow(review_type);
  const { lessonName, cards } = await loadLessonCards(lesson_id);
  const systemMessage = await resolveReviewSystemMessage(promptRow, review_type);

  // doc_grounded reviews against the lesson's linked authority documents. Zero linked
  // docs → FAIL LEGIBLY (not an empty success — there was nothing to proof against).
  let docs: SourceDoc[] = [];
  if (review_type === DOC_GROUNDED) {
    docs = await loadLinkedDocs(lesson_id);
    if (docs.length === 0) {
      throw new Error(`No source documents linked to lesson ${lesson_id} — link at least one before a doc_grounded review.`);
    }
  }
  const docById = new Map(docs.map((d) => [d.id, d]));
  const userPrompt = composeReviewUserMessage(lessonName, cards, docs);

  // LLM call — provider-parameterized; withRetry lives inside the provider (the retry
  // fix now covers OpenAI transient errors too).
  const client = getLLMClient(provider);
  const llmStart = Date.now();
  const result = await client.generate({
    instructions:   systemMessage,
    userPrompt,
    responseSchema: toBareSchema(promptRow.output_schema),  // unwrap {name,schema,strict} → bare; enum survives
    model:          promptRow.model ?? undefined,
    temperature:    promptRow.temperature ?? undefined,
    maxTokens:      promptRow.max_tokens ?? undefined,
  });

  await logAiCall({
    correlationId,
    operation:         `content_review_${review_type}`,
    prompt:            formatLlmPrompt(systemMessage, userPrompt),
    response:          result.raw,
    model:             result.model,
    latencyMs:         Date.now() - llmStart,
    relatedEntityType: "lesson",
    relatedEntityId:   lesson_id,
    notes:             `review_type=${review_type}, provider=${provider}, cards=${cards.length}`,
    blocks:            { card_positions: promptRow.card_positions_block_id },
  });

  // Unparseable / truncated output → FAIL VISIBLY. Never silently zero findings — a
  // parse failure is not "nothing flagged".
  if (result.finishReason === "length" || result.finishReason === "content_filter") {
    throw new Error(`Review model stopped with finish_reason="${result.finishReason}" for lesson ${lesson_id} — not parseable. Retry the job.`);
  }
  let findings: RawFinding[];
  try {
    const parsed = JSON.parse(result.text) as { findings: RawFinding[] };
    findings = parsed.findings;
  } catch (err) {
    throw new Error(`Failed to parse review response as JSON for lesson ${lesson_id}.\nError: ${err}\nRaw: ${result.text}`);
  }
  if (!Array.isArray(findings)) {
    throw new Error(`Review response missing a findings array for lesson ${lesson_id}`);
  }

  // Map findings → rows. Three output shapes by review_type:
  //   best_practices → { category, card_title, note, quote }
  //   factual_smell  → { card_ref, finding, severity }
  //   doc_grounded   → { card_ref, kind, finding, severity, claim_quote, source_passage, source_document_ref }
  const isDocGrounded = review_type === DOC_GROUNDED;
  const isBestPractices = review_type === BEST_PRACTICES;
  const cardIds = new Set(cards.map((c) => c.id));
  const cardIdByTitle = new Map(cards.map((c) => [(c.title ?? "").trim().toLowerCase(), c.id]));

  const rows = findings
    .filter((f) => {
      if (!f) return false;
      if (isBestPractices) {
        // Validate category against the five-value enum; DROP + LOG unknown (never persist).
        if (!VALID_CATEGORIES.has(f.category ?? "")) {
          console.warn(`[review_lesson] dropping best_practices finding with unknown category "${f.category}" (lesson ${lesson_id})`);
          return false;
        }
        if (typeof f.note !== "string" || !f.note.trim()) {
          console.warn(`[review_lesson] dropping best_practices finding with no note (lesson ${lesson_id})`);
          return false;
        }
        return true;
      }
      if (typeof f.finding !== "string" || !f.finding.trim()) {
        console.warn(`[review_lesson] dropping a finding with no text (lesson ${lesson_id})`);
        return false;
      }
      // Three-way rule (server-side guard): a doc_grounded finding must be one of the
      // three flaggable kinds. supported / not-addressed are NOT findings.
      if (isDocGrounded && !VALID_DOC_KINDS.has(f.kind ?? "")) {
        console.warn(`[review_lesson] dropping doc_grounded finding with non-flaggable kind "${f.kind}" (lesson ${lesson_id})`);
        return false;
      }
      return true;
    })
    .map((f) => {
      if (isBestPractices) {
        // Anchor by card_title (the new schema names the card, not its id).
        let subId: string | null = null;
        if (f.card_title) {
          const hit = cardIdByTitle.get(f.card_title.trim().toLowerCase());
          if (hit) subId = hit;
          else console.warn(`[review_lesson] best_practices finding referenced unknown card_title "${f.card_title}" — anchoring to lesson level`);
        }
        return {
          correlation_id: correlationId,
          review_type,
          lesson_id,
          sub_segment_id: subId,
          finding: f.note!.trim(),
          severity: "info",                 // new schema carries no severity; category is the signal
          status: "open",
          category: f.category ?? null,     // REQUIRES a content_findings.category column (flagged)
          claim_quote: (f.quote ?? "").trim() || null,
          finding_kind: null,
          source_passage: null,
          source_document_id: null,
          source_version_label: null,
        };
      }

      // factual_smell / doc_grounded
      let subId: string | null = null;
      if (f.card_ref) {
        if (cardIds.has(f.card_ref)) subId = f.card_ref;
        else console.warn(`[review_lesson] finding referenced unknown card_id "${f.card_ref}" — anchoring to lesson level`);
      }
      const severity = VALID_SEVERITY.has(f.severity ?? "") ? f.severity! : "info";

      // doc_grounded enrichment: resolve the doc + SNAPSHOT its version_label (staleness).
      let sourceDocumentId: string | null = null;
      let sourceVersionLabel: string | null = null;
      if (isDocGrounded && f.source_document_ref) {
        const doc = docById.get(f.source_document_ref);
        if (doc) { sourceDocumentId = doc.id; sourceVersionLabel = doc.version_label; }
        else console.warn(`[review_lesson] doc_grounded finding referenced unknown doc_id "${f.source_document_ref}" (lesson ${lesson_id})`);
      }

      return {
        correlation_id: correlationId,
        review_type,
        lesson_id,
        sub_segment_id: subId,
        finding: f.finding!.trim(),
        severity,
        status: "open",
        finding_kind:         isDocGrounded ? (f.kind ?? null) : null,
        claim_quote:          isDocGrounded ? (f.claim_quote ?? null) : null,
        source_passage:       isDocGrounded ? (f.source_passage ?? null) : null,
        source_document_id:   sourceDocumentId,
        source_version_label: sourceVersionLabel,
      };
    });

  // Insert findings (if any). Zero findings = valid silence → no rows written.
  if (rows.length > 0) {
    const { error: insErr } = await db.from("content_findings").insert(rows);
    if (insErr) throw new Error(`Failed to insert content_findings for lesson ${lesson_id}: ${insErr.message}`);
  }

  const cardLevel = rows.filter((r) => r.sub_segment_id !== null).length;
  return {
    lesson_id,
    review_type,
    correlation_id: correlationId,
    provider,
    model: result.model,
    findings_count: rows.length,
    lesson_level_count: rows.length - cardLevel,
    card_level_count: cardLevel,
  };
}

// ---------------------------------------------------------------------------
// Job handler — review_lesson. correlationId = job.id so a run's findings join to the
// job + ai_generation_log, and re-runs are distinguishable by correlation_id.
// ---------------------------------------------------------------------------
type Input = { lesson_id: string; review_type: ReviewType };

export async function reviewLessonHandler(job: Job): Promise<unknown> {
  const { lesson_id, review_type } = job.input as Input;
  if (!lesson_id) throw new Error("input.lesson_id is required");
  if (!review_type) throw new Error("input.review_type is required");
  return reviewLesson({ lesson_id, review_type, correlationId: job.id });
}
