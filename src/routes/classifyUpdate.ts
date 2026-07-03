import { Router, Request, Response } from "express";
import { randomUUID, createHash } from "crypto";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { getLLMClient } from "../llm";
import { logAiCall, formatLlmPrompt } from "../lib/aiLog";
import { assembleCatalog, renderCatalogForPrompt, type Catalog } from "../lib/classifyCatalog";
import { loadMilestoneIds, resolveMilestoneFacts } from "../lib/milestones";
import { rebuildOneUser } from "../jobs/handlers/rebuildMlp";

const db = supabase;

const router = Router();

// Below this, a signal/proposal is treated as no-signal (§2j confidence floor).
const CONFIDENCE_FLOOR = 0.6;

function resolveProvider(): "openai" | "gemini" {
  const p = (process.env.CLASSIFY_WRITER || "openai").toLowerCase();
  if (p !== "openai" && p !== "gemini") throw new Error(`Invalid CLASSIFY_WRITER="${p}" (expected "openai" | "gemini")`);
  return p;
}

type ClassifyPromptRow = {
  id: string;
  system_message: string;
  output_schema: Record<string, unknown>;
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
};

async function loadClassifyPromptRow(): Promise<ClassifyPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, output_schema, model, temperature, max_tokens")
    .eq("prompt_type", "classify_update")
    .eq("is_active", true)
    .single();
  if (error || !data) throw new Error(`No active classify_update prompt row: ${error?.message ?? "not found"}`);
  if (!data.system_message) throw new Error("classify_update prompt has no system_message");
  if (!data.output_schema)  throw new Error("classify_update prompt has no output_schema");
  return data as ClassifyPromptRow;
}

type LlmSignal   = { type: string; value: string; confidence: number; evidence_span: string };
type LlmProposal = { track_id: string; confidence: number; source_signal: string };
type LlmDistress = { tier: string; evidence_span: string };
type LlmOut      = { relevant: boolean; signals: LlmSignal[]; proposed_enrichments: LlmProposal[]; distress?: LlmDistress };

// Distress (slice B). LENIENT by design — see docs/provisional-clinical-decisions.md.
export type DistressTier = "none" | "strain" | "overwhelm" | "safety";
const DISTRESS_TIERS: DistressTier[] = ["none", "strain", "overwhelm", "safety"];
export type DistressResult = {
  detected: boolean;                 // tier !== 'none'
  tier: DistressTier;
  evidence_span: string | null;
  response: { message: string; resources: unknown } | null;  // distress_responses row; null for none
  parse_failed: boolean;             // true ONLY when the assessment was UNREADABLE after
                                     // retries and defaulted to none — a marked, audited
                                     // "we couldn't read it", NOT "assessed as none".
};

// Recover a near-miss tier ("Safety", "SAFETY ", "overwhelm.") to a canonical value.
// Returns null ONLY when the value is genuinely unreadable — the caller RE-ASKS on
// null (never silently defaults), because a garbled safety read must not become none.
function normalizeTier(raw: unknown): DistressTier | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase().replace(/[^a-z]/g, "");  // case + trailing junk/space/punct
  return (DISTRESS_TIERS as string[]).includes(t) ? (t as DistressTier) : null;
}

type GenResult = { text: string; raw: unknown; model: string };

// The normalize → retry → marked-default loop, with the generator INJECTED so it is
// deterministically testable without a live LLM (P6). A response is "good" only when
// it parses AND its distress tier is readable (after normalization). An unreadable
// distress object is a FAILED generation — re-asked up to `attemptsMax` (same
// discipline as generate_questionnaire) — because defaulting a garbled read to none
// would violate the slice's core asymmetry (false negatives are the failure mode).
// Only after exhausting retries do we default to none, and we MARK it (parse_failed).
export async function resolveClassification(
  generate: () => Promise<GenResult>,
  attemptsMax = 3,
): Promise<{ out: LlmOut; result: GenResult; distressTier: DistressTier; distressParseFailed: boolean; attempts: number }> {
  let out: LlmOut | null = null;   // latest VALID-JSON parse (usable for signals/proposals)
  let result!: GenResult;
  let attempts = 0;
  for (attempts = 1; attempts <= attemptsMax; attempts++) {
    result = await generate();
    let parsed: LlmOut;
    try {
      parsed = JSON.parse(result.text) as LlmOut;
    } catch {
      console.warn(`[classify_update] attempt ${attempts}: non-JSON response — re-asking`);
      continue;
    }
    out = parsed;  // keep even if distress is unreadable (signals/proposals still usable)
    const tier = normalizeTier(parsed.distress?.tier);
    if (tier === null) {
      console.warn(`[classify_update] attempt ${attempts}: distress tier unreadable (${JSON.stringify(parsed.distress?.tier)}) — re-asking`);
      continue;
    }
    return { out, result, distressTier: tier, distressParseFailed: false, attempts };
  }
  // Never got valid JSON at all — a hard failure (as before).
  if (out === null) {
    throw new Error(`Classifier returned non-JSON after ${attemptsMax} attempts.\nRaw: ${result.text}`);
  }
  // JSON parsed but distress stayed unreadable across all attempts: default to none,
  // MARKED distinctly so review tells "assessed none" from "couldn't read it".
  console.error(`[classify_update] distress UNREADABLE after ${attemptsMax} attempts — defaulting tier=none WITH parse_failed marker`);
  return { out, result, distressTier: "none", distressParseFailed: true, attempts: attemptsMax };
}

