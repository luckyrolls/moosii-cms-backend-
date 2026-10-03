import "dotenv/config";
import { Client } from "pg";
import { parseArgs, DEMO_PERSONAS } from "../demo/reset";
import { sarahPlan, planSummary, type AccountKey } from "../demo/sarahData";

// npm run demo:sarah-data [-- --go]   (FINANCIAL ONLY)
// Makes Sarah a real MX sandbox user with a deterministic set of MANUAL accounts + transactions dated relative to
// TODAY (src/demo/sarahData.ts), then derives her facts on the financial service (derive_facts, facts-derive/2).
// Steps with --go: create her MX user (id = her auth uid) if absent → delete her existing manual accounts (and with
// them their transactions) → create the planned accounts + transactions → delete her seeded user_facts rows
// (source 'seed'; none after the first run) → POST /jobs derive_facts → wait and print the derived facts.
// Dry run (default) only reads and prints. Guardrails as demo:reset: FINANCIAL_DB_URL must be the financial
// project (app_settings.domain + system identifier) and Sarah's id must still carry demo_persona 'sarah'.
// Never prints keys. MX writes use the user's GUID (MX's account-delete path refuses the partner id).

const FINANCIAL_SYSTEM_ID = "7678069749886157684";
const FINANCIAL_BACKEND = process.env.FINANCIAL_BACKEND_URL || "https://moosii-financial-backend.onrender.com";
const SARAH = DEMO_PERSONAS.sarah;

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
}

