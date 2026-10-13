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

### `"user"`: drop the open INSERT policy
**Why:** besides the own-row `user_self_insert`, `"user"` carries `"Enable insert for authenticated users only"`
`WITH CHECK (true)` (both projects). Policies OR together, so any signed-in user can insert a `"user"` row for ANOTHER
auth uid that has none yet (squatting that user's profile and its email under `user_email_key`). Since 112 only the
four onboarding columns are insertable, so no role / moosies escalation — but the squat remains. Found 2026-10-13 (F32).
**What:** drop that policy on both projects (RN's onboarding insert is own-row and stays covered by
`user_self_insert`); rolled-back persona check like 105.

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

### Segment content + quiz ignore the row's model provider
**Why:** `callAndParseCards` (`src/jobs/handlers/generateSegmentContent.ts`) and `generateQuiz`
call `getLLMClient("openai")` whatever the prompt row's model. CLAUDE.md's rule is that DB-composed
callers derive the provider via `providerForModel` (the review already does). Latent while every
segment/quiz row is `gpt-*`; a `gemini-*` tone would hit the OpenAI client and fail.
`docs/FINDINGS-doc-grounded-generation.md` §8.2.
**What:** `providerForModel(promptRow.model, "openai")` in both, plus a test.

### Regen-prompt pre-fill shows the legacy length block, not the size profile
**Why:** `GET /segments/:id/regen-prompt` (`src/routes/segments.ts`) returns `editable.length` from
`length_block_id`, but generation renders the tone's size profile (`resolveLengthContent`). For any
tone with a profile, the editor shows text that isn't in the real prompt, and sending it back
unchanged as `overrides.length` silently replaces the profile. FINDINGS §8.10.
**What:** return `resolveLengthContent(promptRow)` and only send `overrides.length` when edited
(CMS seat for the second half).

## P3

### `completed_items`: lesson rows must carry `lesson_id`
**Why:** F29's unique key (111) is `(user_id, lesson_id) WHERE item_type = 'lesson'`; a lesson row with a NULL
`lesson_id` escapes it and the trigger falls back to `item_id`. 0 such rows on both projects (2026-10-13), and RN
always sets both. **What:** `CHECK (item_type <> 'lesson' OR lesson_id IS NOT NULL)` (and `= item_id`), both projects.

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

### Repo has no migration for `content_findings.category`
**Why:** the review writes `category` for best_practices, and the column exists live on both
projects, but no file in `migrations/` creates it, so a rebuild from the files would break the
review. FINDINGS §8.12.
**What:** an idempotent `ADD COLUMN IF NOT EXISTS` migration matching the live definition, recorded
as already applied on both projects.

### `ai_generation_log.blocks` records defaults under overrides
**Why:** regen logs the tone's default block ids even when `structure_block_id` / `size_profile_id`
is overridden, and never logs a size profile. Only `notes` shows the deviation. FINDINGS §8.9.
**What:** log the resolved ids (and `size_profile`).

### Grounded-generation follow-ups (`use_source_documents`)
Shipped 2026-10-12 without these (FINDINGS-doc-grounded-generation.md, open questions):
per-card provenance (`sub_segments.grounding jsonb`, a migration) if the CMS should show the doc
versions per card; the option on `generate_track_content` (decide: fail vs skip lessons with no
docs); a CMS editor for the grounding block (the text is now DB block `grounding_v1`, migration 110,
editable only by SQL); a size cap at ingestion (`POST/PATCH /source-documents`, against
`app_settings.grounding_max_chars`); a voice-lint rule for citation leaks ("according to the
document…"); chaining the doc_grounded review (after review dedup).