// The provisional response content for a tier (null for none). Non-throwing.
async function loadDistressResponse(tier: DistressTier): Promise<{ message: string; resources: unknown } | null> {
  if (tier === "none") return null;
  const { data, error } = await db
    .from("distress_responses")
    .select("message, resources")
    .eq("tier", tier)
    .maybeSingle();
  if (error) { console.warn(`[classify_update] distress_responses load failed (tier=${tier}): ${error.message}`); return null; }
  if (!data)  { console.warn(`[classify_update] no distress_responses row for tier=${tier}`); return null; }
  return { message: data.message as string, resources: data.resources };
}

export type Enrichment = {
  action: "activate_track"; track_id: string; track_name: string | null;
  confidence: number; source_signal: string;
  applied: boolean;        // true when apply=true actually activated it this run
  reason?: string;         // on skips: 'already_active' | 'manual_override'
};

// Confidence floor + anti-hallucination gate. Not relevant → clean no-signal.
// Otherwise drop below-floor signals/proposals, and DROP any proposal whose
// track_id isn't in the real catalog. Exported so the gate is unit-testable.
export function applyGate(out: LlmOut, catalog: Catalog, floor = CONFIDENCE_FLOOR): {
  relevant: boolean; signals: LlmSignal[]; proposed_enrichments: Enrichment[];
} {
  if (!out.relevant) return { relevant: false, signals: [], proposed_enrichments: [] };
  const trackNameById = new Map(catalog.tracks.map((t) => [t.id, t.name]));
  const signals = (out.signals ?? []).filter((s) => typeof s.confidence === "number" && s.confidence >= floor);
  const proposed_enrichments: Enrichment[] = (out.proposed_enrichments ?? [])
    .filter((p) => typeof p.confidence === "number" && p.confidence >= floor && trackNameById.has(p.track_id))
    .map((p) => ({ action: "activate_track", track_id: p.track_id, track_name: trackNameById.get(p.track_id) ?? null, confidence: p.confidence, source_signal: p.source_signal, applied: false }));
  return { relevant: signals.length > 0, signals, proposed_enrichments };
}

export type RedundantQuestionnaire = {
  questionnaire_id: string;
  questionnaire_name: string | null;
  milestone_id: string;
};

