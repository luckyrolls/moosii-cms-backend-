// Fact derivation rules — PURE (no network, no DB, no env). FINDINGS-fact-derivation.md §2;
// thresholds decided by Mark 2026-09-28. Every fact is a boolean or a short enum: the amounts,
// balances and ratios computed here exist only in memory and are NEVER returned (invariant 12) —
// `evidence` carries counts and day spans only.
//
// "unknown" means: write no row for that key (075 convention). The reason says why.

export const RULE_VERSION = "facts-derive/1";

export type MxAccount = {
  guid: string;
  type: string;                        // CHECKING | SAVINGS | CREDIT_CARD | LOAN | …
  is_closed?: boolean | null;
  balance?: number | null;
  available_balance?: number | null;
  credit_limit?: number | null;
  available_credit?: number | null;
};

export type MxTransaction = {
  guid: string;
  account_guid: string;
  type: string;                        // CREDIT | DEBIT
  status?: string | null;              // POSTED | PENDING
  amount?: number | null;
  transacted_at?: string | null;
  posted_at?: string | null;
  date?: string | null;
  is_direct_deposit?: boolean | null;
  is_subscription?: boolean | null;
  merchant_guid?: string | null;
  description?: string | null;
  top_level_category?: string | null;
};

export type FactKey = "has_direct_deposit" | "has_emergency_buffer" | "new_subscription_recent" | "credit_utilization_band";

export type FactResult = {
  fact_key: FactKey;
  value: string | null;                // null = unknown → no row
  estimated: boolean;                  // true → stamped source 'estimated'
  reason: string;                      // why this value (or why unknown)
  evidence: Record<string, number>;    // counts / day spans only — never money
};

export type DeriveInput = { accounts: MxAccount[]; transactions: MxTransaction[]; asOf: Date };

// ---- thresholds (Mark, 2026-09-28) -------------------------------------------------------------
export const DIRECT_DEPOSIT_WINDOW_DAYS = 60;
export const DIRECT_DEPOSIT_MIN_DATES = 2;
export const MIN_HISTORY_DAYS = 60;                 // direct deposit + buffer
export const BUFFER_SPEND_WINDOW_DAYS = 90;
export const BUFFER_MONTHS = 1;                     // liquid ≥ 1 × monthly spend
export const SUBSCRIPTION_NEW_WINDOW_DAYS = 30;
export const SUBSCRIPTION_MIN_HISTORY_DAYS = 90;    // §2.3 option A: 30-day window + 60-day baseline
export const UTILIZATION_MODERATE = 0.2;            // low < 20%
export const UTILIZATION_HIGH = 0.3;                // moderate 20–<30%, high ≥ 30%

const DAY_MS = 86_400_000;
const DEPOSIT_TYPES = new Set(["CHECKING", "SAVINGS"]);

function isOpen(a: MxAccount): boolean {
  return a.is_closed !== true;
}

