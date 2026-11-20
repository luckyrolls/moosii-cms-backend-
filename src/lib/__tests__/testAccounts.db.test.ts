// Migration 127 — the is_test_account flag, its guard, and reset_test_account at both depths,
// against a REAL Postgres.
//
// Needs MOOSIE_TEST_DB_URL → the THROWAWAY LOCAL database from
// docs/drafts/127-test-accounts/README.md with 127 applied. Without it every test SKIPS. Refuses
// any non-local host. Every test runs inside BEGIN … ROLLBACK, so the fixture never persists.
//
// These are the cases the route tests cannot reach: a privilege refusal, the not_test_account
// interlock, the column denylist, and the fact-source split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const URL_ = process.env.MOOSIE_TEST_DB_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const skip = !URL_ ? "MOOSIE_TEST_DB_URL not set (local 127 test DB)" : false;

async function tx(fn: (db: Client) => Promise<void>): Promise<void> {
  const host = new URL(URL_!).hostname;
  if (!LOCAL_HOSTS.has(host))
    throw new Error(`MOOSIE_TEST_DB_URL must point at a local throwaway database, not ${host}`);
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

type F = {
  user: string;
  superAdmin: string;
  plainAdmin: string;
  child: string;
  lesson: string;
  factKey: string;
};

// One flagged test account with: a child, a completed lesson (which fires trigger_add_moosies, so
// the balance and the ledger are both non-zero), an MLP row, demographics, and four user_facts —
// one per source we care about. Plus a super_admin and a plain admin to act as p_actor.
async function fixture(db: Client, opts: { flagged: boolean } = { flagged: true }): Promise<F> {
  const f: F = {
    user: randomUUID(),
    superAdmin: randomUUID(),
    plainAdmin: randomUUID(),
    child: randomUUID(),
    lesson: randomUUID(),
    factKey: `t127_${randomUUID().slice(0, 8)}`,
  };
  const track = randomUUID();

  for (const id of [f.user, f.superAdmin, f.plainAdmin]) {
    await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [id]);
  }
  // daily_reminder_time is NOT NULL with no default — every fixture user must supply it.
  await db.query(
    `INSERT INTO public."user" (id, email, role, daily_reminder_time, moosies, onboarding_complete,
                               display_name, gender, parenting_status, is_verified, can_publish,
                               can_approve_clinical, can_review_editorial, has_seen_mlp_intro,
                               is_test_account)
     VALUES ($1, $2, 'user', '09:00', 0, true, 'Test Parent', 'f', 'parent', true, false, true, true, true, $3)`,
    [f.user, `t127_${f.user.slice(0, 8)}@example.test`, opts.flagged]
  );
  await db.query(
    `INSERT INTO public."user" (id, role, daily_reminder_time, moosies, onboarding_complete)
     VALUES ($1, 'super_admin', '09:00', 0, true), ($2, 'admin', '09:00', 0, true)`,
    [f.superAdmin, f.plainAdmin]
  );
  await db.query(
    `INSERT INTO public.user_configurations (user_id, daily_limit, mlp_limit, moosi_to_add, monthly_fee, yearly_fee, free_trial_days)
     VALUES ($1, 3, 10, 10, 0, 0, 0)`,
    [f.user]
  );
  await db.query(`INSERT INTO public.children (id, parent_id, nickname, birth_year, birth_month) VALUES ($1, $2, 'Kid', 2025, 3)`,
    [f.child, f.user]);
  await db.query(`INSERT INTO public.tracks (id, track_name) VALUES ($1, 'm127')`, [track]);
  await db.query(
    `INSERT INTO public.lessons (id, lesson_name, track_id, points, kind) VALUES ($1, 'L127', $2, 5, 'lesson')`,
    [f.lesson, track]
  );
  // fires completed_items_insert_trigger -> trigger_add_moosies: a moosie_awards row AND a balance
  await db.query(
    `INSERT INTO public.completed_items (user_id, item_id, item_type, item_name, lesson_id)
     VALUES ($1, $2, 'lesson', 'L127', $2)`,
    [f.user, f.lesson]
  );
  await db.query(
    // with_quiz is NOT NULL on user_mlp (no default) — the fixture must supply it.
    `INSERT INTO public.user_mlp (user_id, item_id, item_type, item_name, position, track_id, with_quiz)
     VALUES ($1, $2, 'lesson', 'L127', 1, $3, false)`,
    [f.user, f.lesson, track]
  );
  await db.query(`INSERT INTO public.fact_keys (fact_key, kind, label) VALUES ($1, 'enum', 't')`, [f.factKey]);
  await db.query(
    `INSERT INTO public.fact_values (fact_key, value, label) VALUES ($1,'a','A'),($1,'b','B'),($1,'c','C'),($1,'d','D')`,
    [f.factKey]
  );
  // observed_at must DIFFER per row: user_facts_one_per_instant is UNIQUE (user_id, fact_key,
  // observed_at) and `now()` is the TRANSACTION timestamp, so four defaulted rows all collide
  // (23505). Same trap the 126 harness documents for archived_at.
  await db.query(
    `INSERT INTO public.user_facts (user_id, fact_key, value, source, observed_at) VALUES
       ($1,$2,'a','derived',      now() - interval '4 min'),
       ($1,$2,'b','manual',       now() - interval '3 min'),
       ($1,$2,'c','platform_api', now() - interval '2 min'),
       ($1,$2,'d','seed',         now() - interval '1 min')`,
    [f.user, f.factKey]
  );
  return f;
}