// Slice 3 SUPPRESS — questionnaires mapped (questionnaire.milestone_id) to any of
// the given milestone ids, i.e. made redundant by this update. Read-only and
// non-throwing: on any error it reports NONE (the report never blocks or breaks a
// classify).
export async function findRedundantQuestionnaires(milestoneIds: string[]): Promise<RedundantQuestionnaire[]> {
  const ids = [...new Set(milestoneIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from("questionnaire")
    .select("id, questionnaire_name, milestone_id")
    .in("milestone_id", ids);
  if (error) {
    console.warn(`[classify_update] redundant-questionnaire lookup failed: ${error.message}`);
    return [];
  }
  return (data ?? [])
    .filter((q): q is typeof q & { milestone_id: string } => q.milestone_id !== null)
    .map((q) => ({
      questionnaire_id: q.id,
      questionnaire_name: q.questionnaire_name,
      milestone_id: q.milestone_id,
    }));
}

export type ClassifyInput = { user_id: string; child_id: string; raw_text: string; persist?: boolean; apply?: boolean };

// Core classify logic — SYNCHRONOUS, enrich-only, dry-run (§2j slice 1). Exported
// so the DoD proofs can drive it directly (the route just adds HTTP/validation).
export async function classifyUpdate(input: ClassifyInput): Promise<unknown> {
  const { user_id, child_id, raw_text, persist = false, apply = false } = input;
  const correlationId = randomUUID();

  {
    const promptRow = await loadClassifyPromptRow();
    const catalog = await assembleCatalog();
    const userPrompt =
      `${renderCatalogForPrompt(catalog)}\n\n` +
      `PARENT UPDATE:\n"""${raw_text.trim()}"""\n\n` +
      `Classify this update against the catalog above.`;

    const provider = resolveProvider();
    const client = getLLMClient(provider);
    const llmStart = Date.now();

    // Generate + parse with normalize→retry→marked-default (see resolveClassification).
    const { out, result, distressTier, distressParseFailed, attempts } = await resolveClassification(
      () => client.generate({
        instructions:   promptRow.system_message,
        userPrompt,
        responseSchema: promptRow.output_schema,
        ...(promptRow.model && { model: promptRow.model }),
        ...(promptRow.temperature != null && { temperature: promptRow.temperature }),
        ...(promptRow.max_tokens != null && { maxTokens: promptRow.max_tokens }),
      }),
    );

    await logAiCall({
      correlationId,
      operation:         "classify_update",
      prompt:            formatLlmPrompt(promptRow.system_message, userPrompt),
      response:          result.raw,
      model:             result.model,
      latencyMs:         Date.now() - llmStart,
      relatedEntityType: null,
      relatedEntityId:   null,
      notes:             `catalog_version=${catalog.catalog_version}, persist=${persist}, apply=${apply}, attempts=${attempts}`,
    });

    const { relevant, signals, proposed_enrichments } = applyGate(out, catalog);

    // Resolve milestone facts from the gated signals ONCE (the type + polarity
    // gates live inside resolveMilestoneFacts). Used both by apply (to WRITE
    // child_milestones) and by the redundant-questionnaire report (slice 3).
    const milestoneFacts =
      signals.length > 0 ? resolveMilestoneFacts(signals, await loadMilestoneIds()) : [];

    // DISTRESS (slice B) — a SEPARATE output, computed on every classification and
    // fully independent of signals/proposals/apply. Tier + parse_failed were resolved
    // in the retry loop above (LENIENT, no silent-none). evidence is null on a parse
    // failure (there was no readable assessment to quote).
    const distressEvidence =
      !distressParseFailed && out.distress?.evidence_span?.trim() ? out.distress.evidence_span : null;
    const distress: DistressResult = {
      detected: distressTier !== "none",
      tier: distressTier,
      evidence_span: distressEvidence,
      response: await loadDistressResponse(distressTier),
      parse_failed: distressParseFailed,
    };

    // apply=true IMPLIES persist=true: an applied classification is ALWAYS logged,
    // because provenance (user_track_activations.source_ref / child_milestones.source_ref)
    // points at a real user_update_events row — no dangling refs allowed. So we upgrade
    // persist explicitly here rather than leaving the coupling implicit downstream.
    const willPersist = persist === true || apply === true;
    let eventId: string | null = null;
    let milestonesRecorded: string[] = [];   // names of child_milestones newly written this apply

    // Persist the raw event + derived signals (separate linked rows). The distress
    // tier lands on the event; every strain+ detection also writes an audit row.
    if (willPersist) {
      const { data: ev, error: evErr } = await db
        .from("user_update_events")
        .insert({ user_id, child_id, raw_text, source: "cms_test", processing_status: "classified", correlation_id: correlationId, distress_tier: distressTier })
        .select("id").single();
      if (evErr) throw new Error(`Failed to write user_update_events: ${evErr.message}`);
      eventId = ev?.id ?? null;
      if (eventId && signals.length > 0) {
        const evId = eventId;
        const trackBySignalValue = new Map(proposed_enrichments.map((p) => [p.source_signal, p.track_id]));
        const rows = signals.map((s) => ({
          event_id:         evId,
          type:             s.type,
          value:            s.value,
          confidence:       s.confidence,
          evidence_span:    s.evidence_span,
          matched:          trackBySignalValue.has(s.value),
          matched_track_id: trackBySignalValue.get(s.value) ?? null,
        }));
        const { error: sErr } = await db.from("user_update_signals").insert(rows);
        if (sErr) throw new Error(`Failed to write user_update_signals: ${sErr.message}`);
      }
      // Safety audit (item-10 analog): a strain+ detection OR an UNREADABLE assessment
      // (parse_failed — the distinction a safety audit exists to preserve). Logged
      // LOUDLY on failure but never throws — the event already carries distress_tier
      // as a fallback, and a failed audit must not break a response already carrying
      // the support content.
      if (eventId && (distressTier !== "none" || distressParseFailed)) {
        const { error: ddErr } = await db.from("distress_detections").insert({
          event_id: eventId, user_id, child_id, tier: distressTier,
          evidence_span: distressEvidence, correlation_id: correlationId,
          parse_failed: distressParseFailed,
        });
        if (ddErr) console.error(`[classify_update] SAFETY AUDIT WRITE FAILED (tier=${distressTier}, parse_failed=${distressParseFailed}, event=${eventId}): ${ddErr.message}`);
      }
    }

    // ENRICH-APPLY (slice 2): atomically add tracks (user_mlp_mods) + provenance +
    // milestone facts via apply_classification, then recompute AFTER commit.
    if (apply && eventId) {
      const { data: applyRes, error: applyErr } = await db.rpc("apply_classification", {
        p_user_id:    user_id,
        p_child_id:   child_id,
        p_event_id:   eventId,
        p_proposals:  proposed_enrichments.map((p) => ({ track_id: p.track_id, confidence: p.confidence, source_signal: p.source_signal })),
        p_milestones: milestoneFacts,
      });
      if (applyErr) throw new Error(`apply_classification failed: ${applyErr.message}`);

      // Map per-proposal outcome (applied / skip reason) back onto the enrichments.
      // rpc returns Json, so narrow it to the fn's documented shape.
      const res = applyRes as {
        proposals?: { track_id: string; applied: boolean; reason: string | null }[];
        milestones_recorded?: string[];
      } | null;
      milestonesRecorded = res?.milestones_recorded ?? [];
      const outcome = new Map<string, { applied: boolean; reason: string | null }>(
        (res?.proposals ?? []).map((p) => [p.track_id, { applied: p.applied, reason: p.reason }]),
      );
      for (const e of proposed_enrichments) {
        const o = outcome.get(e.track_id);
        if (o) { e.applied = o.applied; if (!o.applied && o.reason) e.reason = o.reason; }
      }

      // Recompute AFTER the transaction commits — retryable; a rebuild failure must
      // NOT roll back the apply (it's already committed), but is logged loudly for retry.
      try {
        await rebuildOneUser(user_id);
      } catch (e) {
        console.error(`[classify_update] apply committed but MLP rebuild FAILED for user ${user_id} (retryable): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // SUPPRESS (slice 3): questionnaires this update makes redundant — those mapped
    // (questionnaire.milestone_id) to a milestone the update resolves. With apply=true
    // those milestones are now recorded facts; with apply=false the report is
    // PROJECTED from the proposed facts (clearly derived, no writes). Stable shape,
    // [] when none. Read-only and non-throwing (report none rather than fail).
    const redundant_questionnaires = await findRedundantQuestionnaires(
      milestoneFacts.map((f) => f.milestone_id)
    );

    const prompt_version = createHash("sha256").update(promptRow.system_message).digest("hex").slice(0, 12);

    return {
      classification: { relevant, signals },
      proposed_enrichments,
      milestones_recorded: milestonesRecorded,  // names of child_milestones written this apply ([] unless apply=true)
      redundant_questionnaires,              // SUPPRESS (slice 3): questionnaires made redundant by this update.
      // DISTRESS (slice B) — PROVISIONAL: detection live, content provisional, app
      // delivery is slice 4. detected = tier !== 'none'; response is the
      // distress_responses row (null for none). See docs/provisional-clinical-decisions.md.
      distress,
      provenance: {
        model:           result.model,
        prompt_version,
        catalog_version: catalog.catalog_version,
        correlation_id:  correlationId,
      },
    };
  }
}

// POST /classify-update — thin HTTP wrapper: validate, call the core, map errors.
router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { user_id, child_id, raw_text, persist, apply } =
    (req.body ?? {}) as { user_id?: string; child_id?: string; raw_text?: string; persist?: boolean; apply?: boolean };

  if (!user_id || !child_id || !(typeof raw_text === "string" && raw_text.trim())) {
    apiError(res, 400, "invalid_request", "user_id, child_id, and raw_text are required");
    return;
  }

  try {
    const out = await classifyUpdate({ user_id, child_id, raw_text, persist, apply });
    res.json(out);
  } catch (e) {
    apiError(res, 500, "classify_failed", e instanceof Error ? e.message : String(e));
  }
});

export default router;
