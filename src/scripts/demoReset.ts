import "dotenv/config";
import { Client } from "pg";
import {
  DEMO_PERSONAS, RESET_TABLES, SELECT_COLUMNS, parseArgs, rowsToDelete, moosiesAfterReset,
  type DemoPersona, type Row,
} from "../demo/reset";

// npm run demo:reset [-- --go]   (FINANCIAL ONLY)
// Returns Sam and Sarah to their pre-demo state: deletes their per-user progress rows (RESET_TABLES) except
// Sam's seeded orientation completion, recomputes user.moosies from what remains, resets has_seen_mlp_intro,
// then asks the financial service to rebuild both plans. Dry run unless --go. Rules: src/demo/reset.ts.
// Connects with FINANCIAL_DB_URL (never SUPABASE_URL, which may point at Moosii) in ONE transaction, and
// refuses unless that database is the financial project (app_settings.domain + system identifier).

const FINANCIAL_SYSTEM_ID = "7678069749886157684";
const FINANCIAL_BACKEND = process.env.FINANCIAL_BACKEND_URL || "https://moosii-financial-backend.onrender.com";

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) fail(args.error);

  const url = process.env.FINANCIAL_DB_URL;
  if (!url) fail("FINANCIAL_DB_URL is not set in .env");
  let host = "?";
  try { host = new URL(url).hostname; } catch { fail("FINANCIAL_DB_URL is not a valid URL"); }
  console.log(`host: ${host}`);

  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await pg.query("BEGIN");

    // Guards: the DATABASE is financial; each persona id is still the user flagged with that demo_persona.
    const g = await pg.query(
      `SELECT (pg_control_system()).system_identifier::text AS sysid,
              (SELECT value FROM public.app_settings WHERE key = 'domain') AS domain`);
    if (g.rows[0].domain !== "financial") fail(`app_settings.domain is ${JSON.stringify(g.rows[0].domain)}, not "financial"`);
    if (g.rows[0].sysid !== FINANCIAL_SYSTEM_ID) fail(`system identifier ${g.rows[0].sysid} is not the financial project`);
    console.log(`domain: financial (system ${g.rows[0].sysid})`);
    for (const [persona, id] of Object.entries(DEMO_PERSONAS) as [DemoPersona, string][]) {
      const u = await pg.query(`SELECT raw_app_meta_data->>'demo_persona' AS p FROM auth.users WHERE id = $1`, [id]);
      if (u.rowCount !== 1) fail(`persona ${persona}: auth user ${id} not found`);
      if (u.rows[0].p !== persona) fail(`user ${id} carries demo_persona ${JSON.stringify(u.rows[0].p)}, expected ${persona}`);
    }
    const ids = Object.values(DEMO_PERSONAS) as string[];
    const nameOf = (id: string) => Object.entries(DEMO_PERSONAS).find(([, v]) => v === id)?.[0] ?? id;
    const read = async (table: (typeof RESET_TABLES)[number]): Promise<Row[]> =>
      (await pg.query(`SELECT ${SELECT_COLUMNS[table]} FROM public.${table} WHERE user_id = ANY($1::uuid[])`, [ids])).rows;

    console.log(`\n${args.go ? "APPLY" : "DRY RUN"} — personas: sam, sarah\n`);
    console.log(`${"table".padEnd(30)} ${"before".padStart(6)} ${"delete".padStart(6)} ${"keep".padStart(5)}`);
    const plan: { table: (typeof RESET_TABLES)[number]; del: Row[] }[] = [];
    for (const table of RESET_TABLES) {
      const rows = await read(table);
      const del = rowsToDelete(table, rows);
      plan.push({ table, del });
      console.log(`${table.padEnd(30)} ${String(rows.length).padStart(6)} ${String(del.length).padStart(6)} ${String(rows.length - del.length).padStart(5)}`);
      if (del.length) {
        const r = await pg.query(`DELETE FROM public.${table} WHERE id = ANY($1) AND user_id = ANY($2::uuid[])`,
          [del.map((x) => x.id), ids]);
        if (r.rowCount !== del.length) fail(`${table}: deleted ${r.rowCount}, planned ${del.length}`);
      }
    }

    // Moosies (recomputed from the completions that remain) + the plan-intro flag.
    console.log("");
    const users = await pg.query(
      `SELECT u.id, u.moosies, u.has_seen_mlp_intro, c.moosi_to_add,
              (SELECT count(*)::int FROM public.completed_items ci WHERE ci.user_id = u.id) AS kept
         FROM public."user" u LEFT JOIN public.user_configurations c ON c.user_id = u.id
        WHERE u.id = ANY($1::uuid[]) ORDER BY u.id`, [ids]);
    for (const u of users.rows) {
      const target = moosiesAfterReset(u.kept, u.moosi_to_add);
      console.log(`user ${nameOf(u.id).padEnd(6)} moosies ${u.moosies} → ${target ?? "(unchanged, no config)"}   has_seen_mlp_intro ${u.has_seen_mlp_intro} → false`);
      await pg.query(`UPDATE public."user" SET has_seen_mlp_intro = false, moosies = coalesce($2, moosies) WHERE id = $1`, [u.id, target]);
    }

    console.log(`\nAFTER`);
    for (const table of RESET_TABLES) console.log(`${table.padEnd(30)} ${String((await read(table)).length).padStart(6)}`);

    if (!args.go) {
      await pg.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back, nothing changed. Re-run with --go to apply.");
      return;
    }
    await pg.query("COMMIT");
    console.log("\nCOMMITTED.");

    // Plans: user_mlp is derived — rebuild both on the financial service (the in-process runner lives there).
    const key = process.env.FINANCIAL_INTERNAL_API_KEY;
    if (!key) {
      console.log(`No FINANCIAL_INTERNAL_API_KEY — rebuild both plans via POST ${FINANCIAL_BACKEND}/jobs (rebuild_mlp).`);
      return;
    }
    for (const id of ids) {
      const r = await fetch(`${FINANCIAL_BACKEND}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ type: "rebuild_mlp", input: { user_id: id } }),
      });
      const body = (await r.json().catch(() => ({}))) as { job_id?: string };
      console.log(`rebuild ${nameOf(id)}: HTTP ${r.status} job ${body.job_id ?? "?"}`);
    }
  } catch (e) {
    await pg.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await pg.end();
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
