// Migration 113 — activity follow-ups (activity_finish / activity_followup_answer / resolve_activity_followups, the due
// view) and F37 (no client deletes of completed_items), against a REAL Postgres.
//
// Needs MOOSIE_TEST_DB_URL → the THROWAWAY LOCAL database from docs/drafts/111-moosies/README.md with 111, 112 and 113
// applied. Without it every test SKIPS. Refuses any non-local host. Every test runs inside BEGIN … ROLLBACK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const URL_ = process.env.MOOSIE_TEST_DB_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const skip = !URL_ ? "MOOSIE_TEST_DB_URL not set (local 113 test DB)" : false;

async function tx(fn: (db: Client) => Promise<void>): Promise<void> {
  const host = new URL(URL_!).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`MOOSIE_TEST_DB_URL must point at a local throwaway database, not ${host}`);
  const db = new Client({ connectionString: URL_ });
  await db.connect();
  try {
    await db.query("BEGIN");
    await fn(db);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
}

type F = { user: string; activity: string; plainActivity: string; lesson: string; factKey: string };

// One user + config; an activity with a 3-day follow-up verified by <factKey> = 'true' (5 points); an activity with no
// follow-up configured; an ordinary lesson. Vocabulary rows are made per test (unique key), so nothing collides.
async function fixture(db: Client): Promise<F> {
  const f: F = { user: randomUUID(), activity: randomUUID(), plainActivity: randomUUID(), lesson: randomUUID(),
                 factKey: `t113_${randomUUID().slice(0, 8)}` };
  const track = randomUUID();
  await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [f.user]);
  await db.query(`INSERT INTO public."user" (id, daily_reminder_time, moosies) VALUES ($1, '09:00', 0)`, [f.user]);
  await db.query(`INSERT INTO public.user_configurations (user_id, daily_limit, mlp_limit, moosi_to_add, monthly_fee, yearly_fee, free_trial_days)
                  VALUES ($1, 3, 10, 10, 0, 0, 0)`, [f.user]);
  await db.query(`INSERT INTO public.fact_keys (fact_key, kind, label) VALUES ($1, 'boolean', 't')`, [f.factKey]);
  await db.query(`INSERT INTO public.fact_values (fact_key, value, label) VALUES ($1, 'true', 't'), ($1, 'false', 'f')`, [f.factKey]);
  await db.query(`INSERT INTO public.tracks (id, track_name) VALUES ($1, 'm113')`, [track]);
  await db.query(
    `INSERT INTO public.lessons (id, lesson_name, track_id, points, kind, is_published, followup_after_days, verify_fact_key, verify_fact_value)
     VALUES ($1, 'Act', $4, 5, 'activity', true, 3, $5, 'true'),
            ($2, 'Act no follow-up', $4, 5, 'activity', true, NULL, NULL, NULL),
            ($3, 'Lesson', $4, 5, 'lesson', true, NULL, NULL, NULL)`,
    [f.activity, f.plainActivity, f.lesson, track, f.factKey]);
  return f;
}

type Row = { id: string; status: string; asks: number; due_at: string | null; committed_at: string | null;
             resolved_by: string | null; verified_at: string | null; verified_fact_id: string | null };

