# FINDINGS — RPC EXECUTE grants (2026-09-21)

Backlog P1 "approval RPCs are executable by anon". Part 1 is DONE (migration 094, both projects).
Part 2 is the audit Mark asked for: every SECURITY DEFINER function in `public` that anon or
authenticated can execute, with a recommendation each. Both projects have the **same 20 functions
with identical grants** (financial was built from Moosii's schema dump).

Why it matters: PostgREST exposes every function in `public` at `/rest/v1/rpc/<name>` to anyone with
the anon key (it's shipped in the app and the CMS). A SECURITY DEFINER function runs as its owner
(`postgres`, BYPASSRLS), so **RLS does not protect anything it touches** — only a check inside the
function or the EXECUTE grant does.

## 1. Done — migration 094

`approve_content_image` (both overloads), `approve_segment_bundle`, `recompute_seg_status`: EXECUTE
revoked from PUBLIC, anon, authenticated; granted to service_role.

- **Callers checked first:** backend only (service role: `images.ts:34`, `lessons.ts:140`,
  `cardReview.ts:14`). moosii-cms's direct RPCs are `is_admin`, `user_active_tracks_for_user`,
  `mark_mlp_stale`, `renumber_track_priorities`, `renumber_track_priority_order` (none of these);
  moosii-rn makes no `.rpc()` calls. In the DB, the callers of `recompute_seg_status` are three
  SECURITY DEFINER functions (run as owner, unaffected). No pg_cron job references them.
- **Proof** (`docs/drafts/094-anon-proof.sql` + `.sh`, all rolled back / random ids):

  | | before 094 | after 094 |
  |---|---|---|
  | anon key over HTTP (Moosii), all 4 calls | executed (200, or the function's own "not found") | **HTTP 401, 42501 permission denied** |
  | `SET ROLE anon` / `authenticated`, both projects, all 4 | EXECUTED | **REFUSED (42501)** |
  | service_role approve (both projects) | complete | complete |
  | admin CMS-direct text edit → 066 trigger → recompute (as owner) | resets + recomputes | same |
  | backend service key over HTTP, `recompute_seg_status` | 200 | 200 |

## 2. Still open — the worst one is not in 094

**`set_card_review_state` lets anyone with the anon key clinically approve any lesson.** Proven on
both projects in a rolled-back transaction: as `anon`,
`set_card_review_state(<seg>, NULL, 'clinically_approved', NULL, NULL)` → `cards_updated 8`
(financial) / `9` (Moosii), `seg_status complete` — every card of a draft lesson approved, the lesson
live to the app. It is SECURITY DEFINER with no caller check. (Before 093, anon's
`approve_segment_bundle` would have done the same through it; 093's bundle happens to collect cards
as the caller, so RLS emptied the list — and 094 now refuses the call outright.)
`unapprove_segment_bundle` (SECURITY INVOKER, still anon-executable) calls it too: anon can send any
lesson back to draft.

**Migration 095 is drafted for this (DRAFT, not applied — needs a go).**

## 3. The audit — SECURITY DEFINER in `public`, EXECUTE held by anon AND authenticated (both projects)

### Callable functions (8) — the ones that matter

| Function | What it does | Caller check inside | Who calls it | Recommendation |
|---|---|---|---|---|
| `set_card_review_state(uuid, uuid[], text, text, uuid)` | UPDATE sub_segments.review_state, segments.approved_by; recompute | **none** | backend `cardReview.ts:33`; `approve_/unapprove_segment_bundle` (service role) | **REVOKE anon, authenticated → service_role only (095). Critical.** |
| `apply_classification(uuid, uuid, uuid, jsonb, jsonb)` | INSERT child_milestones, user_mlp_mods, user_track_activations for ANY `p_user_id` | **none** | backend `classifyUpdate.ts:499` (service role) | **REVOKE → service_role only (095). High:** anon can write tracks/milestones into any user's plan. |
| `rebuild_user_mlp(uuid, jsonb)` | DELETE + INSERT `user_mlp` for ANY `p_user_id` | **none** | backend `rebuildMlp.ts:677` (service role) | **REVOKE → service_role only (095). High:** anon can wipe or replace any user's plan. |
| `recompute_seg_status(uuid)` | derive seg_status | none | backend + 3 definer fns | **Done (094).** |
| `renumber_track_priorities(uuid, uuid[])` | UPDATE lessons.priority | `is_admin()` → raises | **CMS** `priorities.ts:79` | Keep for authenticated (CMS needs it; guarded). Revoke anon (hygiene, low). |
| `renumber_track_priority_order(uuid[])` | UPDATE tracks order | `is_admin()` → raises | **CMS** `tracks.ts:191` | Same as above. |
| `is_admin()` | reads caller's own `user.role` | uses `auth.uid()` | **CMS** `useIsAdmin.ts:17`; 127 RLS policies | **Keep both.** Policies run as the querying role, so anon/authenticated must be able to execute it or table reads fail with 42501. Reveals only the caller's own status. |
| `is_super_admin()` | same, super_admin | uses `auth.uid()` | 91 RLS policies | **Keep both**, same reason. |

Plus one SECURITY INVOKER function that reaches a definer one:
`unapprove_segment_bundle(uuid)` — backend only (`lessons.ts:184`) → **REVOKE → service_role only (095).**

### Trigger functions (12) — no action needed

`content_edit_policy_guard`, `create_default_account_types`, `create_default_main_fund`,
`create_new_user`, `delete_image_assets_on_storage_delete`, `handle_user_verification_update`,
`quiz_reset_review`, `sub_segments_image_swap_review`, `sub_segments_reset_review`,
`sync_image_assets_from_storage`, `update_account_balances`, `update_auth_provider`.

A function returning `trigger` cannot be called directly ("trigger functions can only be called as
triggers") and PostgREST does not expose it; EXECUTE is checked only at CREATE TRIGGER. The grant is
inert. Revoking is harmless hygiene — not worth a migration on its own; fold it into 095 only if Mark
wants a clean audit result.

## 4. Trap for later migrations

Supabase's default privileges grant EXECUTE to anon and authenticated on every NEW function in
`public`. `CREATE OR REPLACE` keeps the existing ACL; a `DROP` + `CREATE` (return-type change) or a
new function comes back open. Any backend-only function must carry its own
`REVOKE … FROM PUBLIC, anon, authenticated; GRANT … TO service_role` in the migration that creates
or recreates it. (Recorded in CLAUDE.md, Migrations.)
