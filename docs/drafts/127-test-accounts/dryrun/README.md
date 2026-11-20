# Rolled-back dry run of `reset_test_account` (migration 127)

Exercises the real function against a real project and **persists nothing**. Run it before any
change to `reset_test_account`, and after any migration that adds a per-user table — the reset's
table list is hand-maintained, so a new table is silently *not* reset until someone adds it.

```
PGCLIENTENCODING=UTF8 psql "$MOOSII_DB_URL" -A -F'|' --pset footer=off \
  -v email=someone@example.com -v depth=activity \
  -f docs/drafts/127-test-accounts/dryrun/dry.sql > out.txt

python docs/drafts/127-test-accounts/dryrun/cmp.py out.txt
```

`-v email=` is the only account touched; `-v depth=` is `activity` or `full`. Four runs cover the
matrix (financial × Moosii, activity × full). The target must already be flagged
`is_test_account` or the function refuses with `not_test_account` — that interlock is the point,
so do not work around it.

## Nothing may ever persist

* **There is no `COMMIT` in any file here, and none may be added.** The reset runs inside
  `BEGIN … ROLLBACK`; the counts either side run inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`,
  which cannot write at all.
* `ON_ERROR_STOP` is on, so a raise exits psql and the open transaction dies with the connection
  — still no commit.
* Phase **C** re-counts everything from a transaction of its own. The proof that nothing persisted
  therefore does not come from the transaction that did the work.
* Do **not** use `PGOPTIONS='-c default_transaction_read_only=on'`. The Supabase pooler silently
  drops it and the session comes back writable (observed 2026-11-17); the connection role is
  `postgres`, which has BYPASSRLS, so nothing else would stop a stray write.

## The files

| file | what |
|---|---|
| `dry.sql` | the driver: resolves the account, freezes its child ids, runs the four phases |
| `counts.sql` | one phase's counts — 64 metrics, included four times by `\ir` |
| `cmp.py` | reads the output and does the comparing |

**`dry.sql` sets `\x on` and `cmp.py` parses that expanded `column|value` form.** They have to stay
in step; switching the driver to aligned output makes the comparison silently wrong, not failed.

**Child ids are FROZEN** by `dry.sql` before any delete. At `full` depth the `children` rows are
themselves deleted, so a live subquery would report 0 for every child-keyed table (`child_milestones`,
`distress_detections`, `health_detections`) whether or not their rows actually went — the frozen
list is what makes the after-count mean something.

## Reading `cmp.py`

Five blocks:

1. **`returned.deleted`** — what the function says it deleted (non-zero entries only).
2. **metrics that CHANGED inside the transaction** — what actually changed, measured independently.
   **These two blocks must agree.** A key in `returned.deleted` with no matching change, or a
   change the return value doesn't claim, is a defect.
3. **ROLLBACK proof** — phase A vs phase C. Must print `IDENTICAL on all 64 metrics`. Any
   `!! DRIFT` line means something persisted: stop and investigate.
4. **never-touched columns** — `role`, the three capability columns, `is_test_account`, email
   presence, `auth_provider`, `daily_reminder_time`, notification prefs, `created_at`, and
   `facts_seed`. All must read `OK`.
   **`audit_rows` is listed here but is EXPECTED to go 1 → 2**: that is the reset's own audit row,
   written in the same transaction (and rolled back with it). It is the one entry in this block
   that should change.
5. **reset-target user columns** — `before -> after` for everything `full` clears. At `activity`
   depth none of them may change except `moosies`.

## What a correct `full` run looks like

`onboarding_complete`, `has_seen_mlp_intro`, `has_seen_lesson_intro` and
`has_seen_questionnaire_intro` all land on explicit `false` (never NULL); `name` becomes `''` and
`birth_date` becomes **now()**, because both are `NOT NULL` with a default and `SET col = DEFAULT`
is what keeps that correct. `birth_date` is therefore the reset timestamp, not NULL — after a full
reset it is indistinguishable from a real one set at that moment, so
**`onboarding_complete = false` is the only reliable "needs onboarding" signal.**

A first version of this function set `birth_date = NULL` and would have raised 23502 on every real
account; the local harness in `../` caught it. This dry run is the second line of defence, against
a live row.

## Baseline — 2026-11-19, all four runs green

Mark's account on both projects, both depths: every `returned.deleted` count agreed exactly with
the measured delta; all four printed `IDENTICAL on all 64 metrics`; every denylist column `OK`.
Moosii's one child exercised the `child_id = ANY(...)` branch for real (`health_detections` 1 → 0),
and `moosies` went 54 → 0 with `user_moosies_zeroed: 1`. Afterwards `test_account_events` still
held only the migration's flag rows (financial 1, Moosii 2) and **zero** `reset%` rows.