async function finish(db: Client, user: string, lesson: string, choice: string): Promise<{ followup: Row; created: boolean; awarded: number }> {
  return (await db.query(`SELECT public.activity_finish($1, $2, $3) AS r`, [user, lesson, choice])).rows[0].r;
}
async function answer(db: Client, user: string, id: string, a: string): Promise<{ followup: Row; awarded: number }> {
  return (await db.query(`SELECT public.activity_followup_answer($1, $2, $3) AS r`, [user, id, a])).rows[0].r;
}
async function resolve(db: Client, user: string): Promise<{ followup_id: string; was: string; fact_id: string; awarded: number }[]> {
  return (await db.query(`SELECT public.resolve_activity_followups($1) AS r`, [user])).rows[0].r;
}
async function fact(db: Client, user: string, key: string, value: string, observedAt: string, source = "derived"): Promise<string> {
  return (await db.query(`INSERT INTO public.user_facts (user_id, fact_key, value, observed_at, source) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [user, key, value, observedAt, source])).rows[0].id;
}
async function balance(db: Client, user: string): Promise<number> {
  return (await db.query(`SELECT moosies::int AS m FROM public."user" WHERE id = $1`, [user])).rows[0].m;
}
async function awards(db: Client, user: string): Promise<[string, number][]> {
  return (await db.query(`SELECT reason, amount FROM public.moosie_awards WHERE user_id = $1 ORDER BY reason, amount`, [user]))
    .rows.map((r) => [r.reason, r.amount]);
}
async function completions(db: Client, user: string, lesson: string): Promise<number> {
  return (await db.query(`SELECT count(*)::int AS n FROM public.completed_items WHERE user_id = $1 AND lesson_id = $2`, [user, lesson])).rows[0].n;
}
async function dueIds(db: Client, user: string): Promise<string[]> {
  return (await db.query(`SELECT id FROM public.user_activity_followups_due WHERE user_id = $1`, [user])).rows.map((r) => r.id);
}
async function rejects(db: Client, sql: string, params: unknown[], match: RegExp | string): Promise<void> {
  await db.query("SAVEPOINT r");
  await assert.rejects(db.query(sql, params), (e: { code?: string; message?: string }) =>
    typeof match === "string" ? e.code === match : match.test(e.message ?? ""), sql);
  await db.query("ROLLBACK TO SAVEPOINT r");
}
const backdate = (db: Client, id: string, days: number) =>
  db.query(`UPDATE public.user_activity_followups SET due_at = now() - make_interval(days => $2), committed_at = now() - make_interval(days => $2 + 3), created_at = now() - make_interval(days => $2 + 3) WHERE id = $1`, [id, days]);

test("did_it at the end card: completion (pays 0) + done/self + activity_did_it = lessons.points", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "did_it");
    assert.equal(r.created, true);
    assert.equal(r.followup.status, "done");
    assert.equal(r.followup.resolved_by, "self");
    assert.equal(r.awarded, 5);
    assert.equal(await completions(db, f.user, f.activity), 1);
    assert.deepEqual(await awards(db, f.user), [["activity_did_it", 5], ["completion", 0]]);
    assert.equal(await balance(db, f.user), 5);
  });
});

test("later: committed, due_at = now + followup_after_days, nothing paid beyond the 0 completion", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "later");
    assert.equal(r.followup.status, "committed");
    assert.equal(r.awarded, 0);
    const days = (Date.parse(r.followup.due_at!) - Date.parse(r.followup.committed_at!)) / 86_400_000;
    assert.ok(Math.abs(days - 3) < 0.001, `due in ${days} days`);
    assert.deepEqual(await dueIds(db, f.user), []);                 // not due yet
    assert.equal(await balance(db, f.user), 0);
  });
});

test("not_for_me: skipped, completion written, nothing paid, never in the due view", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "not_for_me");
    assert.equal(r.followup.status, "skipped");
    assert.equal(await completions(db, f.user, f.activity), 1);
    assert.equal(await balance(db, f.user), 0);
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'did_it')`, [f.user, r.followup.id], /activity:not_committed/);
  });
});

test("finish accepts a pre-existing completion row (RN wrote it first) — no 23505, still one row", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await db.query(`INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, item_name, score) VALUES ($1, $2, 'lesson', $2, 'Act', 0)`,
      [f.user, f.activity]);
    const r = await finish(db, f.user, f.activity, "later");
    assert.equal(r.created, true);
    assert.equal(await completions(db, f.user, f.activity), 1);
  });
});

test("finish is idempotent: a repeat call (any choice) returns the existing row unchanged and pays nothing", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const a = await finish(db, f.user, f.activity, "did_it");
    const b = await finish(db, f.user, f.activity, "did_it");
    const c = await finish(db, f.user, f.activity, "not_for_me");
    assert.equal(b.created, false);
    assert.equal(c.created, false);
    assert.deepEqual(b.followup, a.followup);
    assert.deepEqual(c.followup, a.followup);
    assert.equal(b.awarded + c.awarded, 0);
    assert.equal(await balance(db, f.user), 5);
  });
});

