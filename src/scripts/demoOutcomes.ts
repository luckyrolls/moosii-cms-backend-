import "dotenv/config";
import { Client } from "pg";
import { DEMO_PERSONAS, parseArgs, type DemoPersona } from "../demo/reset";
import { seriesRows } from "../demo/outcomeSeries";

// npm run demo:outcomes [-- --go]   (FINANCIAL ONLY)
// Re-seeds demo_outcome_series for Sam and Sarah relative to TODAY (same points and labels as migration 106; rules:
// src/demo/outcomeSeries.ts), so every projected point lies in the future again. Run it before a demo once a projected
// point has passed. Touches only the personas' demo_outcome_series rows — never user_facts, demo_outcome_aggregate,
// plans or any other user. Dry run unless --go. Connects with FINANCIAL_DB_URL in ONE transaction and refuses unless
// that database is the financial project (app_settings.domain + system identifier), like demo:reset.

const FINANCIAL_SYSTEM_ID = "7678069749886157684";

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) fail(args.error);
  const url = process.env.FINANCIAL_DB_URL;
  if (!url) fail("FINANCIAL_DB_URL is not set in .env");
  try { console.log(`host: ${new URL(url).hostname}`); } catch { fail("FINANCIAL_DB_URL is not a valid URL"); }

  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await pg.query("BEGIN");
    const g = await pg.query(`SELECT (pg_control_system()).system_identifier::text AS sysid,
                                     (SELECT value FROM public.app_settings WHERE key = 'domain') AS domain`);
    if (g.rows[0].domain !== "financial") fail(`app_settings.domain is ${JSON.stringify(g.rows[0].domain)}, not "financial"`);
    if (g.rows[0].sysid !== FINANCIAL_SYSTEM_ID) fail(`system identifier ${g.rows[0].sysid} is not the financial project`);
    for (const [persona, id] of Object.entries(DEMO_PERSONAS) as [DemoPersona, string][]) {
      const u = await pg.query(`SELECT raw_app_meta_data->>'demo_persona' AS p FROM auth.users WHERE id = $1`, [id]);
      if (u.rowCount !== 1 || u.rows[0].p !== persona) fail(`user ${id} is not demo persona ${persona}`);
    }
    const ids = Object.values(DEMO_PERSONAS) as string[];
    const nameOf = (id: string) => Object.entries(DEMO_PERSONAS).find(([, v]) => v === id)?.[0] ?? id;
    const show = async (title: string) => {
      const r = await pg.query(`SELECT user_id, fact_key, value, observed_at, label FROM public.demo_outcome_series
                                 WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, fact_key, observed_at`, [ids]);
      console.log(`\n${title}`);
      for (const x of r.rows) console.log(`  ${nameOf(x.user_id).padEnd(6)} ${x.fact_key}=${x.value}  ${new Date(x.observed_at).toISOString()}  "${x.label}"`);
    };

    console.log(`\n${args.go ? "APPLY" : "DRY RUN"} — personas: sam, sarah`);
    await show("BEFORE");
    const del = await pg.query(`DELETE FROM public.demo_outcome_series WHERE user_id = ANY($1::uuid[])`, [ids]);
    const rows = seriesRows(new Date());
    for (const r of rows) {
      await pg.query(`INSERT INTO public.demo_outcome_series (user_id, fact_key, value, observed_at, label) VALUES ($1, $2, $3, $4, $5)`,
        [r.user_id, r.fact_key, r.value, r.observed_at, r.label]);
    }
    console.log(`\nreplaced ${del.rowCount} row(s) with ${rows.length}`);
    await show("AFTER");

    if (!args.go) {
      await pg.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back, nothing changed. Re-run with --go to apply.");
      return;
    }
    await pg.query("COMMIT");
    console.log("\nCOMMITTED.");
  } catch (e) {
    await pg.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await pg.end();
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
