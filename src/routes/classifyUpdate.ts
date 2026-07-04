import { Router, Request, Response } from "express";
import { randomUUID, createHash } from "crypto";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { getLLMClient } from "../llm";
import { logAiCall, formatLlmPrompt } from "../lib/aiLog";
import { assembleCatalog, renderCatalogForPrompt, type Catalog } from "../lib/classifyCatalog";
import { loadMilestoneIds, resolveMilestoneFacts } from "../lib/milestones";
import { rebuildOneUser } from "../jobs/handlers/rebuildMlp";
import { verifyAnyUser, isAdminRole, type AnyUser } from "../middleware/jwtAuth";

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

export type ClassifyInput = {
  user_id: string; child_id: string; raw_text: string;
  persist?: boolean; apply?: boolean;
  source?: string;   // user_update_events.source — 'app' for mobile, 'cms_test' for console
};

// Pick one ACTIVE variant for a template key, excluding the user's last-served
// variant for that key so acks don't repeat. Records the pick (upsert) when the
// interaction is persisted. All history I/O is non-fatal — the ack is best-effort
// and must never break a classification. Returns null if the key has no active rows.
async function selectVariant(userId: string, key: string, persist: boolean): Promise<{ id: string; template: string } | null> {
  const { data: variants, error } = await db
    .from("response_templates")
    .select("id, template")
    .eq("key", key)
    .eq("is_active", true);
  if (error || !variants || variants.length === 0) return null;

  const { data: hist } = await db
    .from("user_template_history")
    .select("last_variant_id")
    .eq("user_id", userId)
    .eq("key", key)
    .maybeSingle();
  const lastId = hist?.last_variant_id ?? undefined;

  let pool = variants.filter((v) => v.id !== lastId);
  if (pool.length === 0) pool = variants;   // single variant (or all excluded) → allow repeat
  const picked = pool[Math.floor(Math.random() * pool.length)];

  if (persist) {
    await db
      .from("user_template_history")
      .upsert({ user_id: userId, key, last_variant_id: picked.id, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
  }
  return { id: picked.id, template: picked.template };
}

// Map the classification OUTCOME to a template key, pick + render a variant. Ack
// precedence (one rule at the top): distress (strain+) leads — NO ack, the distress
// response carries the moment. Otherwise key by what was APPLIED this call.
// {milestone_name} renders milestones.LABEL, never the taxonomy name.
async function assembleAck(opts: {
  userId: string; distressTier: DistressTier;
  appliedTrackNames: string[]; recordedMilestoneNames: string[]; persist: boolean;
}): Promise<string | null> {
  if (opts.distressTier !== "none") return null;   // distress > acks, one rule
  const tracks = opts.appliedTrackNames;
  const ms = opts.recordedMilestoneNames;

  let key: string;
  if (tracks.length > 0 && ms.length > 0) key = "milestone_recorded";
  else if (tracks.length >= 2)            key = "track_added_plural";
  else if (tracks.length === 1)           key = "track_added";
  else if (ms.length > 0)                 key = "milestone_only";
  else                                    key = "nothing_matched";

  const variant = await selectVariant(opts.userId, key, opts.persist);
  if (!variant) return null;

  let milestoneLabel = "";
  if (ms.length > 0) {
    const { data: rows } = await db.from("milestones").select("name, label").in("name", ms);
    const byName = new Map((rows ?? []).map((r) => [r.name, r.label ?? r.name]));
    milestoneLabel = byName.get(ms[0]) ?? ms[0];
  }
  return variant.template
    .replace(/\{track_name\}/g, tracks[0] ?? "")
    .replace(/\{track_names\}/g, tracks.join(", "))
    .replace(/\{milestone_name\}/g, milestoneLabel);
}

export type CallerScope = { user_id: string; child_id: string; raw_text: string; persist: boolean; apply: boolean; source: string };
type ScopeResult = { ok: true; value: CallerScope } | { ok: false; status: number; code: string; message: string };

// Two caller modes for POST /classify-update (exported for the security proofs):
//  - ADMIN (console): trusts body.user_id / child_id and body persist/apply (dry-run OK).
//  - APP (any other authenticated user — a mobile parent): SELF-SCOPED. user_id is the
//    JWT's auth uid (a mismatched body.user_id is REJECTED, not silently ignored),
//    child_id must belong to that user (children.parent_id), and app semantics are
//    forced server-side: persist=true, apply=true, source='app'.
export async function resolveCallerScope(caller: AnyUser, body: Record<string, unknown>): Promise<ScopeResult> {
  const raw_text = body.raw_text;
  if (!(typeof raw_text === "string" && raw_text.trim())) {
    return { ok: false, status: 400, code: "invalid_request", message: "raw_text is required" };
  }
  const childId = typeof body.child_id === "string" ? body.child_id : undefined;

  if (isAdminRole(caller.role)) {
    const userId = typeof body.user_id === "string" ? body.user_id : undefined;
    if (!userId || !childId) {
      return { ok: false, status: 400, code: "invalid_request", message: "user_id and child_id are required" };
    }
    return { ok: true, value: { user_id: userId, child_id: childId, raw_text, persist: body.persist === true, apply: body.apply === true, source: "cms_test" } };
  }

  // APP mode — self-scope to the authenticated user.
  const userId = caller.id;
  if (typeof body.user_id === "string" && body.user_id !== userId) {
    return { ok: false, status: 403, code: "forbidden", message: "user_id does not match the authenticated user" };
  }
  if (!childId) {
    return { ok: false, status: 400, code: "invalid_request", message: "child_id is required" };
  }
  const { data: child } = await db.from("children").select("id").eq("id", childId).eq("parent_id", userId).maybeSingle();
  if (!child) {
    return { ok: false, status: 403, code: "forbidden", message: "child does not belong to the authenticated user" };
  }
  return { ok: true, value: { user_id: userId, child_id: childId, raw_text, persist: true, apply: true, source: "app" } };
}

// Core classify logic — SYNCHRONOUS, enrich-only, dry-run (§2j slice 1). Exported
// so the DoD proofs can drive it directly (the route just adds HTTP/validation).
export async function classifyUpdate(input: ClassifyInput): Promise<unknown> {
  const { user_id, child_id, raw_text, persist = false, apply = false, source = "cms_test" } = input;
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
        .insert({ user_id, child_id, raw_text, source, processing_status: "classified", correlation_id: correlationId, distress_tier: distressTier })
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

    // ACK ASSEMBLY (slice 4) — a parent-facing acknowledgment. Distress leads (strain+
    // → null); otherwise keyed by what was applied, one random active variant excluding
    // the user's last-served for that key. Additive field; null when distress or no template.
    const ack_message = await assembleAck({
      userId: user_id,
      distressTier,
      appliedTrackNames: proposed_enrichments.filter((e) => e.applied).map((e) => e.track_name ?? ""),
      recordedMilestoneNames: milestonesRecorded,
      persist: willPersist,
    });

    const prompt_version = createHash("sha256").update(promptRow.system_message).digest("hex").slice(0, 12);

    return {
      classification: { relevant, signals },
      proposed_enrichments,
      milestones_recorded: milestonesRecorded,  // names of child_milestones written this apply ([] unless apply=true)
      ack_message,                           // parent-facing ack (slice 4); null under distress or no template
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

// POST /classify-update — app-facing OR admin console. Verifies ANY signed-in
// Supabase user itself (NOT the admin-only middleware — mounted bare in index.ts),
// then self-scopes non-admin callers (resolveCallerScope). Two modes:
//  - admin  → console behavior (arbitrary user_id, dry-run allowed)
//  - app    → user_id from the token, child ownership enforced, persist+apply forced
router.post("/", async (req: Request, res: Response): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    apiError(res, 401, "unauthorized", "Missing or malformed Authorization header");
    return;
  }
  const auth = await verifyAnyUser(header.slice(7));
  if (!auth.ok) {
    apiError(res, auth.status, auth.code, auth.message);
    return;
  }

  const scope = await resolveCallerScope(auth.user, (req.body ?? {}) as Record<string, unknown>);
  if (!scope.ok) {
    apiError(res, scope.status, scope.code, scope.message);
    return;
  }

  try {
    const out = await classifyUpdate(scope.value);
    res.json(out);
  } catch (e) {
    apiError(res, 500, "classify_failed", e instanceof Error ? e.message : String(e));
  }
});

export default router;