test("finish refuses: non-activity lesson, later with no followup_after_days, unknown lesson, bad choice", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await rejects(db, `SELECT public.activity_finish($1, $2, 'did_it')`, [f.user, f.lesson], /activity:not_activity/);
    await rejects(db, `SELECT public.activity_finish($1, $2, 'later')`, [f.user, f.plainActivity], /activity:no_followup_configured/);
    await rejects(db, `SELECT public.activity_finish($1, $2, 'did_it')`, [f.user, randomUUID()], /activity:lesson_not_found/);
    await rejects(db, `SELECT public.activity_finish($1, $2, 'maybe')`, [f.user, f.activity], /activity:invalid_choice/);
    const ok = await finish(db, f.user, f.plainActivity, "did_it");  // did_it / not_for_me need no follow-up config
    assert.equal(ok.followup.status, "done");
  });
});

test("not_yet twice → asks reach max (2) → drops out of the due view; a third not_yet is refused (lapsed); did_it still works", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "later");
    await backdate(db, r.followup.id, 1);
    assert.deepEqual(await dueIds(db, f.user), [r.followup.id]);
    await answer(db, f.user, r.followup.id, "not_yet");               // asks 1, due again in 3 days
    assert.deepEqual(await dueIds(db, f.user), []);
    await backdate(db, r.followup.id, 1);
    assert.deepEqual(await dueIds(db, f.user), [r.followup.id]);
    const second = await answer(db, f.user, r.followup.id, "not_yet"); // asks 2 = max
    assert.equal(second.followup.asks, 2);
    await backdate(db, r.followup.id, 1);
    assert.deepEqual(await dueIds(db, f.user), []);                  // lapsed: asks exhausted
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'not_yet')`, [f.user, r.followup.id], /activity:followup_lapsed/);
    const done = await answer(db, f.user, r.followup.id, "did_it");
    assert.equal(done.followup.status, "done");
    assert.equal(done.awarded, 5);
  });
});

test("grace lapse: a committed follow-up more than followup_grace_days (14) past due leaves the view", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "later");
    await backdate(db, r.followup.id, 13);
    assert.deepEqual(await dueIds(db, f.user), [r.followup.id]);
    await backdate(db, r.followup.id, 15);
    assert.deepEqual(await dueIds(db, f.user), []);
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'not_yet')`, [f.user, r.followup.id], /activity:followup_lapsed/);
  });
});

test("the due view hides unpublished and archived activities", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "later");
    await backdate(db, r.followup.id, 1);
    await db.query(`UPDATE public.lessons SET is_published = false WHERE id = $1`, [f.activity]);
    assert.deepEqual(await dueIds(db, f.user), []);
    await db.query(`UPDATE public.lessons SET is_published = true, archived_at = now() WHERE id = $1`, [f.activity]);
    assert.deepEqual(await dueIds(db, f.user), []);
  });
});

test("answer: only the owner's committed row; did_it pays once", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "later");
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'did_it')`, [randomUUID(), r.followup.id], /activity:followup_not_found/);
    const a = await answer(db, f.user, r.followup.id, "did_it");
    assert.equal(a.awarded, 5);
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'did_it')`, [f.user, r.followup.id], /activity:not_committed/);
    assert.equal(await balance(db, f.user), 5);
  });
});

test("auto-resolve a committed follow-up: done by data, fact id recorded, bonus 5 once", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "later");
    const factId = await fact(db, f.user, f.factKey, "true", new Date(Date.now() + 1000).toISOString());
    const out = await resolve(db, f.user);
    assert.deepEqual(out.map((x) => [x.followup_id, x.was, x.fact_id, x.awarded]), [[r.followup.id, "committed", factId, 5]]);
    const row = (await db.query(`SELECT status, resolved_by, verified_fact_id FROM public.user_activity_followups WHERE id = $1`, [r.followup.id])).rows[0];
    assert.deepEqual(row, { status: "done", resolved_by: "data", verified_fact_id: factId });
    assert.deepEqual(await resolve(db, f.user), []);                  // already verified: nothing more
    assert.deepEqual(await awards(db, f.user), [["activity_verified", 5], ["completion", 0]]);
  });
});