const one = async (db: Client, sql: string, p: unknown[] = []): Promise<Record<string, unknown>> =>
  (await db.query(sql, p)).rows[0];

// EVERY expected failure must run inside a SAVEPOINT.
//
// A raised exception ABORTS the enclosing transaction, so without this each statement after the
// first refusal fails with 25P02 ("current transaction is aborted") — an error with no hint, which
// made five correct refusals look like missing HINTs on the first harness run. The savepoint lets
// the test keep asserting after a refusal, which is the whole point of these cases.
type PgErr = { code?: string; hint?: string; message?: string };

async function expectRaise(
  db: Client,
  sql: string,
  params: unknown[],
  expect: { code?: string; hint?: string },
  label: string
): Promise<void> {
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(`SAVEPOINT ${sp}`);
  let err: PgErr | null = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    err = e as PgErr;
  } finally {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
  assert.ok(err, `${label}: expected a refusal, but the statement succeeded`);
  if (expect.code) assert.equal(err!.code, expect.code, `${label}: ERRCODE`);
  if (expect.hint) assert.equal(err!.hint, expect.hint, `${label}: HINT`);
}

const reset = (db: Client, user: string, depth: string, actor: string | null) =>
  one(db, `SELECT public.reset_test_account($1, $2, $3) AS r`, [user, depth, actor]);

// ---------------------------------------------------------------- the flag is unwritable

test("authenticated cannot UPDATE is_test_account — 42501 at the privilege layer", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db, { flagged: false });
    await db.query(`SET LOCAL ROLE authenticated`);
    await db.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`, [f.user]);
    // 42501 insufficient_privilege: there is NO column grant, so RLS is never even consulted.
    await expectRaise(
      db,
      `UPDATE public."user" SET is_test_account = true WHERE id = $1`,
      [f.user],
      { code: "42501" },
      "a signed-in user must not be able to flag their own account"
    );
    // request.jwt.claims is NOT cleared by RESET ROLE — clear it explicitly or the next case inherits it.
    await db.query(`SELECT set_config('request.jwt.claims', NULL, true)`);
    await db.query(`RESET ROLE`);
  });
});

test("the trigger refuses a non-super_admin JWT even where a grant would allow it", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db, { flagged: false });
    // Prove the SECOND layer independently of the first: as the table owner the grant is not the
    // obstacle, so what refuses here can only be test_account_flag_guard.
    await db.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`, [f.plainAdmin]);
    await expectRaise(
      db,
      `UPDATE public."user" SET is_test_account = true WHERE id = $1`,
      [f.user],
      { code: "23514", hint: "test_account_not_permitted" },
      "a plain admin's JWT"
    );
    // …and a super_admin's JWT passes the same write.
    await db.query(`SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`, [f.superAdmin]);
    await db.query(`UPDATE public."user" SET is_test_account = true WHERE id = $1`, [f.user]);
    const row = await one(db, `SELECT is_test_account FROM public."user" WHERE id = $1`, [f.user]);
    assert.equal(row.is_test_account, true);
    await db.query(`SELECT set_config('request.jwt.claims', NULL, true)`);
  });
});

test("a super_admin may flag their OWN login — the check is role-based, never identity-based", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db, { flagged: false });
    const r = (await one(db, `SELECT public.set_test_account($1, true, $1) AS r`, [f.superAdmin])).r as {
      found: boolean; is_test_account: boolean; changed: boolean;
    };
    assert.equal(r.found, true);
    assert.equal(r.is_test_account, true, "Mark and Michelle flag their own accounts first");
    assert.equal(r.changed, true);
  });
});

