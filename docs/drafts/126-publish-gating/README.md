# 126 local test — publish gating + archive audit

Throwaway-Postgres harness for `migrations/126_publish_gating_and_archive_audit.sql`, run against a
**schema-only dump of Moosii's `public` schema**, so it exercises the real 355 policies, triggers and
functions rather than stubs. The dump is not committed; `run.sh` regenerates it (read-only).

```
bash docs/drafts/126-publish-gating/run.sh
```

Eight steps: dump Moosii (read-only) → `initdb` a cluster on 55432 → `stubs.sql` + restore →
**fidelity check** → `seed.sql` → apply 126 → `tests.sql` → re-apply to prove the file is once-only.
`WORK=<dir>` keeps the artifacts; otherwise a temp dir is used and the server is stopped on exit.

**Fidelity gate.** Step 4 prints `md5(replace(prosrc, chr(13), ''))` for `set_lesson_published` and
`user_active_tracks_for_user` plus the policy count. On 2026-11-14 the restored schema matched live
exactly: `d418d1eb451ab14428c8055b6946ff2c`, `fdcb72046a7a5407e83b43e79a623417`, 355 policies. If
those drift from live, the run proves nothing — re-dump first.

## Traps this harness encodes

* `pg_ctl start` hangs unless stdout/stderr are redirected (`-l`).
* `PGCLIENTENCODING=UTF8`, or Windows psql reads the `.sql` files as a code page.
* `"user".daily_reminder_time` is NOT NULL with no default — every fixture user must supply it.
* **`sub_segments_reset_review_trg` fires on INSERT** and forces the whole segment back to `draft`,
  so a `review_state` supplied in an INSERT is discarded. The seed sets it in a following UPDATE,
  which is not in that trigger's column list.
* **`now()` is the transaction timestamp.** Archiving the same row twice inside one transaction sets
  the identical value, so `IS NOT DISTINCT` makes it a no-op and the guard correctly does not fire.
  Use `clock_timestamp()` or separate rows. (This produced a false "BUG" on the first run.)
* **`request.jwt.claims` is not cleared by `RESET ROLE`.** Every case clears it explicitly, or the
  next "no JWT" case silently inherits the previous actor. (Second false "BUG" on the first run.)

## Fixture

| actor | role | capabilities |
|---|---|---|
| `aaaaaaaa…0001` | super_admin | editorial + clinical, and `can_publish` once 126 runs |
| `aaaaaaaa…0002` | admin | none |
| `aaaaaaaa…0003` | admin | clinical only |

| lesson | state |
|---|---|
| L1 | approved, no quiz — publishable |
| L2 | one `pending` segment (a `draft` card) |
| L3 | approved, one **pending** quiz question |
| L4 | approved, in an **archived** track |
| L5 | no segment at all |
| L6 | approved, one **approved** quiz question |
| L7 | **already published** with a pending quiz — the shape of the 5 live Moosii rows |

L7 is inserted published *before* 126 runs, because after 126 a lesson cannot be created published.
That is deliberate: it is the only way to reproduce the pre-existing rows the migration must leave
alone.

## Result — 2026-11-14, all 30 cases as intended

One real defect was found and fixed by this suite: `lesson_publish_blocker` used
`SELECT true … INTO v_found`, which leaves `v_found` **NULL** when no row matches, so `IF NOT v_found`
was never true and an unknown lesson id was reported as `publish_not_approved` instead of
`not_found`. Replaced with `IF NOT FOUND`. The suite also prompted closing an INSERT hole (a lesson
could be created already published, bypassing an UPDATE-only trigger).
