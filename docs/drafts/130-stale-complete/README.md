# 130 / 131 harness — the stale-`complete` repair and the derived-value guard

```bash
bash docs/drafts/130-stale-complete/run.sh      # ~2 min; KEEP=1 leaves the cluster up
```

Twelve steps on a throwaway PG 17 cluster (port **55436**, clear of the 126/127/128/129
harnesses) restored from a schema-only dump of live Moosii:

| step | what |
|---|---|
| 1–4 | dump, fresh cluster, the 127 harness's `stubs.sql` + `defaults.sql`, restore, `app_settings.domain` |
| 5 | apply 129 **unless the dump already carries it** (checked by md5, not by guesswork) |
| 6 | `fixture.sql` — 5 stale `complete` segments, 3 published lessons, one of them genuinely complete |
| 7 | the pre-repair picture |
| 8 | **131 BEFORE 130 must be REFUSED** (D6: repair first, then guard) |
| 9 | apply 130, then **apply it again** (it must be a clean no-op), then the post-repair picture, the audit rows and `with_quiz` |
| 10 | apply 131, then **apply it again** (refused by the md5 guard) |
| 11 | `src/lib/__tests__/staleCompleteRepair.db.test.ts` (16 tests) |
| 12 | the **undo rehearsal** for both files, in the order their headers specify |

Result, 2026-11-26: fixture OK (5 stale, `L1.with_quiz = true`), 131-before-130 refused with
*"still disagree with the derived value — apply migration 130 (the repair) FIRST"*, 130 re-derives
**5 of 6** segments and unpublishes **1** lesson, the second 130 apply unpublishes **0** and still
VERIFIEs, 131 applies and its second apply is refused by the md5 guard, **16/16 tests green**, and
the undo restores all 5 stale segments and the published lesson exactly.

## What the fixture maps to

| fixture | the live rows it stands for |
|---|---|
| `L1` published + reachable, 1 stale segment | the 4 real `mem` lessons → re-derived **and unpublished** |
| `L2` published under an **archived** track | the 3 real `legacy` ones → re-derived, **left published** |
| `L3` unpublished, stale (+ a cardless `S6`) | the ordinary stale rows, 3 of which are cardless live |
| `L4` published and **genuinely complete** | the 6 live segments that are correctly complete — must not move |
| `S5` orphan (`lesson_id IS NULL`) | the 12 real orphans (67 cards), D4 |
| an **approved** quiz question on `L1` | `lessons.with_quiz` must re-derive to false by itself (063) |

## Four things this harness proves that reading the files cannot

**1. A stale row cannot be made any sanctioned way.** The fixture writes `seg_status` by hand,
because `recompute_seg_status` always writes the truth. That hand-written write is *exactly* what
131 then forbids — which is why the fixture has to run before 131, and why the fixture is the only
place in the harness that touches the column directly. On live Moosii the equivalent write was
056's omission, not a person.

**2. The sanctioned writer passes its own guard.** The trap `FINDINGS-complete-with-draft-cards`
§6.1 warned about: `recompute_seg_status` sets `seg_status` in the same statement the guard
inspects, so a guard that looked at the wrong snapshot would refuse the only legitimate writer.
Step 10's VERIFY recomputes every segment for real, and the suite does it again per segment, plus
through a card transition and through 129's image trigger.

**3. The undo order is load-bearing, in two places.** 131's guard refuses the undo's own
`seg_status` write, so the guard comes off first and goes back last. And 126's content
precondition refuses to re-publish a lesson with no `complete` segment — so the segments must be
restored *before* `is_published`. Reverse either and the undo fails with a `check_violation`
instead of restoring anything.

**4. Re-running 130 is honest, not idempotent-by-accident.** The snapshot is taken once and NOT
retaken, so a second apply still reports "5 changed" relative to the original state while
unpublishing 0 — the numbers describe the repair, not the last run.

## The one thing to review in 130 specifically

It **widens** `content_approvals_actor_required` so a row with `actor_role = 'migration'` may have
a NULL `actor_id`. Today an `unpublish` row must name an actor, and
`set_lesson_published` additionally demands a `can_publish` capability — so a migration could only
have audited itself by impersonating a super_admin. The alternatives were a false name in the
audit table or no audit row at all. The undo restores the original CHECK (after deleting the
actor-less rows, which it must, or the stricter CHECK cannot be re-added).
