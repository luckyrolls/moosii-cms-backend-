import { factProvenance, type Provenance } from "./outcomes";

// Demo partner page data (api-contract §9c) — the PURE half. Two routes, both FINANCIAL ONLY, both authed by the
// DEMO SESSION (the Supabase session /demo/session minted; the persona comes from the token, never a param):
//   GET /demo/partner-data     → { persona, spending, insights }
//   GET /demo/mx-widget-url    → a fresh single-use MX widget URL (allowlisted types only)
// Gates, in order (each a distinct answer):
//   1. DOMAIN ≠ financial                  → 404 not_found
//   2. per-IP rate limit                   → 429 rate_limited
//   3. no / invalid bearer token           → 401 unauthorized
//   4. user carries no demo_persona        → 403 not_demo_persona
// I/O is injected so every gate, the spending summary and the insight rules are unit-tested.

export type DemoIdentity = { user_id: string; persona: string };

export type GateDeps = {
  domain: string;
  limiter: { allow(key: string): boolean };
  // Verifies a Supabase access token; returns the user id and app_metadata.demo_persona (null if unset),
  // or null when the token is not valid.
  verify(token: string): Promise<{ user_id: string; persona: string | null } | null>;
};

export type GateRefusal = { status: 401 | 403 | 404 | 429; code: string; message: string };

export function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

export async function demoGate(authHeader: unknown, ip: string, deps: GateDeps): Promise<DemoIdentity | GateRefusal> {
  if (deps.domain !== "financial") return { status: 404, code: "not_found", message: "not found" };
  if (!deps.limiter.allow(ip)) return { status: 429, code: "rate_limited", message: "too many demo requests — wait a minute" };
  const token = bearerToken(authHeader);
  if (!token) return { status: 401, code: "unauthorized", message: "Authorization: Bearer <demo session token> is required" };
  const who = await deps.verify(token);
  if (!who) return { status: 401, code: "unauthorized", message: "invalid or expired session" };
  if (!who.persona) return { status: 403, code: "not_demo_persona", message: "this user is not a demo persona" };
  return { user_id: who.user_id, persona: who.persona };
}

export function isRefusal(x: DemoIdentity | GateRefusal): x is GateRefusal {
  return "status" in x;
}

// ---------------------------------------------------------------------------------------------------------------
// Spending — the persona's MX transactions for the last 30 days, grouped by MX top-level category.
// Counted: DEBITs dated inside the window. Not counted: CREDITs (income, refunds) and top_level_category
// 'Transfer' (moves between the user's own accounts and card payments — same exclusion as facts derive).
// ---------------------------------------------------------------------------------------------------------------

export const SPENDING_WINDOW_DAYS = 30;

export type SpendingTxn = {
  type: string;
  amount?: number | null;
  top_level_category?: string | null;
  transacted_at?: string | null;
  posted_at?: string | null;
  date?: string | null;
};

export type Spending = {
  source: "mx";
  from: string;              // YYYY-MM-DD (inclusive)
  to: string;                // YYYY-MM-DD (inclusive)
  total: number;
  transactions: number;
  categories: { category: string; amount: number; share: number }[];   // share 0..1, 3 dp; sorted by amount desc
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function spendingWindowStart(now: Date): Date {
  return new Date(now.getTime() - SPENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export function summarizeSpending(txns: SpendingTxn[], now: Date): Spending {
  const from = spendingWindowStart(now);
  const byCat = new Map<string, number>();
  let n = 0;
  for (const t of txns) {
    if ((t.type ?? "").toUpperCase() !== "DEBIT") continue;
    if ((t.top_level_category ?? "") === "Transfer") continue;
    const when = Date.parse(t.transacted_at ?? t.date ?? t.posted_at ?? "");
    if (!Number.isFinite(when) || when < from.getTime() || when > now.getTime()) continue;
    const amt = Math.abs(Number(t.amount ?? 0));
    if (!Number.isFinite(amt) || amt === 0) continue;
    const cat = t.top_level_category?.trim() || "Uncategorized";
    byCat.set(cat, (byCat.get(cat) ?? 0) + amt);
    n++;
  }
  const total = [...byCat.values()].reduce((a, b) => a + b, 0);
  const categories = [...byCat.entries()]
    .map(([category, amount]) => ({ category, amount: round2(amount), share: total ? Math.round((amount / total) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
  return { source: "mx", from: ymd(from), to: ymd(now), total: round2(total), transactions: n, categories };
}

// ---------------------------------------------------------------------------------------------------------------
// Insights — derived from the persona's CURRENT facts (user_facts_latest), never hardcoded per persona.
// Keys are the partner insight vocabulary the reader resolves at /learn?insight=<key> (MX template names).
// Copy is ours, plain, and carries NO amounts. `source` follows the fact's provenance (seed → seeded).
// ---------------------------------------------------------------------------------------------------------------

export type CurrentFact = { fact_key: string; value: string; source: string };
export type Insight = { key: string; title: string; body: string; source: Provenance; fact_key: string };

const INSIGHT_RULES: { fact_key: string; value: string; key: string; title: string; body: string }[] = [
  { fact_key: "credit_utilization_band", value: "high", key: "CreditCardCloseToLimit",
    title: "One of your cards is near its limit",
    body: "Your card balances are using most of your available credit. Bringing them down can help your credit score." },
  { fact_key: "credit_utilization_band", value: "moderate", key: "CreditUtilization",
    title: "Card use is creeping up",
    body: "Your card balances are a noticeable share of your credit limits. Paying before the statement date keeps the reported balance lower." },
  // Proposed key (2026-10-01): the reader has no buffer key yet — SaveEnoughToLiveOn is MX's template name.
  { fact_key: "has_emergency_buffer", value: "false", key: "SaveEnoughToLiveOn",
    title: "No cushion for surprises yet",
    body: "There isn't much set aside for an unexpected bill. A small automatic transfer each payday can start one." },
  { fact_key: "new_subscription_recent", value: "true", key: "SubscriptionDetected",
    title: "A new subscription showed up",
    body: "A new recurring charge started recently. Worth a quick check that it's one you meant to keep." },
];

export function insightsFromFacts(facts: CurrentFact[]): Insight[] {
  const out: Insight[] = [];
  for (const r of INSIGHT_RULES) {
    const f = facts.find((x) => x.fact_key === r.fact_key);
    if (f && f.value === r.value) {
      out.push({ key: r.key, title: r.title, body: r.body, source: factProvenance(f.source), fact_key: r.fact_key });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// MX widget URL — allowlist only. The URL is a one-time credential: generated per request, never logged,
// stored or cached (the route sets Cache-Control: no-store).
// ---------------------------------------------------------------------------------------------------------------

export const WIDGET_ALLOWLIST = ["connections_widget"] as const;
export type AllowedWidget = (typeof WIDGET_ALLOWLIST)[number];

export function allowedWidgetType(type: unknown): AllowedWidget | null {
  return typeof type === "string" && (WIDGET_ALLOWLIST as readonly string[]).includes(type) ? (type as AllowedWidget) : null;
}
