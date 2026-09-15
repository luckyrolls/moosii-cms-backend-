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
import { resolveClassification, type LlmOut, type LlmSignal, type DistressTier } from "../classify/resolve";
import { ageMonths } from "../classify/childAge";
import {
  HEALTH_BANDS, parseFindings, resolveHealthBand, renderHealthFlagsForPrompt, healthRulesVersion,
  type HealthBand, type HealthFlag, type HealthFinding, type HealthRule,
} from "../classify/healthUrgency";
import { narrowDistress } from "../classify/distressNarrowing";
import { orderResponses, type ResponseItem } from "../classify/responsePrecedence";

// The retry loop lives in src/classify/resolve.ts (unit-tested without the DB); re-exported here
// so existing importers keep working.
export { resolveClassification } from "../classify/resolve";
export type { DistressTier } from "../classify/resolve";

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

// Distress (slice B). LENIENT by design — see docs/provisional-clinical-decisions.md.
export type DistressResult = {
  detected: boolean;                 // tier !== 'none'
  tier: DistressTier;                // AFTER the symptom-only narrowing (never applied to safety)
  evidence_span: string | null;
  response: { message: string; resources: unknown } | null;  // distress_responses row; null for none
  parse_failed: boolean;             // true ONLY when the assessment was UNREADABLE after
                                     // retries and defaulted to none — a marked, audited
                                     // "we couldn't read it", NOT "assessed as none".
  downgraded_from: "strain" | "overwhelm" | null;  // set when narrowed to none (D2/D4 proposed change)
};

// Child health (migrations 080–083). Everything clinical is PROVISIONAL (H-D1..H-D9).
export type ChildHealthResult = {
  concern: boolean;
  band: HealthBand | null;           // null = no concern (or unreadable — see parse_failed)
  age_months_used: number | null;    // null = unknown age → highest band for the flag (H-D3)
  findings: HealthFinding[];
  matched_rule_ids: string[];
  unmatched_flags: string[];
  response: { message: string; resources: unknown } | null;  // health_responses row for the band
  parse_failed: boolean;             // unreadable after retries → marked + audited (H-D9)
};

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

type HealthContext = { flags: HealthFlag[]; rules: HealthRule[]; rulesVersion: string };

// The health vocabulary + rules. Returns null (health disabled for this call, logged) when the
// tables are missing or empty — so the backend tolerates a project without 080–082 (financial) or a
// prompt that predates 083.
async function loadHealthContext(): Promise<HealthContext | null> {
  const [flagsRes, rulesRes] = await Promise.all([
    db.from("health_red_flags").select("key, label, description").eq("is_active", true).order("key"),
    db.from("health_urgency_rules")
      .select("id, rule_key, red_flag_key, min_age_months, max_age_months, min_temperature_c, min_duration_hours, band")
      .eq("is_active", true),
  ]);
  if (flagsRes.error || rulesRes.error) {
    console.warn(`[classify_update] health vocabulary unavailable — child health disabled for this call: ${flagsRes.error?.message ?? rulesRes.error?.message}`);
    return null;
  }
  const flags = (flagsRes.data ?? []) as HealthFlag[];
  if (flags.length === 0) return null;
  const toNum = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
  const rules: HealthRule[] = (rulesRes.data ?? [])
    .filter((r) => (HEALTH_BANDS as string[]).includes(r.band))
    .map((r) => ({
      id: r.id, rule_key: r.rule_key, red_flag_key: r.red_flag_key,
      min_age_months: Number(r.min_age_months), max_age_months: toNum(r.max_age_months),
      min_temperature_c: toNum(r.min_temperature_c), min_duration_hours: toNum(r.min_duration_hours),
      band: r.band as HealthBand,
    }));
  return { flags, rules, rulesVersion: healthRulesVersion(flags, rules) };
}

async function loadChildAgeMonths(childId: string): Promise<number | null> {
  const { data, error } = await db.from("children").select("birth_year, birth_month").eq("id", childId).maybeSingle();
  if (error) { console.warn(`[classify_update] child age load failed (${childId}); treating age as unknown: ${error.message}`); return null; }
  return data ? ageMonths(data.birth_year, data.birth_month) : null;
}

