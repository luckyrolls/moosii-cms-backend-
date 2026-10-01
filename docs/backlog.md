# Backlog

Prioritised, not-yet-scheduled work for this repo. P1 = next, P2 = soon, P3 = when convenient.
An item leaves this file when it ships (record it in `api-contract.md` / `migrations/README.md`).

## P1

### Moosii storage: blanket `allow_all` policies
**Why:** Moosii has two storage policies with no condition, for role `public` and every command:
`allow_all` on `storage.buckets` and `allow_all` on `storage.objects`. Policies are OR-ed, so anyone
holding the anon key can read, upload, overwrite or delete any object in any bucket — including the
`lessons` images the app shows (the `sub_segments.image` → `image_assets` chain) — and create or alter
buckets. The narrower policies beside them (`transaction-images` own-folder, `moosi` bucket) are made
moot. Found 2026-09-16 while diffing Moosii and financial for migration 087; not copied to financial.
**What:** confirm what legitimately writes storage directly (the backend uses the service role and
bypasses RLS; the CMS only reads public URLs; the app — moosii-rn seat — may upload to `moosi` /
`transaction-images` / `onboarding`), then drop both `allow_all` policies in a Moosii migration, keeping
or adding bucket-scoped ones for the real app paths. Public buckets stay readable by URL without a
policy. Needs the moosii-rn seat to confirm its upload paths first.

### RLS disabled + anon full CRUD on 15 `public` tables (both projects)
**Why:** `content_approvals` (publish audit), `prompt_blocks`, `prompt_block_versions`, `ai_generation_log`,
`source_documents`, `lesson_source_documents`, `image_assets`, `content_edits`, `screen_help`, `topics`,
`notification_log`, `subscription_plans` and three leftovers have RLS off, and anon holds S/I/U/D/T on
all of them. Anyone with the anon key could rewrite prompts or delete the audit through PostgREST —
anon is revoked by 099 (tourniquet); authenticated still has full access, RLS still off.
`FINDINGS-anon-views.md` §6.
**What:** caller sweep per table (backend-only vs CMS-direct vs app), then RLS on: no policy for
backend-only; admin policy for CMS-direct; signed-in read for `topics`. Drop the `_MM_unused` and dedupe leftovers.

### Revoke anon on the two `renumber_track_*` functions (hygiene)
Left over from the `FINDINGS-rpc-grants.md` audit after 094/095 closed the real holes (095 applied both
projects 2026-09-26). Both are guarded by `is_admin()`, so anon EXECUTE is inert; revoke anon, keep
authenticated (the CMS calls them).

## P2

### Reaper should also fail jobs stuck in `queued`
**Why:** `reapStaleJobs` (`src/jobs/runner.ts`) fails only `running` jobs older than 10 min. A job
enqueued just before a deploy/restart never starts and stays `queued` forever; on 2026-10-01 six were
failed by hand (4 financial image jobs from 2026-09-28, 2 Moosii from June/July). Worse than cosmetic:
`enqueueRebuildAllIfIdle` / `enqueueRebuildUserIfIdle` JOIN an existing queued job, so an orphaned
queued `rebuild_mlp` would silently swallow every later rebuild.
**What:** at startup, also fail `status='queued'` rows whose `created_at` is older than a threshold
(e.g. 10 min — any queued row at boot predates this process), with error message "Job orphaned while
queued". No migration.

## P3

### Drop the six no-caller views
`v_lesson_details`, `v_segment_details`, `lessons_with_track_name`, `lesson_segment_counts_with_track`,
`sub_segment_image_fallback`, `sub_segments_image_fallback` — no code callers in any repo
(`FINDINGS-anon-views.md` §1). After 098, and after confirming nothing outside the repos reads them.

### Audit card and quiz review resets
**Why:** a reset of `review_state` / `answer_status` leaves no trace, so "who or what cleared these
approvals, and when" cannot be answered from the data. Seen 2026-09-15: FINDINGS-unarchive-approvals.md.
**What:** write a `content_approvals` row (action `review_reset`; actor from the JWT on backend
paths, null from triggers) from `sub_segments_reset_review` and `quiz_reset_review` (migration 066)
and from `resetCardsAndReport` (`src/lib/cardReview.ts:54`). Needs a migration (the triggers, plus
the action value if `content_approvals.action` is constrained). Only log when a row actually moved.

### Approve routes log only when cards moved
**Why:** `POST /lessons/:id/editorial-approve` logs `editorial_approve` even when zero cards moved
(`src/routes/lessons.ts:164-165`, `fromState='draft'`), so a repeat click is indistinguishable from
a real re-approval in the audit log. Seen 2026-09-15: FINDINGS-unarchive-approvals.md.
**What:** call `logApproval` only when `cards_updated > 0` (and the equivalent check for the
clinical approve / `approve_segment_bundle` result). No migration.