const mxBase = (process.env.MX_BASE_URL?.trim() || "https://int-api.mx.com").replace(/\/+$/, "");
function mxAuth(): string {
  const id = process.env.MX_CLIENT_ID?.trim(), key = process.env.MX_API_KEY?.trim();
  if (!id || !key) fail("MX_CLIENT_ID / MX_API_KEY are not set in .env");
  return "Basic " + Buffer.from(`${id}:${key}`).toString("base64");
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mx(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(mxBase + path, {
    method,
    headers: { Authorization: mxAuth(), Accept: "application/json", "Accept-Version": "v20250224", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mxPaged(path: string, field: string): Promise<any[]> {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await mx("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}&records_per_page=100`);
    if (r.status !== 200) fail(`GET ${path.split("?")[0]} → ${r.status}`);
    out.push(...(r.json?.[field] ?? []));
    if (page >= (r.json?.pagination?.total_pages ?? 1)) break;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) fail(args.error);

  const url = process.env.FINANCIAL_DB_URL;
  if (!url) fail("FINANCIAL_DB_URL is not set in .env");
  let host = "?";
  try { host = new URL(url).hostname; } catch { fail("FINANCIAL_DB_URL is not a valid URL"); }
  console.log(`host: ${host}`);
  console.log(`mx:   ${new URL(mxBase).host}`);

  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    const g = await pg.query(
      `SELECT (pg_control_system()).system_identifier::text AS sysid,
              (SELECT value FROM public.app_settings WHERE key = 'domain') AS domain,
              (SELECT raw_app_meta_data->>'demo_persona' FROM auth.users WHERE id = $1) AS persona`, [SARAH]);
    if (g.rows[0].domain !== "financial") fail(`app_settings.domain is ${JSON.stringify(g.rows[0].domain)}, not "financial"`);
    if (g.rows[0].sysid !== FINANCIAL_SYSTEM_ID) fail(`system identifier ${g.rows[0].sysid} is not the financial project`);
    if (g.rows[0].persona !== "sarah") fail(`user ${SARAH} carries demo_persona ${JSON.stringify(g.rows[0].persona)}, expected sarah`);
    console.log(`domain: financial (system ${g.rows[0].sysid}); persona sarah = ${SARAH}`);

    // ---- read + plan -------------------------------------------------------------------------------
    const today = new Date();
    const plan = sarahPlan(today);
    const sum = planSummary(plan);

    const cats = await mxPaged("/categories/default", "categories");
    const catGuid = new Map<string, string>(cats.map((c: { name: string; guid: string }) => [c.name, c.guid]));
    const missing = [...new Set(plan.transactions.map((t) => t.category))].filter((n) => !catGuid.has(n));
    if (missing.length) fail(`MX has no default category named: ${missing.join(", ")}`);

    const u = await mx("GET", `/users/${SARAH}`);
    if (u.status !== 200 && u.status !== 404) fail(`GET MX user → ${u.status}`);
    let userGuid: string | null = u.status === 200 ? u.json.user.guid : null;
    const existing = userGuid ? await mxPaged(`/users/${userGuid}/accounts`, "accounts") : [];
    const aggregated = existing.filter((a: { is_manual?: boolean }) => a.is_manual !== true);
    if (aggregated.length) fail(`Sarah's MX user has ${aggregated.length} aggregated (non-manual) account(s) — not touching those`);
    const seed = await pg.query(`SELECT fact_key, value FROM public.user_facts WHERE user_id = $1 AND source = 'seed' ORDER BY fact_key`, [SARAH]);

    const byTop = new Map<string, number>();
    for (const t of plan.transactions) if (t.type === "DEBIT" && t.top_level !== "Transfer") byTop.set(t.top_level, (byTop.get(t.top_level) ?? 0) + t.amount);
    console.log(`\n${args.go ? "APPLY" : "DRY RUN"} — Sarah's MX sandbox data, dated ${plan.transactions[0].date} → ${plan.transactions.at(-1)!.date}`);
    console.log(`MX user:            ${userGuid ? "exists" : "absent → create (id = auth uid)"}`);
    console.log(`manual accounts:    ${existing.length} to delete; create ${plan.accounts.map((a) => `${a.name} ${a.balance}`).join(", ")}`);
    console.log(`transactions:       ${plan.transactions.length} to create`);
    console.log(`monthly income:     ${sum.monthly_income.toFixed(2)}   monthly spend: ${sum.monthly_spend.toFixed(2)}   ratio ${(sum.ratio * 100).toFixed(1)}%`);
    for (const [top, amt] of [...byTop.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${top.padEnd(20)} ${(amt / 4).toFixed(2)} / month`);
    console.log(`seeded user_facts:  ${seed.rowCount} to delete${seed.rowCount ? ` (${seed.rows.map((r) => `${r.fact_key}=${r.value}`).join(", ")})` : ""}`);

    if (!args.go) {
      console.log("\nDRY RUN — nothing changed. Re-run with --go to apply.");
      return;
    }

    // ---- apply: MX -----------------------------------------------------------------------------------
    if (!userGuid) {
      const c = await mx("POST", "/users", { user: { id: SARAH, metadata: "moosii demo persona sarah (manual accounts)" } });
      if (c.status !== 200) fail(`create MX user → ${c.status}`);
      userGuid = c.json.user.guid as string;
      console.log("\nMX user created");
    }
    for (const a of existing) {
      const d = await mx("DELETE", `/users/${userGuid}/accounts/${a.guid}`);
      if (d.status !== 204) fail(`delete manual account → ${d.status}`);
    }
    const leftAccounts = await mxPaged(`/users/${userGuid}/accounts`, "accounts");
    const leftTx = (await mxPaged(`/users/${userGuid}/transactions`, "transactions")).filter((t: { is_manual?: boolean }) => t.is_manual === true);
    if (leftAccounts.length || leftTx.length) fail(`after delete: ${leftAccounts.length} account(s), ${leftTx.length} manual transaction(s) remain`);
    console.log(`deleted ${existing.length} manual account(s); none left`);

    const acctGuid = new Map<AccountKey, string>();
    for (const a of plan.accounts) {
      const c = await mx("POST", `/users/${userGuid}/accounts`, {
        account: { name: a.name, account_type: a.account_type, balance: a.balance, available_balance: a.balance, skip_webhook: true },
      });
      if (c.status !== 200) fail(`create account ${a.name} → ${c.status}`);
      acctGuid.set(a.key, c.json.account.guid);
    }
    let created = 0;
    for (const t of plan.transactions) {
      const c = await mx("POST", `/users/${userGuid}/accounts/${acctGuid.get(t.account)}/transactions`, {
        transaction: { amount: t.amount, date: t.date, description: t.description, type: t.type, category_guid: catGuid.get(t.category) },
      });
      if (c.status !== 200) fail(`create transaction ${t.date} ${t.description} → ${c.status} (after ${created} created)`);
      created++;
    }
    const nowTx = (await mxPaged(`/users/${userGuid}/transactions?from_date=${Math.floor((Date.now() - 130 * 86_400_000) / 1000)}`, "transactions"))
      .filter((t: { is_manual?: boolean }) => t.is_manual === true);
    console.log(`created ${plan.accounts.length} accounts, ${created} transactions; MX now lists ${nowTx.length} manual transactions`);
    if (nowTx.length !== plan.transactions.length) fail(`MX lists ${nowTx.length} manual transactions, planned ${plan.transactions.length}`);

    // ---- apply: seeded facts out (first run only) ---------------------------------------------------
    await pg.query("BEGIN");
    const del = await pg.query(`DELETE FROM public.user_facts WHERE user_id = $1 AND source = 'seed' RETURNING fact_key`, [SARAH]);
    if (del.rowCount !== seed.rowCount) { await pg.query("ROLLBACK"); fail(`deleted ${del.rowCount} seed rows, expected ${seed.rowCount}`); }
    await pg.query("COMMIT");
    console.log(`deleted ${del.rowCount} seeded user_facts row(s)`);

    // ---- derive on the financial service --------------------------------------------------------------
    const key = process.env.FINANCIAL_INTERNAL_API_KEY;
    if (!key) fail(`no FINANCIAL_INTERNAL_API_KEY — run derive_facts for ${SARAH} via POST ${FINANCIAL_BACKEND}/jobs`);
    const r = await fetch(`${FINANCIAL_BACKEND}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ type: "derive_facts", input: { user_id: SARAH } }),
    });
    const jobId = ((await r.json().catch(() => ({}))) as { job_id?: string }).job_id;
    if (r.status !== 202 || !jobId) fail(`POST /jobs derive_facts → ${r.status}`);
    console.log(`derive_facts job ${jobId}`);
    for (let i = 0; i < 45; i++) {
      const j = await pg.query(`SELECT status, result, error FROM public.jobs WHERE id = $1`, [jobId]);
      const row = j.rows[0];
      if (row?.status === "succeeded") {
        const res = row.result;
        console.log(`derived (${res.rule_version}, basis ${res.basis}, observed_at ${res.observed_at}): written ${res.written}, rebuild ${res.rebuild_enqueued}`);
        for (const f of res.facts) console.log(`   ${f.fact_key.padEnd(24)} ${String(f.value ?? "unknown").padEnd(8)} ${f.status} (${f.reason}${f.source ? `, ${f.source}` : ""})`);
        return;
      }
      if (row?.status === "failed") fail(`derive_facts failed: ${row.error?.message ?? JSON.stringify(row.error)}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    fail(`derive_facts job ${jobId} did not finish within 90 s — check the jobs row`);
  } finally {
    await pg.end();
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
