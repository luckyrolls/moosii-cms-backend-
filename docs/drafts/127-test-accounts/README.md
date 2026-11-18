# 127 local test — test accounts + reset

Throwaway-Postgres harness for `migrations/127_test_accounts.sql`, run against a **schema-only dump
of Moosii's `public` schema**, so it exercises the real 354 policies, triggers, grants and functions
rather than stubs. The dump is not committed; `run.sh` regenerates it (read-only).

```
bash docs/drafts/127-test-accounts/run.sh
```

Seven steps: dump Moosii (read-only) → `initdb` a cluster on 55433 → `stubs.sql` + restore →
`defaults.sql` → **fidelity check** → apply 127 → re-apply (127 *is* re-runnable, unlike 126) →
the node behaviour suite. `WORK=<dir>` keeps the artifacts; `KEEP=1` leaves the cluster running so
the suite can be re-run against it while iterating. Port 55433, so it cannot collide with the 126
harness on 55432.

**The behaviour suite is `src/lib/__tests__/testAccounts.db.test.ts`**, not a `.sql` file. It skips
itself unless `MOOSIE_TEST_DB_URL` is set, and `run.sh` sets it to the cluster it just built — so
the same 14 assertions run here and under `npm test` on any machine that has a local 127 database.

**Fidelity gate.** Step 4 asserts the thing this migration actually depends on: the **grants on
`public."user"`**. Live on both projects (2026-11-17) `authenticated` holds **no** table-level
UPDATE or INSERT, column UPDATE on exactly **10** columns and column INSERT on exactly **4**
(migration 112). If the restore does not reproduce that, 127's privilege VERIFY proves nothing and
the run must be discarded. Also printed: the `public` policy count (354) and the count of
`onboarding_complete IS NULL` rows (0 — a schema-only dump restores no rows).

## Traps this harness encodes

* `pg_ctl start` hangs unless stdout/stderr are redirected (`-l`).
* `PGCLIENTENCODING=UTF8`, or Windows psql reads the `.sql` files as a code page.
* **Supabase's `ALTER DEFAULT PRIVILEGES` must go on AFTER the restore** (`defaults.sql`), never in
  `stubs.sql`. Before the restore they grant `ALL` on every *restored* table too, which destroyed
  fidelity on the first run: `authenticated` ended up with table-level UPDATE on `"user"` and column
  grants on all 47 columns. They have to exist at all, though, or 127's `REVOKE`s look unnecessary
  and its privilege assertions pass for the wrong reason.
* **`"user".daily_reminder_time` is NOT NULL with no default** — every fixture user must supply it.
* **`"user".birth_date` is NOT NULL `DEFAULT now()`** — see the defect below.
* **`user_mlp.with_quiz` is NOT NULL** with no default.
* **`user_facts_one_per_instant` is UNIQUE (user_id, fact_key, observed_at)** and `now()` is the
  TRANSACTION timestamp, so several defaulted fact rows in one transaction all collide (23505). The
  fixture gives each a distinct `observed_at`.
* **A raised exception ABORTS the enclosing transaction.** Every expected failure therefore runs
  inside a `SAVEPOINT` (`expectRaise` in the test file). Without it, each statement after the first
  refusal fails with `25P02` — an error carrying no HINT, which made five *correct* refusals look
  like missing HINTs on the first run. (Compare the 126 harness, where each case was a separate
  psql statement and the problem did not arise.)
* `request.jwt.claims` is not cleared by `RESET ROLE`; the cases that set it clear it explicitly.

## Fixture

One flagged test account with a child, a completed lesson (which fires
`completed_items_insert_trigger` → `trigger_add_moosies`, so the ledger **and** the balance are
non-zero and the zeroing is a real assertion), a `user_mlp` row, a `user_configurations` row, and
four `user_facts` — one each of `derived`, `manual`, `platform_api`, `seed`. Plus a `super_admin`
and a plain `admin` to act as `p_actor`, so the role check is tested from both sides.

## Result — 2026-11-17, all 14 cases pass

**One real defect in the migration was found and fixed by this suite.** The first version of
`reset_test_account` set `birth_date = NULL` at full depth. `"user".birth_date` is **NOT NULL
DEFAULT now()**, so a full reset would have raised **23502 on every real account**. The fix uses
`SET col = DEFAULT` for the columns that have a default (`birth_date`, `name`) and NULL only for
the nullable ones, which also survives a later change of default. An empty table would have hidden
this completely — it is only visible because the fixture gives the account a profile.

Two harness defects of my own were also found and are now encoded above: the missing savepoints,
and the `ALTER DEFAULT PRIVILEGES` ordering (caught by step 4's own gate, then confirmed by 127's
VERIFY failing for the right reason).