function txTime(t: MxTransaction): number | null {
  const raw = t.transacted_at ?? t.posted_at ?? t.date ?? null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function isPosted(t: MxTransaction): boolean {
  return (t.status ?? "POSTED") === "POSTED";
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Days between the earliest and latest dated POSTED transaction in `txs` (0 when fewer than two).
export function historyDays(txs: MxTransaction[]): number {
  const times = txs.filter(isPosted).map(txTime).filter((x): x is number => x !== null);
  if (times.length < 2) return 0;
  return Math.floor((Math.max(...times) - Math.min(...times)) / DAY_MS);
}

function unknown(fact_key: FactKey, reason: string, evidence: Record<string, number> = {}): FactResult {
  return { fact_key, value: null, estimated: false, reason, evidence };
}

function known(fact_key: FactKey, value: string, reason: string, evidence: Record<string, number>, estimated = false): FactResult {
  return { fact_key, value, estimated, reason, evidence };
}

// ---- has_direct_deposit ------------------------------------------------------------------------
// true: ≥ 2 is_direct_deposit CREDITs on distinct dates in the last 60 days, on checking/savings.
export function deriveHasDirectDeposit({ accounts, transactions, asOf }: DeriveInput): FactResult {
  const deposit = new Set(accounts.filter((a) => isOpen(a) && DEPOSIT_TYPES.has(a.type)).map((a) => a.guid));
  if (deposit.size === 0) return unknown("has_direct_deposit", "no_deposit_account");
  const txs = transactions.filter((t) => deposit.has(t.account_guid) && isPosted(t));
  const history = historyDays(txs);
  if (history < MIN_HISTORY_DAYS) return unknown("has_direct_deposit", "history_too_short", { history_days: history });
  if (txs.every((t) => t.is_direct_deposit === null || t.is_direct_deposit === undefined)) {
    return unknown("has_direct_deposit", "flag_unavailable", { history_days: history });
  }
  const since = asOf.getTime() - DIRECT_DEPOSIT_WINDOW_DAYS * DAY_MS;
  const dates = new Set<string>();
  for (const t of txs) {
    const ms = txTime(t);
    if (t.is_direct_deposit === true && t.type === "CREDIT" && ms !== null && ms >= since && ms <= asOf.getTime()) dates.add(utcDay(ms));
  }
  const evidence = { deposit_accounts: deposit.size, direct_deposit_dates_60d: dates.size, history_days: history };
  return dates.size >= DIRECT_DEPOSIT_MIN_DATES
    ? known("has_direct_deposit", "true", "recurring_direct_deposit", evidence)
    : known("has_direct_deposit", "false", "no_recurring_direct_deposit", evidence);
}

// ---- has_emergency_buffer ----------------------------------------------------------------------
// true: liquid (checking + savings) ≥ BUFFER_MONTHS × monthly spend, where monthly spend is the
// qualifying DEBITs over the last 90 days (or the available history if shorter), excluding
// transfers between the user's own accounts and card payments (top_level_category 'Transfer').
export function deriveHasEmergencyBuffer({ accounts, transactions, asOf }: DeriveInput): FactResult {
  const depositAccounts = accounts.filter((a) => isOpen(a) && DEPOSIT_TYPES.has(a.type));
  if (depositAccounts.length === 0) return unknown("has_emergency_buffer", "no_deposit_account");
  const deposit = new Set(depositAccounts.map((a) => a.guid));
  const txs = transactions.filter((t) => deposit.has(t.account_guid) && isPosted(t));
  const history = historyDays(txs);
  if (history < MIN_HISTORY_DAYS) return unknown("has_emergency_buffer", "history_too_short", { history_days: history });

  const balances = depositAccounts.map((a) => a.available_balance ?? a.balance ?? null);
  if (balances.every((b) => b === null)) return unknown("has_emergency_buffer", "balance_unavailable");
  const liquid = balances.reduce<number>((s, b) => s + Math.max(b ?? 0, 0), 0);

  const windowDays = Math.min(BUFFER_SPEND_WINDOW_DAYS, history);
  const since = asOf.getTime() - windowDays * DAY_MS;
  let spend = 0;
  let debits = 0;
  for (const t of txs) {
    const ms = txTime(t);
    if (t.type !== "DEBIT" || ms === null || ms < since || ms > asOf.getTime()) continue;
    if ((t.top_level_category ?? "") === "Transfer") continue;
    spend += Math.abs(t.amount ?? 0);
    debits++;
  }
  if (spend <= 0) return unknown("has_emergency_buffer", "no_spend_to_measure", { history_days: history });
  const monthlySpend = spend / (windowDays / 30);
  const evidence = { deposit_accounts: depositAccounts.length, qualifying_debits: debits, window_days: windowDays };
  return liquid >= BUFFER_MONTHS * monthlySpend
    ? known("has_emergency_buffer", "true", "liquid_covers_monthly_spend", evidence)
    : known("has_emergency_buffer", "false", "liquid_below_monthly_spend", evidence);
}

// ---- new_subscription_recent (option A: stateless, window-bounded) -----------------------------
// true: a subscription merchant whose FIRST posted is_subscription DEBIT in the fetched history is
// within the last 30 days. Needs ≥ 90 days of history so a monthly subscription would have shown
// up in the 60-day baseline; an annual one can still look new (accepted for option A).
export function deriveNewSubscriptionRecent({ transactions, asOf }: DeriveInput): FactResult {
  const posted = transactions.filter(isPosted);
  if (posted.every((t) => t.is_subscription === null || t.is_subscription === undefined)) {
    return unknown("new_subscription_recent", "flag_unavailable");
  }
  const history = historyDays(posted);
  if (history < SUBSCRIPTION_MIN_HISTORY_DAYS) return unknown("new_subscription_recent", "history_too_short", { history_days: history });

  const firstSeen = new Map<string, number>();
  for (const t of posted) {
    if (t.is_subscription !== true || t.type !== "DEBIT") continue;
    const ms = txTime(t);
    if (ms === null) continue;
    const key = t.merchant_guid || `desc:${(t.description ?? "").trim().toLowerCase()}`;
    const prev = firstSeen.get(key);
    if (prev === undefined || ms < prev) firstSeen.set(key, ms);
  }
  const since = asOf.getTime() - SUBSCRIPTION_NEW_WINDOW_DAYS * DAY_MS;
  const fresh = [...firstSeen.values()].filter((ms) => ms >= since).length;
  const evidence = { subscription_merchants: firstSeen.size, new_merchants_30d: fresh, history_days: history };
  return fresh > 0
    ? known("new_subscription_recent", "true", "new_subscription_merchant", evidence)
    : known("new_subscription_recent", "false", "no_new_subscription_merchant", evidence);
}

// ---- credit_utilization_band -------------------------------------------------------------------
// Limit per card: credit_limit when > 0, else balance + available_credit (→ estimated). Total
// utilization across open cards; bands low < 20%, moderate 20–<30%, high ≥ 30%.
export function deriveCreditUtilizationBand({ accounts }: DeriveInput): FactResult {
  const cards = accounts.filter((a) => isOpen(a) && a.type === "CREDIT_CARD");
  if (cards.length === 0) return unknown("credit_utilization_band", "no_credit_card");
  let owed = 0;
  let limit = 0;
  let estimatedLimits = 0;
  for (const c of cards) {
    if (c.balance === null || c.balance === undefined) return unknown("credit_utilization_band", "card_balance_unavailable", { cards: cards.length });
    const bal = Math.max(c.balance, 0);
    let cardLimit: number;
    if (typeof c.credit_limit === "number" && c.credit_limit > 0) {
      cardLimit = c.credit_limit;
    } else if (typeof c.available_credit === "number") {
      cardLimit = bal + Math.max(c.available_credit, 0);
      estimatedLimits++;
    } else {
      return unknown("credit_utilization_band", "limit_unavailable", { cards: cards.length });
    }
    owed += bal;
    limit += cardLimit;
  }
  if (limit <= 0) return unknown("credit_utilization_band", "limit_unavailable", { cards: cards.length });
  const util = owed / limit;
  const band = util < UTILIZATION_MODERATE ? "low" : util < UTILIZATION_HIGH ? "moderate" : "high";
  const estimated = estimatedLimits > 0;
  return known("credit_utilization_band", band, estimated ? "limit_estimated" : "limit_reported",
    { cards: cards.length, estimated_limits: estimatedLimits }, estimated);
}

export function deriveAll(input: DeriveInput): FactResult[] {
  return [
    deriveHasDirectDeposit(input),
    deriveHasEmergencyBuffer(input),
    deriveNewSubscriptionRecent(input),
    deriveCreditUtilizationBand(input),
  ];
}
