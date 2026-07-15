-- ============================================================================
-- Migration 043: content_approvals — append-only approval audit
-- ============================================================================
-- One row PER approve/unapprove/publish/unpublish transition, actor ALWAYS from the
-- verified JWT (req.user.id), NEVER the request body. This is the AUTHORITATIVE record of
-- who approved/published what and when. The candidate->approve lifecycle was built for a
-- single approver, and the per-entity status columns keep only the LATEST approver
-- (overwritten on re-approval) — which can't answer "what did approver X do while approver
-- Y was away." Append-only: the logApproval helper only INSERTs; nothing updates/deletes.
--
-- Polymorphic entity_id (uuid) with NO FK — an audit must survive deletion of the entity
-- (same reason content_images.topic_name is stored not-FK). actor_id likewise has no FK
-- (references user.id logically) so the trail survives an actor's removal.
--
-- LEGACY NOTE — segments.approved_by: pre-043 the standalone segment-approve route took the
-- approver from the CMS request body, which passed the session EMAIL (into a uuid-shaped
-- column). That column is now written the CORRECT server-side value (req.user.id) going
-- forward, but historical values are UNRELIABLE and cannot be backfilled — content_approvals
-- is the authoritative record from here on. PROPOSAL (operator to rule): LEAVE the legacy
-- rows documented-dead, do NOT null them — nulling destroys whatever historical signal
-- exists for no gain (the column stops being the source of truth regardless), and a bad
-- value still hints at who acted. This migration does not touch existing rows.
--
-- content_approvals is internal-only (on docs/rls-sweep.md).
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..043 reconciliation list.
-- ============================================================================

begin;

create table if not exists public.content_approvals (
  id          uuid        not null default gen_random_uuid(),
  entity_type text        not null,
  entity_id   uuid        not null,
  action      text        not null,
  actor_id    uuid        not null,
  actor_role  text,
  created_at  timestamptz not null default now(),
  constraint content_approvals_pkey primary key (id),
  constraint content_approvals_entity_type_check
    check (entity_type in ('segment', 'image', 'quiz', 'questionnaire', 'lesson')),
  constraint content_approvals_action_check
    check (action in ('approve', 'unapprove', 'publish', 'unpublish'))
);

-- "what did actor X do between dates" (the two-approver query) — actor + time range.
create index if not exists content_approvals_actor_created_idx
  on public.content_approvals (actor_id, created_at);
-- Full history for a given entity.
create index if not exists content_approvals_entity_idx
  on public.content_approvals (entity_type, entity_id);

commit;
