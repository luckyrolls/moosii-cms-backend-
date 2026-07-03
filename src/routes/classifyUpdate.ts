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
type LlmOut      = { relevant: boolean; signals: LlmSignal[]; proposed_enrichments: LlmProposal[] };

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
    const result = await client.generate({
      instructions:   promptRow.system_message,
      userPrompt,
      responseSchema: promptRow.output_schema,
      ...(promptRow.model && { model: promptRow.model }),
      ...(promptRow.temperature != null && { temperature: promptRow.temperature }),
      ...(promptRow.max_tokens != null && { maxTokens: promptRow.max_tokens }),
    });

    await logAiCall({
      correlationId,
      operation:         "classify_update",
      prompt:            formatLlmPrompt(promptRow.system_message, userPrompt),
      response:          result.raw,
      model:             result.model,
      latencyMs:         Date.now() - llmStart,
      relatedEntityType: null,
      relatedEntityId:   null,
      notes:             `catalog_version=${catalog.catalog_version}, persist=${persist}, apply=${apply}`,
    });

    let out: LlmOut;
    try {
      out = JSON.parse(result.text) as LlmOut;
    } catch {
      throw new Error(`Classifier returned non-JSON.\nRaw: ${result.text}`);
    }

    const { relevant, signals, proposed_enrichments } = applyGate(out, catalog);

    // apply=true IMPLIES persist=true: an applied classification is ALWAYS logged,
    // because provenance (user_track_activations.source_ref / child_milestones.source_ref)
    // points at a real user_update_events row — no dangling refs allowed. So we upgrade
    // persist explicitly here rather than leaving the coupling implicit downstream.
    const willPersist = persist === true || apply === true;
    let eventId: string | null = null;

    // Persist the raw event + derived signals (separate linked rows).
    if (willPersist) {
      const { data: ev, error: evErr } = await db
        .from("user_update_events")
        .insert({ user_id, child_id, raw_text, source: "cms_test", processing_status: "classified", correlation_id: correlationId })
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
    }

    // ENRICH-APPLY (slice 2): atomically add tracks (user_mlp_mods) + provenance +
    // milestone facts via apply_classification, then recompute AFTER commit.
    if (apply && eventId) {
      const nameToId = await loadMilestoneIds();
      const milestoneFacts = resolveMilestoneFacts(signals, nameToId);
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
      const res = applyRes as { proposals?: { track_id: string; applied: boolean; reason: string | null }[] } | null;
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

    const prompt_version = createHash("sha256").update(promptRow.system_message).digest("hex").slice(0, 12);

    return {
      classification: { relevant, signals },
      proposed_enrichments,
      redundant_questionnaires: [],          // SUPPRESS layer — not built (slice 3).
      // STUBBED false. MUST be replaced with a real concern/distress path BEFORE any
      // parent-facing free-text input ships: lower confidence bar, enrich-toward-support
      // only, and a possibly-concerning update must NEVER resolve to a no-op. Safe to
      // stub now ONLY because this is internal/test-only.
      distress: { detected: false },
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