test("set_test_account refuses a plain admin as actor, and is idempotent", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db, { flagged: false });
    await expectRaise(
      db,
      `SELECT public.set_test_account($1, true, $2)`,
      [f.user, f.plainAdmin],
      { hint: "test_account_not_permitted" },
      "set_test_account with a plain-admin actor"
    );
    // first flag writes an event; the second is a no-op and writes none
    await db.query(`SELECT public.set_test_account($1, true, $2)`, [f.user, f.superAdmin]);
    const again = (await one(db, `SELECT public.set_test_account($1, true, $2) AS r`, [f.user, f.superAdmin])).r as {
      changed: boolean;
    };
    assert.equal(again.changed, false, "re-flagging must not write a second audit row");
    const n = await one(db, `SELECT count(*)::int AS c FROM public.test_account_events WHERE user_id = $1`, [f.user]);
    assert.equal(n.c, 1);
  });
});

// ---------------------------------------------------------------- the reset interlock

test("reset refuses an account that is NOT flagged — HINT not_test_account", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db, { flagged: false });
    for (const depth of ["activity", "full"]) {
      await expectRaise(
        db,
        `SELECT public.reset_test_account($1, $2, $3)`,
        [f.user, depth, f.superAdmin],
        { code: "23514", hint: "not_test_account" },
        `depth ${depth} on an unflagged account`
      );
    }
    // and nothing was deleted on the way to the refusal
    const n = await one(db, `SELECT count(*)::int AS c FROM public.completed_items WHERE user_id = $1`, [f.user]);
    assert.equal(n.c, 1, "a refused reset must not have deleted anything");
  });
});

test("reset refuses a bad depth and a non-super_admin actor", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await expectRaise(
      db,
      `SELECT public.reset_test_account($1, 'everything', $2)`,
      [f.user, f.superAdmin],
      { hint: "bad_depth" },
      "a depth that is neither literal"
    );
    await expectRaise(
      db,
      `SELECT public.reset_test_account($1, 'activity', $2)`,
      [f.user, f.plainAdmin],
      { hint: "test_account_not_permitted" },
      "reset with a plain-admin actor"
    );
    // the refusals changed nothing — the savepoint rolled each back, and the guard returns before
    // any DELETE either way
    const n = await one(db, `SELECT count(*)::int AS c FROM public.completed_items WHERE user_id = $1`, [f.user]);
    assert.equal(n.c, 1);
  });
});

// ---------------------------------------------------------------- activity depth

test("activity reset clears what the parent did, zeroes moosies, and keeps onboarding", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const before = await one(db, `SELECT moosies, onboarding_complete FROM public."user" WHERE id = $1`, [f.user]);
    assert.ok(Number(before.moosies) > 0, "the fixture must have earned moosies for this to mean anything");

    const r = (await reset(db, f.user, "activity", f.superAdmin)).r as { found: boolean; depth: string };
    assert.equal(r.found, true);
    assert.equal(r.depth, "activity");

    const after = await one(
      db,
      `SELECT (SELECT count(*) FROM public.completed_items WHERE user_id = $1)::int AS items,
              (SELECT count(*) FROM public.moosie_awards  WHERE user_id = $1)::int AS awards,
              (SELECT count(*) FROM public.user_mlp       WHERE user_id = $1)::int AS mlp,
              (SELECT moosies FROM public."user" WHERE id = $1)                   AS moosies,
              (SELECT onboarding_complete FROM public."user" WHERE id = $1)       AS onboarded,
              (SELECT count(*) FROM public.children WHERE parent_id = $1)::int    AS kids,
              (SELECT count(*) FROM public.user_configurations WHERE user_id = $1)::int AS config`,
      [f.user]
    );
    assert.equal(after.items, 0, "completed_items");
    assert.equal(after.awards, 0, "moosie_awards");
    assert.equal(after.mlp, 0, "user_mlp");
    assert.equal(Number(after.moosies), 0, "the balance must be zeroed explicitly — no DELETE trigger does it");
    // onboarding survives an activity reset
    assert.equal(after.onboarded, true, "activity depth must not touch onboarding_complete");
    assert.equal(after.kids, 1, "activity depth keeps children");
    assert.equal(after.config, 1, "activity depth keeps user_configurations");
  });
});

test("activity reset deletes derived+manual facts and KEEPS seed and platform_api", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await reset(db, f.user, "activity", f.superAdmin);
    const rows = (
      await db.query(`SELECT source FROM public.user_facts WHERE user_id = $1 ORDER BY source`, [f.user])
    ).rows.map((r: { source: string }) => r.source);
    assert.deepEqual(rows, ["platform_api", "seed"], "derived+manual go; platform_api and seed stay");
  });
});

// ---------------------------------------------------------------- full depth

