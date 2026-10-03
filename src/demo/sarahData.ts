// Sarah's MX sandbox data — the PURE half of `npm run demo:sarah-data` (src/scripts/demoSarahData.ts does the I/O).
// A deterministic set (fixed RNG seed) of MANUAL accounts + transactions dated relative to TODAY, 120 days back, so
// it can be re-created before any demo and the last-30-days view is never empty. Story (Mark, 2026-10-03): steady
// paycheck, almost nothing saved, spends ~90% of income, no credit card. Derived facts (facts-derive/2):
// has_direct_deposit true, has_emergency_buffer false, new_subscription_recent false, no credit_utilization_band.
// Names are generic: no real employer, landlord, bank or merchant brands.

export const SARAH_SEED = 20261003;
export const SARAH_HISTORY_DAYS = 120;
export const PAYCHECK = 1650;
export const PAYCHECK_EVERY_DAYS = 14;

export type AccountKey = "checking" | "savings";
export type PlannedAccount = { key: AccountKey; name: string; account_type: "CHECKING" | "SAVINGS"; balance: number };
export type PlannedTxn = {
  account: AccountKey;
  date: string;              // YYYY-MM-DD
  amount: number;            // positive; direction is `type`
  type: "CREDIT" | "DEBIT";
  description: string;
  category: string;          // MX default category name (resolved to category_guid by the script)
  top_level: string;         // its MX top-level category (for summaries / tests)
};
export type SarahPlan = { accounts: PlannedAccount[]; transactions: PlannedTxn[] };

export const ACCOUNTS: PlannedAccount[] = [
  { key: "checking", name: "Everyday Checking", account_type: "CHECKING", balance: 640 },
  { key: "savings", name: "Savings", account_type: "SAVINGS", balance: 150 },
];

// MX category → top-level (checked against GET /categories/default, 2026-10-03).
export const TOP_LEVEL: Record<string, string> = {
  Paycheck: "Income", "Mortgage & Rent": "Home", "Auto Payment": "Auto & Transport", "Auto Insurance": "Auto & Transport",
  Utilities: "Bills & Utilities", "Mobile Phone": "Bills & Utilities", Television: "Bills & Utilities",
  Groceries: "Food & Dining", Restaurants: "Food & Dining", "Coffee Shops": "Food & Dining", Gas: "Auto & Transport",
  Clothing: "Shopping", Pharmacy: "Health & Fitness", Hair: "Personal Care", "Movies & DVDs": "Entertainment",
  Transfer: "Transfer",
};

// mulberry32 — tiny deterministic PRNG.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;

export function sarahPlan(today: Date, seed = SARAH_SEED): SarahPlan {
  const r = rng(seed);
  const between = (lo: number, hi: number) => cents(lo + r() * (hi - lo));
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = end - (SARAH_HISTORY_DAYS - 1) * DAY_MS;
  const tx: PlannedTxn[] = [];
  const add = (account: AccountKey, ms: number, amount: number, type: "CREDIT" | "DEBIT", description: string, category: string) => {
    if (ms < start || ms > end) return;
    tx.push({ account, date: ymd(ms), amount: cents(amount), type, description, category, top_level: TOP_LEVEL[category] });
  };

  // Paychecks every 14 days, the latest 3 days ago; $25 to savings each payday.
  for (let ms = end - 3 * DAY_MS; ms >= start; ms -= PAYCHECK_EVERY_DAYS * DAY_MS) {
    add("checking", ms, PAYCHECK, "CREDIT", "PAYROLL DIRECT DEP", "Paycheck");
    add("checking", ms, 25, "DEBIT", "TRANSFER TO SAVINGS", "Transfer");
    add("savings", ms, 25, "CREDIT", "TRANSFER FROM CHECKING", "Transfer");
  }

  // Monthly bills on fixed days of the month.
  const monthly: [number, number, string, string, () => number][] = [
    [1, 0, "RENT PAYMENT", "Mortgage & Rent", () => 1400],
    [5, 0, "STREAMING SERVICE", "Television", () => 15.49],
    [8, 0, "CITY UTILITIES", "Utilities", () => between(98, 124)],
    [12, 0, "MOBILE PHONE BILL", "Mobile Phone", () => 65],
    [15, 0, "AUTO LOAN PAYMENT", "Auto Payment", () => 320],
    [18, 0, "MOVIE THEATER", "Movies & DVDs", () => between(28, 45)],
    [20, 0, "AUTO INSURANCE", "Auto Insurance", () => 140],
    [22, 0, "PHARMACY", "Pharmacy", () => between(10, 16)],
    [27, 0, "HAIR SALON", "Hair", () => between(32, 40)],
  ];
  for (let m = -5; m <= 0; m++) {
    const base = new Date(end);
    for (const [dom, , desc, cat, amt] of monthly) {
      const ms = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + m, dom);
      add("checking", ms, amt(), "DEBIT", desc, cat);
    }
  }

  // Weekly groceries and gas; restaurants / coffee every few days; shopping every ~10 days.
  for (let ms = end - 2 * DAY_MS; ms >= start; ms -= 7 * DAY_MS) add("checking", ms, between(118, 152), "DEBIT", "GROCERY MARKET", "Groceries");
  for (let ms = end - 4 * DAY_MS; ms >= start; ms -= 7 * DAY_MS) add("checking", ms, between(36, 48), "DEBIT", "GAS STATION", "Gas");
  for (let ms = end - 1 * DAY_MS; ms >= start; ms -= Math.round(3 + r() * 3) * DAY_MS) {
    const coffee = r() < 0.4;
    add("checking", ms, coffee ? between(5, 9) : between(16, 38), "DEBIT", coffee ? "COFFEE SHOP" : "NEIGHBORHOOD DINER", coffee ? "Coffee Shops" : "Restaurants");
  }
  for (let ms = end - 6 * DAY_MS; ms >= start; ms -= Math.round(8 + r() * 5) * DAY_MS) add("checking", ms, between(35, 85), "DEBIT", "DEPARTMENT STORE", "Clothing");

  tx.sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account) || a.description.localeCompare(b.description));
  return { accounts: ACCOUNTS, transactions: tx };
}

// Monthly figures for the report (spend excludes Transfer, as the derive rules and the spending view do).
export function planSummary(plan: SarahPlan): { monthly_income: number; monthly_spend: number; ratio: number; transactions: number } {
  const spend = plan.transactions.filter((t) => t.type === "DEBIT" && t.top_level !== "Transfer").reduce((s, t) => s + t.amount, 0);
  const months = SARAH_HISTORY_DAYS / 30;
  const monthlyIncome = (PAYCHECK * 26) / 12;
  return { monthly_income: cents(monthlyIncome), monthly_spend: cents(spend / months), ratio: Math.round((spend / months / monthlyIncome) * 1000) / 1000, transactions: plan.transactions.length };
}
