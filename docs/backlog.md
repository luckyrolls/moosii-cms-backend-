# Backlog

Prioritised, not-yet-scheduled work for this repo. P1 = next, P2 = soon, P3 = when convenient.
An item leaves this file when it ships (record it in `api-contract.md` / `migrations/README.md`).

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