async function loadHealthResponse(band: HealthBand): Promise<{ message: string; resources: unknown } | null> {
  const { data, error } = await db.from("health_responses").select("message, resources").eq("band", band).maybeSingle();
  if (error) { console.warn(`[classify_update] health_responses load failed (band=${band}): ${error.message}`); return null; }
  if (!data)  { console.warn(`[classify_update] no health_responses row for band=${band}`); return null; }
  return { message: data.message, resources: data.resources };
}

function schemaRequiresChildHealth(schema: Record<string, unknown>): boolean {
  const req = (schema as { required?: unknown }).required;
  return Array.isArray(req) && req.includes("child_health");
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

// Map the classification OUTCOME to a template key, pick + render a variant. Whether an ack is
// shown at all is decided by orderResponses (H-D7): suppressed under strain+ distress and under a
// same_day/emergency health band; still shown with a routine band. Otherwise key by what was
// APPLIED this call. {milestone_name} renders milestones.LABEL, never the taxonomy name.
async function assembleAck(opts: {
  userId: string; ackAllowed: boolean;
  appliedTrackNames: string[]; recordedMilestoneNames: string[]; persist: boolean;
}): Promise<string | null> {
  if (!opts.ackAllowed) return null;
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
// The mode switch is body.user_id PRESENCE, not caller role — collapsing mode and
// privilege into one signal with no ambiguous flag states:
//  - CONSOLE (a target user_id is NAMED): admin-gated. Trusts body.user_id / child_id
//    and body persist/apply (dry-run OK). A non-admin naming a target → 403.
//  - APP (NO user_id named): SELF-SCOPED to the caller's auth uid — ANY authenticated
//    caller, INCLUDING an admin testing "as a parent". child_id must belong to that
//    uid (children.parent_id) — this ownership check applies to ADMINS IDENTICALLY, no
//    role bypass. App semantics forced server-side: persist=true, apply=true. Source is
//    'app' for a real parent, 'app_internal' when the app-mode caller is an admin (so
//    internal test traffic is filterable everywhere — see decisions log D13).
export async function resolveCallerScope(caller: AnyUser, body: Record<string, unknown>): Promise<ScopeResult> {
  const raw_text = body.raw_text;
  if (!(typeof raw_text === "string" && raw_text.trim())) {
    return { ok: false, status: 400, code: "invalid_request", message: "raw_text is required" };
  }
  const childId = typeof body.child_id === "string" ? body.child_id : undefined;
  const targetUserId = typeof body.user_id === "string" ? body.user_id : undefined;

  // CONSOLE mode — naming a target user_id. Admin-gated.
  if (targetUserId) {
    if (!isAdminRole(caller.role)) {
      return { ok: false, status: 403, code: "forbidden", message: "naming a target user_id requires admin" };
    }
    if (!childId) {
      return { ok: false, status: 400, code: "invalid_request", message: "child_id is required" };
    }
    return { ok: true, value: { user_id: targetUserId, child_id: childId, raw_text, persist: body.persist === true, apply: body.apply === true, source: "cms_test" } };
  }

  // APP mode — no target named; self-scope to the authenticated caller (parent OR admin).
  const userId = caller.id;
  if (!childId) {
    return { ok: false, status: 400, code: "invalid_request", message: "child_id is required" };
  }
  const { data: child } = await db.from("children").select("id").eq("id", childId).eq("parent_id", userId).maybeSingle();
  if (!child) {
    // Ownership applies to admins identically — no role bypass.
    return { ok: false, status: 403, code: "forbidden", message: "child does not belong to the authenticated user" };
  }
  const source = isAdminRole(caller.role) ? "app_internal" : "app";
  return { ok: true, value: { user_id: userId, child_id: childId, raw_text, persist: true, apply: true, source } };
}

// Core classify logic — SYNCHRONOUS, enrich-only, dry-run (§2j slice 1). Exported
// so the DoD proofs can drive it directly (the route just adds HTTP/validation).
export async function classifyUpdate(input: ClassifyInput): Promise<unknown> {
  const { user_id, child_id, raw_text, persist = false, apply = false, source = "cms_test" } = input;
  const correlationId = randomUUID();

  {
    const [promptRow, catalog, healthLoaded, childAge] = await Promise.all([
      loadClassifyPromptRow(), assembleCatalog(), loadHealthContext(), loadChildAgeMonths(child_id),
    ]);
    // Child health runs only when BOTH the prompt asks for it (083) and the vocabulary exists (080–082).
    const health = healthLoaded && schemaRequiresChildHealth(promptRow.output_schema) ? healthLoaded : null;
    const userPrompt =
      `${renderCatalogForPrompt(catalog)}\n\n` +
      (health ? `${renderHealthFlagsForPrompt(health.flags)}\n\n` : "") +
      `PARENT UPDATE:\n"""${raw_text.trim()}"""\n\n` +
      `Classify this update against the catalog above.`;

    const provider = resolveProvider();
    const client = getLLMClient(provider);
    const llmStart = Date.now();

    // Generate + parse with normalize→retry→marked-default (see resolveClassification).
    const { out, result, distressTier: modelTier, distressParseFailed, childHealth, childHealthParseFailed, attempts } =
      await resolveClassification(
        () => client.generate({
          instructions:   promptRow.system_message,
          userPrompt,
          responseSchema: promptRow.output_schema,
          ...(promptRow.model && { model: promptRow.model }),
          ...(promptRow.temperature != null && { temperature: promptRow.temperature }),
          ...(promptRow.max_tokens != null && { maxTokens: promptRow.max_tokens }),
        }),
        3,
        { expectChildHealth: !!health },
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
      notes:             `catalog_version=${catalog.catalog_version}, health_rules_version=${health?.rulesVersion ?? "-"}, persist=${persist}, apply=${apply}, attempts=${attempts}`,
    });

    const { relevant, signals, proposed_enrichments } = applyGate(out, catalog);

    // Resolve milestone facts from the gated signals ONCE (the type + polarity
    // gates live inside resolveMilestoneFacts). Used both by apply (to WRITE
    // child_milestones) and by the redundant-questionnaire report (slice 3).
    const milestoneFacts =
      signals.length > 0 ? resolveMilestoneFacts(signals, await loadMilestoneIds()) : [];

    // CHILD HEALTH (080–083) — extraction from the model, band from code (age + rules).
    let childHealthResult: ChildHealthResult | null = null;
    let unknownFlags: string[] = [];
    if (health) {
      if (childHealthParseFailed || !childHealth) {
        childHealthResult = { concern: false, band: null, age_months_used: childAge, findings: [], matched_rule_ids: [], unmatched_flags: [], response: null, parse_failed: true };
      } else {
        const parsed = parseFindings(childHealth, new Set(health.flags.map((f) => f.key)));
        unknownFlags = parsed.unknown_flags;
        const concern = childHealth.concern || parsed.findings.length > 0;
        const resolved = resolveHealthBand(concern, parsed.findings, childAge, health.rules);
        childHealthResult = {
          concern,
          band: resolved.band,
          age_months_used: childAge,
          findings: parsed.findings,
          matched_rule_ids: resolved.matched_rule_ids,
          unmatched_flags: resolved.unmatched_flags,
          response: resolved.band ? await loadHealthResponse(resolved.band) : null,
          parse_failed: false,
        };
      }
    }

    // DISTRESS (slice B) — a SEPARATE output, computed on every classification and
    // fully independent of signals/proposals/apply. Tier + parse_failed were resolved
    // in the retry loop above (LENIENT, no silent-none). evidence is null on a parse
    // failure (there was no readable assessment to quote). Then the symptom-only backstop
    // (D2/D4 proposed change): strain/overwhelm whose evidence is only the child's symptom
    // wording is narrowed to none, MARKED + audited. Safety passes through untouched.
    const modelEvidence =
      !distressParseFailed && out.distress?.evidence_span?.trim() ? out.distress.evidence_span : null;
    const healthSpans = childHealth
      ? [childHealth.symptom_span, ...childHealth.findings.map((f) => f.evidence_span ?? "")]
      : [];
    const narrowed = narrowDistress(modelTier, modelEvidence, healthSpans);
    const distressTier = narrowed.tier;
    const distressEvidence = distressTier === "none" && !narrowed.downgraded_from ? null : modelEvidence;
    const distress: DistressResult = {
      detected: distressTier !== "none",
      tier: distressTier,
      evidence_span: distressTier === "none" ? null : distressEvidence,
      response: await loadDistressResponse(distressTier),
      parse_failed: distressParseFailed,
      downgraded_from: narrowed.downgraded_from,
    };

    // PRECEDENCE (H-D7): safety > emergency > same_day > overwhelm/strain > routine > ack.
    const order = orderResponses({
      distressTier,
      distressResponse: distress.response,
      healthBand: childHealthResult?.band ?? null,
      healthResponse: childHealthResult?.response ?? null,
    });
    const responses: ResponseItem[] = order.responses;

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
        .insert({
          user_id, child_id, raw_text, source, processing_status: "classified", correlation_id: correlationId,
          distress_tier: distressTier,
          ...(health && { health_band: childHealthResult?.band ?? null }),
        })
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
      // Safety audit (item-10 analog): a strain+ detection, an UNREADABLE assessment
      // (parse_failed), or a symptom-only DOWNGRADE (downgraded_from). Logged LOUDLY on failure
      // but never throws — the event already carries distress_tier as a fallback, and a failed
      // audit must not break a response already carrying the support content.
      if (eventId && (distressTier !== "none" || distressParseFailed || narrowed.downgraded_from)) {
        const { error: ddErr } = await db.from("distress_detections").insert({
          event_id: eventId, user_id, child_id, tier: distressTier,
          evidence_span: distressEvidence, correlation_id: correlationId,
          parse_failed: distressParseFailed,
          ...(narrowed.downgraded_from && { downgraded_from: narrowed.downgraded_from }),
        });
        if (ddErr) console.error(`[classify_update] SAFETY AUDIT WRITE FAILED (tier=${distressTier}, parse_failed=${distressParseFailed}, downgraded_from=${narrowed.downgraded_from}, event=${eventId}): ${ddErr.message}`);
      }
      // Child-health audit: a band, or an unreadable assessment. Never a silent "no concern" row.
      if (eventId && childHealthResult && (childHealthResult.band || childHealthResult.parse_failed)) {
        const { error: hdErr } = await db.from("health_detections").insert({
          event_id: eventId, user_id, child_id,
          band: childHealthResult.band,
          child_age_months: childAge,
          findings: childHealthResult.findings as never,
          matched_rule_ids: childHealthResult.matched_rule_ids,
          unmatched_flags: childHealthResult.unmatched_flags,
          unknown_flags: unknownFlags,
          rules_version: health?.rulesVersion ?? null,
          parse_failed: childHealthResult.parse_failed,
          correlation_id: correlationId,
        });
        if (hdErr) console.error(`[classify_update] HEALTH AUDIT WRITE FAILED (band=${childHealthResult.band}, parse_failed=${childHealthResult.parse_failed}, event=${eventId}): ${hdErr.message}`);
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

    // ACK ASSEMBLY (slice 4) — a parent-facing acknowledgment, shown only when orderResponses
    // allows it (H-D7); keyed by what was applied, one random active variant excluding the
    // user's last-served for that key. null when suppressed or no template.
    const ack_message = await assembleAck({
      userId: user_id,
      ackAllowed: order.ackAllowed,
      appliedTrackNames: proposed_enrichments.filter((e) => e.applied).map((e) => e.track_name ?? ""),
      recordedMilestoneNames: milestonesRecorded,
      persist: willPersist,
    });

    const prompt_version = createHash("sha256").update(promptRow.system_message).digest("hex").slice(0, 12);

    return {
      classification: { relevant, signals },
      proposed_enrichments,
      milestones_recorded: milestonesRecorded,  // names of child_milestones written this apply ([] unless apply=true)
      ack_message,                           // parent-facing ack (slice 4); null when suppressed (H-D7) or no template
      redundant_questionnaires,              // SUPPRESS (slice 3): questionnaires made redundant by this update.
      // DISTRESS (slice B) — PROVISIONAL: detection live, content provisional, app
      // delivery is slice 4. detected = tier !== 'none'; response is the
      // distress_responses row (null for none). See docs/provisional-clinical-decisions.md.
      distress,
      // CHILD HEALTH (080–083) — PROVISIONAL. null when not configured on this project/prompt.
      child_health: childHealthResult,
      // Parent-facing support responses in precedence order (H-D7). [] when none.
      responses,
      provenance: {
        model:           result.model,
        prompt_version,
        catalog_version: catalog.catalog_version,
        correlation_id:  correlationId,
        health_rules_version: health?.rulesVersion ?? null,
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