test("auto-resolve a self-done follow-up: stays done/self, gains verified_at + the bonus (did_it + bonus each once)", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = await finish(db, f.user, f.activity, "did_it");
    await fact(db, f.user, f.factKey, "true", new Date(Date.now() + 1000).toISOString());
    assert.equal((await resolve(db, f.user)).length, 1);
    assert.equal((await resolve(db, f.user)).length, 0);
    const row = (await db.query(`SELECT status, resolved_by, verified_at IS NOT NULL AS v FROM public.user_activity_followups WHERE id = $1`, [r.followup.id])).rows[0];
    assert.deepEqual(row, { status: "done", resolved_by: "self", v: true });
    assert.deepEqual(await awards(db, f.user), [["activity_did_it", 5], ["activity_verified", 5], ["completion", 0]]);
    assert.equal(await balance(db, f.user), 10);
    // a replayed award for the same follow-up is a no-op
    const replay = await db.query(`SELECT public.activity_award($1, 5, 'activity_did_it', $2) AS paid`, [f.user, r.followup.id]);
    assert.equal(replay.rows[0].paid, 0);
    assert.equal(await balance(db, f.user), 10);
  });
});

test("evidence dated BEFORE the commitment does not resolve; a later observation does", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await fact(db, f.user, f.factKey, "true", new Date(Date.now() - 86_400_000).toISOString());   // already true yesterday
    const r = await finish(db, f.user, f.activity, "later");
    assert.deepEqual(await resolve(db, f.user), []);
    await fact(db, f.user, f.factKey, "false", new Date(Date.now() + 1000).toISOString());
    assert.deepEqual(await resolve(db, f.user), []);                  // current value not the target
    const id = await fact(db, f.user, f.factKey, "true", new Date(Date.now() + 2000).toISOString());
    assert.deepEqual((await resolve(db, f.user)).map((x) => [x.followup_id, x.fact_id]), [[r.followup.id, id]]);
  });
});

test("a SEEDED fact resolves and records its user_facts id", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await finish(db, f.user, f.activity, "later");
    const id = await fact(db, f.user, f.factKey, "true", new Date(Date.now() + 1000).toISOString(), "seed");
    const out = await resolve(db, f.user);
    assert.equal(out[0].fact_id, id);
  });
});

test("skipped follow-ups are never verified", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await finish(db, f.user, f.activity, "not_for_me");
    await fact(db, f.user, f.factKey, "true", new Date(Date.now() + 1000).toISOString());
    assert.deepEqual(await resolve(db, f.user), []);
  });
});