test("full reset re-onboards: onboarding_complete FALSE (never null), intros false, children gone", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await reset(db, f.user, "full", f.superAdmin);
    const u = await one(
      db,
      `SELECT onboarding_complete, has_seen_mlp_intro, has_seen_lesson_intro, has_seen_questionnaire_intro,
              display_name, gender, parenting_status, daily_reminder_time, birth_date, name,
              (SELECT count(*) FROM public.children WHERE parent_id = $1)::int AS kids,
              (SELECT count(*) FROM public.user_demographic_responses WHERE user_id = $1)::int AS demo
         FROM public."user" WHERE id = $1`,
      [f.user]
    );
    assert.equal(u.onboarding_complete, false, "must be FALSE");
    assert.notEqual(u.onboarding_complete, null, "NULL would read as `true` in moosii-rn (useUserProfile.ts:42)");
    assert.equal(u.has_seen_mlp_intro, false);
    assert.equal(u.has_seen_lesson_intro, false);
    assert.equal(u.has_seen_questionnaire_intro, false);
    assert.equal(u.display_name, null, "profile cleared");
    assert.equal(u.gender, null);
    assert.equal(u.parenting_status, null);
    assert.ok(u.daily_reminder_time, "daily_reminder_time is NOT NULL with no default — must be left alone");
    // NOT NULL columns go back to their DEFAULT, never to NULL. Nulling birth_date raised 23502 on
    // the first harness run; this assertion is what keeps that from coming back.
    assert.ok(u.birth_date, "birth_date is NOT NULL DEFAULT now() — reset to the default, not NULL");
    assert.equal(u.name, "", "name is DEFAULT ''::text");
    assert.equal(u.kids, 0, "children are deleted at full depth");
    assert.equal(u.demo, 0);
  });
});

test("full reset NEVER touches the denylisted identity and authority columns", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const DENY = [
      "id", "email", "role", "can_review_editorial", "can_approve_clinical",
      "can_publish", "is_verified", "auth_provider", "is_test_account",
    ];
    const cols = DENY.join(", ");
    const before = await one(db, `SELECT ${cols} FROM public."user" WHERE id = $1`, [f.user]);
    await reset(db, f.user, "full", f.superAdmin);
    const after = await one(db, `SELECT ${cols} FROM public."user" WHERE id = $1`, [f.user]);
    assert.deepEqual(after, before, "a full reset must leave identity and authority byte-identical");
    // spelled out, because this is the guarantee that protects the real CMS logins
    assert.equal(after.is_test_account, true, "the account stays flagged, so it can be reset again");
    assert.equal(after.role, "user");
    assert.equal(after.can_approve_clinical, true);
    assert.equal(after.is_verified, true);
  });
});

test("full reset deletes platform_api+estimated too, but STILL keeps seed", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await reset(db, f.user, "full", f.superAdmin);
    const rows = (
      await db.query(`SELECT source FROM public.user_facts WHERE user_id = $1`, [f.user])
    ).rows.map((r: { source: string }) => r.source);
    assert.deepEqual(rows, ["seed"], "seed facts are the demo outcome story — never deleted at either depth");
  });
});

// ---------------------------------------------------------------- the audit trail

test("every reset writes ONE audit row carrying the actor and the per-table counts", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    await reset(db, f.user, "activity", f.superAdmin);
    const e = await one(
      db,
      `SELECT action, actor_id, actor_role, detail FROM public.test_account_events
        WHERE user_id = $1 AND action LIKE 'reset%' ORDER BY created_at DESC LIMIT 1`,
      [f.user]
    );
    assert.equal(e.action, "reset_activity");
    assert.equal(e.actor_id, f.superAdmin, "the actor is p_actor, never the body");
    assert.equal(e.actor_role, "super_admin");
    const detail = e.detail as Record<string, unknown>;
    assert.equal(detail.completed_items, 1, "the audit records what was actually removed");
    assert.equal(detail.moosie_awards, 1);
    assert.equal(
      detail.quiz_user_progress,
      "skipped_no_user_column",
      "the known gap is recorded, not silently skipped"
    );
  });
});

test("an unknown user is {found:false}, not a refusal", { skip }, async () => {
  await tx(async (db) => {
    const f = await fixture(db);
    const r = (await reset(db, randomUUID(), "activity", f.superAdmin)).r as { found: boolean };
    assert.equal(r.found, false);
    const s = (await one(db, `SELECT public.set_test_account($1, true, $2) AS r`, [randomUUID(), f.superAdmin])).r as {
      found: boolean;
    };
    assert.equal(s.found, false);
  });
});

test("the audit table is RLS-on and no client role can write it", { skip }, async () => {
  await tx(async (db) => {
    const g = await one(
      db,
      `SELECT (SELECT relrowsecurity FROM pg_class WHERE oid='public.test_account_events'::regclass) AS rls,
              (SELECT count(*)::int FROM information_schema.role_table_grants
                WHERE table_schema='public' AND table_name='test_account_events'
                  AND grantee IN ('anon','authenticated')
                  AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')) AS writes`
    );
    assert.equal(g.rls, true);
    assert.equal(g.writes, 0);
  });
});
