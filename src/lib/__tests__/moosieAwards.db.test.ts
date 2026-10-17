// Migrations 111–112 — the Moosies award trigger + ledger, and the "user" column lock, against a REAL Postgres.
//
// Needs MOOSIE_TEST_DB_URL → a THROWAWAY LOCAL database restored from a schema-only dump of Moosii with 111 applied
// (recipe: docs/drafts/111-moosies/README.md; then apply 112). Without it every test SKIPS, so a plain `npm test` stays offline.
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

// ---- migration 112: diagnostics pay once (F33) + "user" column lock (F32) ----

async function questionnaire(db: Client, kind: "diagnostic" | "checkin", points = 7): Promise<string> {
  const t = await db.query(`INSERT INTO public.tracks (track_name) VALUES ('m112 test') RETURNING id`);
  const q = await db.query(`INSERT INTO public.questionnaire (track_id, kind, points) VALUES ($1, $2, $3) RETURNING id`,
    [t.rows[0].id, kind, points]);
  return q.rows[0].id;
}

async function asAuthenticated(db: Client, user: string): Promise<void> {
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: "authenticated" })]);
  await db.query("SET LOCAL ROLE authenticated");
}

async function expectCode(db: Client, sql: string, params: unknown[], code: string): Promise<void> {
  await db.query("SAVEPOINT e");
  await assert.rejects(db.query(sql, params), (e: { code?: string }) => e.code === code, sql);
  await db.query("ROLLBACK TO SAVEPOINT e");
}

test("a diagnostic pays on the first completion only; retakes pay 0 but still write a ledger row", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    const diag = await questionnaire(db, "diagnostic");
    const ids = [await complete(db, f.user, "questionnaire", diag), await complete(db, f.user, "questionnaire", diag),
                 await complete(db, f.user, "questionnaire", diag)];
    const s = await state(db, f.user);
    assert.equal(s.moosies, 7);
    assert.deepEqual(s.awards.map((a) => [a.source_id, a.amount]).sort(), [[ids[0], 7], [ids[1], 0], [ids[2], 0]].sort());
  });
});

test("a diagnostic retake by ANOTHER user still pays that user (the rule is per user)", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    const g = await fixture(db);
    const diag = await questionnaire(db, "diagnostic");
    await complete(db, f.user, "questionnaire", diag);
    await complete(db, g.user, "questionnaire", diag);
    assert.equal((await state(db, f.user)).moosies, 7);
    assert.equal((await state(db, g.user)).moosies, 7);
  });
});

test("racing first completions of one diagnostic pay once (advisory lock serializes them)", { skip }, async () => {
  const host = new URL(URL_!).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`MOOSIE_TEST_DB_URL must point at a local throwaway database, not ${host}`);
  const setup = new Client({ connectionString: URL_ });
  const a = new Client({ connectionString: URL_ });
  const b = new Client({ connectionString: URL_ });
  await Promise.all([setup.connect(), a.connect(), b.connect()]);
  let f: Fixture | undefined;
  let diag: string | undefined;
  try {
    f = await fixture(setup);                       // committed: both racers must see the fixture rows
    diag = await questionnaire(setup, "diagnostic");
    await a.query("BEGIN");
    await b.query("BEGIN");
    await complete(a, f.user, "questionnaire", diag);                  // A holds the lock, uncommitted
    const bDone = complete(b, f.user, "questionnaire", diag);          // B waits on A's lock
    await new Promise((r) => setTimeout(r, 300));
    await a.query("COMMIT");
    await bDone;
    await b.query("COMMIT");
    const s = await state(setup, f.user);
    assert.equal(s.moosies, 7);
    assert.deepEqual(s.awards.map((x) => x.amount).sort(), [0, 7]);
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
    if (f) await setup.query(`DELETE FROM auth.users WHERE id = $1`, [f.user]).catch(() => undefined);   // cascades
    if (diag) await setup.query(`DELETE FROM public.questionnaire WHERE id = $1`, [diag]).catch(() => undefined);
    await Promise.all([setup.end(), a.end(), b.end()]);
  }
});

