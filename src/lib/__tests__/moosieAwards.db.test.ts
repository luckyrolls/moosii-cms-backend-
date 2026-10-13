// Migration 111 — the Moosies award trigger + ledger, exercised against a REAL Postgres.
//
// Needs MOOSIE_TEST_DB_URL → a THROWAWAY LOCAL database restored from a schema-only dump of Moosii with 111 applied
// (recipe: docs/drafts/111-moosies/README.md). Without it every test SKIPS, so a plain `npm test` stays offline.
// Refuses any host other than localhost / 127.0.0.1 / ::1, never Supabase. Every test runs inside BEGIN … ROLLBACK
// with its own fixture rows, so the database is left as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const URL_ = process.env.MOOSIE_TEST_DB_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const skip = !URL_ ? "MOOSIE_TEST_DB_URL not set (local 111 test DB)" : false;

async function inRolledBackTx(fn: (db: Client) => Promise<void>): Promise<void> {
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

type Fixture = { user: string; lesson: string; activity: string; checkin: string };

async function fixture(db: Client, moosiToAdd = 10): Promise<Fixture> {
  const f = { user: randomUUID(), lesson: randomUUID(), activity: randomUUID(), checkin: randomUUID() };
  const track = randomUUID();
  await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [f.user]);
  await db.query(`INSERT INTO public."user" (id, daily_reminder_time, moosies) VALUES ($1, '09:00', 0)`, [f.user]);
  await db.query(
    `INSERT INTO public.user_configurations (user_id, daily_limit, mlp_limit, moosi_to_add, monthly_fee, yearly_fee, free_trial_days)
     VALUES ($1, 3, 10, $2, 0, 0, 0)`, [f.user, moosiToAdd]);
  await db.query(`INSERT INTO public.tracks (id, track_name) VALUES ($1, 'm111 test')`, [track]);
  await db.query(`INSERT INTO public.lessons (id, lesson_name, track_id, points, kind) VALUES ($1, 'L', $3, 5, 'lesson'), ($2, 'A', $3, 5, 'activity')`,
    [f.lesson, f.activity, track]);
  await db.query(`INSERT INTO public.questionnaire (id, track_id, kind, points) VALUES ($1, $2, 'checkin', 7)`, [f.checkin, track]);
  return f;
}

async function complete(db: Client, user: string, type: "lesson" | "questionnaire", item: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, questionnaire_id, item_name, score)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'lesson' THEN $2::uuid END, CASE WHEN $3 = 'questionnaire' THEN $2::uuid END, 't', 0)
     RETURNING id::text`, [user, item, type]);
  return r.rows[0].id;
}

async function state(db: Client, user: string): Promise<{ moosies: number; awards: { amount: number; source_id: string }[] }> {
  const u = await db.query(`SELECT moosies::int FROM public."user" WHERE id = $1`, [user]);
  const a = await db.query(`SELECT amount, source_id FROM public.moosie_awards WHERE user_id = $1 ORDER BY created_at, source_id`, [user]);
  return { moosies: u.rows[0].moosies, awards: a.rows };
}

test("a completion pays the item's own points once: one ledger row, balance + points", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    const id = await complete(db, f.user, "lesson", f.lesson);
    assert.deepEqual(await state(db, f.user), { moosies: 5, awards: [{ amount: 5, source_id: id }] });
  });
});

test("double insert pays once: a second lesson completion is refused (23505) and a replayed award is a no-op", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    const id = await complete(db, f.user, "lesson", f.lesson);
    await db.query("SAVEPOINT dup");
    await assert.rejects(complete(db, f.user, "lesson", f.lesson), (e: { code?: string }) => e.code === "23505");
    await db.query("ROLLBACK TO SAVEPOINT dup");
    const replay = await db.query(
      `INSERT INTO public.moosie_awards (user_id, amount, reason, source_id) VALUES ($1, 99, 'completion', $2)
       ON CONFLICT (reason, source_id) DO NOTHING RETURNING id`, [f.user, id]);
    assert.equal(replay.rowCount, 0);
    assert.deepEqual(await state(db, f.user), { moosies: 5, awards: [{ amount: 5, source_id: id }] });
  });
});

test("an activity completion pays 0 (a 0 ledger row) even when the lesson carries points", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    const id = await complete(db, f.user, "lesson", f.activity);
    assert.deepEqual(await state(db, f.user), { moosies: 0, awards: [{ amount: 0, source_id: id }] });
  });
});

test("a recurring check-in pays on every new completion row", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    const a = await complete(db, f.user, "questionnaire", f.checkin);
    const b = await complete(db, f.user, "questionnaire", f.checkin);
    const s = await state(db, f.user);
    assert.equal(s.moosies, 14);
    assert.deepEqual(s.awards.map((x) => x.amount), [7, 7]);
    assert.deepEqual(new Set(s.awards.map((x) => x.source_id)), new Set([a, b]));
  });
});

test("no points → moosi_to_add; no points and moosi_to_add 0 → 0", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    await db.query(`UPDATE public.lessons SET points = NULL WHERE id = $1`, [f.lesson]);
    await complete(db, f.user, "lesson", f.lesson);
    assert.equal((await state(db, f.user)).moosies, 10);
    const g = await fixture(db, 0);
    await db.query(`UPDATE public.lessons SET points = NULL WHERE id = $1`, [g.lesson]);
    await complete(db, g.user, "lesson", g.lesson);
    assert.deepEqual((await state(db, g.user)).awards.map((x) => x.amount), [0]);
  });
});

test("the app's path: a completion inserted AS authenticated still pays, and the app cannot write the ledger", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: f.user, role: "authenticated" })]);
    await db.query("SET LOCAL ROLE authenticated");
    await complete(db, f.user, "lesson", f.lesson);
    await db.query("SAVEPOINT w");
    await assert.rejects(
      db.query(`INSERT INTO public.moosie_awards (user_id, amount, reason, source_id) VALUES ($1, 1000, 'completion', '999999999')`, [f.user]),
      (e: { code?: string }) => e.code === "42501");
    await db.query("ROLLBACK TO SAVEPOINT w");
    await db.query("RESET ROLE");
    assert.equal((await state(db, f.user)).moosies, 5);
  });
});