test("F37: a client DELETE (or TRUNCATE) on completed_items is refused (42501); the service path still deletes", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await finish(db, f.user, f.activity, "did_it");
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: f.user, role: "authenticated" })]);
    await db.query("SET LOCAL ROLE authenticated");
    await rejects(db, `DELETE FROM public.completed_items WHERE user_id = $1`, [f.user], "42501");
    await rejects(db, `TRUNCATE public.completed_items`, [], "42501");
    // own SELECT / INSERT / UPDATE still work without the dropped catch-all policy
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.completed_items WHERE user_id = $1`, [f.user])).rows[0].n, 1);
    await db.query(`INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, item_name, score) VALUES ($1, $2, 'lesson', $2, 'L', 0)`, [f.user, f.lesson]);
    assert.equal((await db.query(`UPDATE public.completed_items SET item_name = 'L2' WHERE user_id = $1 AND lesson_id = $2`, [f.user, f.lesson])).rowCount, 1);
    await db.query("RESET ROLE");
    assert.equal((await db.query(`DELETE FROM public.completed_items WHERE user_id = $1`, [f.user])).rowCount, 2);
  });
});

test("a client write to user_activity_followups is refused; the client reads only its own rows and its due view", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const g = await fixture(db);
    const mine = await finish(db, f.user, f.activity, "later");
    await finish(db, g.user, g.activity, "later");
    await backdate(db, mine.followup.id, 1);
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: f.user, role: "authenticated" })]);
    await db.query("SET LOCAL ROLE authenticated");
    await rejects(db, `INSERT INTO public.user_activity_followups (user_id, lesson_id, status, resolved_at, resolved_by) VALUES ($1, $2, 'done', now(), 'self')`, [f.user, f.lesson], "42501");
    await rejects(db, `UPDATE public.user_activity_followups SET status = 'done' WHERE user_id = $1`, [f.user], "42501");
    await rejects(db, `DELETE FROM public.user_activity_followups WHERE user_id = $1`, [f.user], "42501");
    await rejects(db, `SELECT public.activity_finish($1, $2, 'did_it')`, [f.user, f.activity], "42501");
    const rows = (await db.query(`SELECT user_id FROM public.user_activity_followups`)).rows;
    assert.deepEqual(rows.map((r) => r.user_id), [f.user]);
    const due = (await db.query(`SELECT id FROM public.user_activity_followups_due`)).rows;
    assert.deepEqual(due.map((r) => r.id), [mine.followup.id]);
  });
});

test("lessons: follow-up settings only on activities; verify key/value both or neither, from the vocabulary", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await rejects(db, `UPDATE public.lessons SET followup_after_days = 3 WHERE id = $1`, [f.lesson], "23514");
    await rejects(db, `UPDATE public.lessons SET followup_after_days = 0 WHERE id = $1`, [f.activity], "23514");
    await rejects(db, `UPDATE public.lessons SET verify_fact_value = NULL WHERE id = $1`, [f.activity], "23514");
    await rejects(db, `UPDATE public.lessons SET verify_fact_value = 'maybe' WHERE id = $1`, [f.activity], "23503");
  });
});

// ---- demo path (financial demo, migration 114 config shape) ----

test("demo: Sam-shaped run — later → simulated 'low' (seed, demo-simulate) → done by data, bonus once; deleting the simulated row restores 'high'", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    // the persona's real band, derived weeks ago
    const real = await fact(db, f.user, f.factKey, "false", new Date(Date.now() - 20 * 86_400_000).toISOString(), "estimated");
    const r = await finish(db, f.user, f.activity, "later");
    const sim = (await db.query(
      `INSERT INTO public.user_facts (user_id, fact_key, value, observed_at, source, source_ref) VALUES ($1, $2, 'true', $3, 'seed', 'demo-simulate') RETURNING id`,
      [f.user, f.factKey, new Date(Date.now() + 1000).toISOString()])).rows[0].id;
    const out = await resolve(db, f.user);
    assert.deepEqual(out.map((x) => [x.followup_id, x.was, x.fact_id, x.awarded]), [[r.followup.id, "committed", sim, 5]]);
    assert.deepEqual((await resolve(db, f.user)), []);
    assert.deepEqual(await awards(db, f.user), [["activity_verified", 5], ["completion", 0]]);
    // demo:reset's fact step: delete only the simulated row → the real observation is current again, with its provenance
    await db.query(`DELETE FROM public.user_facts WHERE user_id = $1 AND source = 'seed' AND source_ref = 'demo-simulate'`, [f.user]);
    const latest = (await db.query(`SELECT value, source, observation_id FROM public.user_facts_latest WHERE user_id = $1 AND fact_key = $2`, [f.user, f.factKey])).rows[0];
    assert.deepEqual(latest, { value: "false", source: "estimated", observation_id: real });
    // the follow-up keeps verified_at; its evidence pointer is cleared by ON DELETE SET NULL (demo:reset deletes the row anyway)
    const row = (await db.query(`SELECT verified_at IS NOT NULL AS v, verified_fact_id FROM public.user_activity_followups WHERE id = $1`, [r.followup.id])).rows[0];
    assert.deepEqual(row, { v: true, verified_fact_id: null });
  });
});

test("demo: one persona cannot answer or see another persona's follow-up", { skip }, async () => {
  await tx(async (db) => {
    const sam = await fixture(db);
    const sarah = await fixture(db);
    const samRow = await finish(db, sam.user, sam.activity, "later");
    await backdate(db, samRow.followup.id, 1);
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'did_it')`, [sarah.user, samRow.followup.id], /activity:followup_not_found/);
    await rejects(db, `SELECT public.activity_followup_answer($1, $2, 'not_yet')`, [sarah.user, samRow.followup.id], /activity:followup_not_found/);
    assert.deepEqual(await dueIds(db, sarah.user), []);
    assert.deepEqual(await dueIds(db, sam.user), [samRow.followup.id]);
    const untouched = (await db.query(`SELECT status, asks FROM public.user_activity_followups WHERE id = $1`, [samRow.followup.id])).rows[0];
    assert.deepEqual(untouched, { status: "committed", asks: 0 });
  });
});