test("authenticated cannot UPDATE moosies (42501) — nor role / review capabilities / email", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    await asAuthenticated(db, f.user);
    for (const col of ["moosies", "role", "can_review_editorial", "can_approve_clinical", "is_verified", "email"]) {
      await expectCode(db, `UPDATE public."user" SET "${col}" = "${col}" WHERE id = $1`, [f.user], "42501");
    }
    await expectCode(db, `UPDATE public."user" SET moosies = 1000000 WHERE id = $1`, [f.user], "42501");
    await db.query("RESET ROLE");
    assert.equal((await state(db, f.user)).moosies, 0);
  });
});

test("authenticated UPDATE of each column the clients write still succeeds", { skip }, async () => {
  const writes: Record<string, unknown> = {
    display_name: "Pat", name: "Lee", gender: "female", parenting_status: "expecting", financials: "stable",
    birth_date: "1990-05-01T00:00:00Z", onboarding_complete: true, has_seen_mlp_intro: true,
    has_seen_lesson_intro: true, has_seen_questionnaire_intro: true,
  };
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    await asAuthenticated(db, f.user);
    for (const [col, val] of Object.entries(writes)) {
      const r = await db.query(`UPDATE public."user" SET "${col}" = $2 WHERE id = $1 RETURNING id`, [f.user, val]);
      assert.equal(r.rowCount, 1, col);
    }
  });
});

test("authenticated INSERT of its own row: the onboarding columns work, moosies / role are refused", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const id = randomUUID();
    await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [id]);
    await asAuthenticated(db, id);
    await expectCode(db, `INSERT INTO public."user" (id, daily_reminder_time, moosies) VALUES ($1, '09:00', 1000000)`, [id], "42501");
    await expectCode(db, `INSERT INTO public."user" (id, daily_reminder_time, role) VALUES ($1, '09:00', 'super_admin')`, [id], "42501");
    const r = await db.query(
      `INSERT INTO public."user" (id, email, daily_reminder_time, onboarding_complete) VALUES ($1, $2, '09:00', false)`,
      [id, `m112-${id}@example.test`]);
    assert.equal(r.rowCount, 1);
    await db.query("RESET ROLE");
    const u = await db.query(`SELECT moosies::int, role FROM public."user" WHERE id = $1`, [id]);
    assert.deepEqual(u.rows[0], { moosies: 0, role: "user" });
  });
});

test("the award trigger still moves the balance after the lock (service and app inserts)", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);
    await complete(db, f.user, "questionnaire", f.checkin);             // service / postgres
    await asAuthenticated(db, f.user);
    await complete(db, f.user, "lesson", f.lesson);                     // as the app
    await db.query("RESET ROLE");
    assert.equal((await state(db, f.user)).moosies, 12);
  });
});

test("authenticated cannot INSERT a \"user\" row for ANOTHER id (RLS 42501); its own row still works", { skip }, async () => {
  await inRolledBackTx(async (db) => {
    const f = await fixture(db);                     // the signed-in caller (has a row)
    const other = randomUUID();                      // an auth user with no "user" row yet
    await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [other]);
    await asAuthenticated(db, f.user);
    await expectCode(db,
      `INSERT INTO public."user" (id, email, daily_reminder_time, onboarding_complete) VALUES ($1, $2, '09:00', false)`,
      [other, `m112-squat-${other}@example.test`], "42501");
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: other, role: "authenticated" })]);
    const r = await db.query(
      `INSERT INTO public."user" (id, email, daily_reminder_time, onboarding_complete) VALUES ($1, $2, '09:00', false)`,
      [other, `m112-own-${other}@example.test`]);
    assert.equal(r.rowCount, 1);
  });
});
