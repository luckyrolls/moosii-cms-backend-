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

### Anon can approve any lesson via `set_card_review_state` — apply 095 (both projects)
**Why:** the approval RPCs were closed by 094, but `set_card_review_state` (SECURITY DEFINER, no caller
check) is still executable by anon through PostgREST: proven (rolled back) to clinically approve every
card of a draft lesson. `apply_classification` and `rebuild_user_mlp` let anon write into any user's
plan; `unapprove_segment_bundle` lets anon un-approve any lesson. `FINDINGS-rpc-grants.md` §2–3.
**What:** migration 095 is drafted (service_role only for the four); needs a go, then financial →
Moosii with a rolled-back anon proof. Low-priority hygiene from the same audit: revoke anon on the two
`renumber_track_*` functions (CMS keeps authenticated).

## P3

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
