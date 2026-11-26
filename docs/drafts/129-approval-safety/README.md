# 129 harness — approval safety (the image gate)

```bash
bash docs/drafts/129-approval-safety/run.sh      # ~2 min; KEEP=1 leaves the cluster up
```

Ten steps on a throwaway PG 17 cluster (port **55435**, so it cannot collide with the 126/127/128
harnesses) restored from a schema-only dump of live Moosii:

| step | what |
|---|---|
| 1–3 | read-only schema dump, fresh cluster, the 127 harness's `stubs.sql` + `defaults.sql`, restore |
| 4 | the `app_settings.domain` row, and a check that **056 / 127 / 128 arrived with the dump** |
| 5 | `fixture.sql` — tracks, four lessons (open / published / archived lesson / archived track), seven cards, seven images |
| 6 | the **pre-129** verdict per segment, for comparison |
| 7 | apply `migrations/129_approval_image_gate.sql` |
| 8 | apply it **again**, which must be REFUSED by the md5 guard |
| 9 | the **post-129** stored values — unchanged, because 129 re-derives nothing |
| 10 | `src/lib/__tests__/approvalGate.db.test.ts` (17 tests) |

Result, 2026-11-25: fixture OK, 129 applies with `129 VERIFY ok`, the second apply is refused with
`recompute_seg_status is not the known 056 body (md5 017a190fd685972a20924e1a98e16170)`, stored
seg_status values are byte-identical before and after, **17/17 behaviour tests green**.

## Three things this harness learned the hard way

**1. The dump already contains 127 and 128, so neither may be applied here.** Both are live on
Moosii, so a schema-only dump taken today carries their objects — `tracks.test_group` and its
insert-default trigger included. Re-applying 128 against such a dump FAILS with
`128 VERIFY: 4 track(s) outside the active mode (mem) are still active`: the insert trigger has
already supplied `test_group` on every fixture row, so the backfill's `WHERE test_group IS NULL`
matches nothing and then the verify rightly complains. **That is not a defect in 128** — it is what
happens to any harness in this family once the migration it tests is live. The 128 harness's own
`run.sh` still applies 128 and will hit this; it was green when the dump predated 128.

**2. A card INSERT drafts the whole segment, so a fixture cannot be born approved.**
`sub_segments_reset_review_trg` (066) fires AFTER INSERT and resets EVERY card in the segment to
`draft`, because card roles are position-derived (invariant 2). Inserting a row with
`review_state = 'clinically_approved'` therefore leaves it `draft` — the first fixture did exactly
that and every segment came out `pending`. The fixture now INSERTs the cards and then UPDATEs
`review_state`, which is safe because `review_state` is not in that trigger's column list
(066/092: `title, content, sequence`).

**3. Three constraints shape every `content_images` fixture row.**
`content_images_generated_has_provenance` — `source` defaults to `'generated'`, which then demands
`final_prompt`, `image_prompt` AND `image_generator_name`, so test rows use `source = 'uploaded'`.
`content_images_one_owner` — exactly one of `lesson_id` / `segment_id` / `sub_segment_id` must be
set **in the INSERT**, so the lesson-level image cannot be inserted bare and given its owner
afterwards. And `sub_segments.image` is an FK to `image_assets(url)`
(`sub_segments_image_fkey`), so the 092/093 tests must create the asset row before writing the
pointer — the same linkability the whole-lesson approve route pre-checks
(`lessons.ts:120-140`, `409 image_not_linkable`).

## The fixture

| id | what | images | review state | pre-129 |
|---|---|---|---|---|
| `S1` `e1292222…0001` | segment of the OPEN lesson | — | 3 cards, all clinically approved | **complete** |
| → `C1` | | 1 approved | clinically_approved | |
| → `C2` | | 1 approved **+ a newer candidate** | clinically_approved | the case that must NOT block |
| → `C3` | | 1 **rejected** only | clinically_approved | only `candidate` counts |
| `S2` `e1292222…0002` | segment of the **PUBLISHED** lesson | `C4`, `C5` each 1 approved | both clinically approved | **complete** |
| `S3` `e1292222…0003` | segment of an **archived lesson** | — | draft | pending |
| `S4` `e1292222…0004` | segment under an **archived track** | — | draft | pending |
| `S5` `e1292222…0005` | **cardless** segment of the open lesson | — | — | pending (056's ≥1-card guard) |
| | a **lesson-level** image on the open lesson | `candidate`, `lesson_id` set | — | the polymorphic case 129 must ignore |

S1 is deliberately `complete` pre-129 **and** post-129: nothing in it is un-adjudicated, so the new
clause agrees with 056 on the fixture's resting state. Every movement in the suite is produced by
the test itself, inside a transaction it rolls back.

## What the suite proves

* the gate: a candidate on a card with **no** approved image → `pending`, **by the trigger alone**
  (no explicit recompute in the test), and the card's `review_state` is untouched — the gate holds
  it, not a demotion;
* the asymmetry: a replacement candidate **beside** an approved image → still `complete`;
* all three re-opening paths: reject, delete, approve;
* a **published** lesson stays `complete` / `published_reviewed` on a replacement candidate, and
  does go `published_unreviewed` when the card genuinely has nothing live to fall back on;
* the trigger's scope: a `storage_path` rewrite does **not** touch the segment (`updated_at`
  unchanged), a lesson-level image is ignored rather than an error, and a card DELETE (whose images
  cascade) returns early instead of failing;
* **092 and 093 still behave exactly as before**;
* `deriveSegStatus` (TypeScript) and `recompute_seg_status` (SQL) agree on every fixture segment,
  and still agree after a candidate lands — the duplication is deliberate and this is what keeps it
  honest;
* 094: neither function is EXECUTE-able by `anon` or `authenticated`; `service_role` keeps it.
