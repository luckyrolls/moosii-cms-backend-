-- ============================================================================
-- MIGRATION 096: moosii-reader slice 1 — anon read of published content — PRIVILEGES + POLICIES
--   — APPLIED financial 2026-09-26   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY (Mark, 2026-09-26): moosii-reader is a public web lesson reader. Slice 1 needs anonymous
-- read of published content on the FINANCIAL project. Design: moosii-reader/DESIGN-web-reader.md
-- §3.2. The SQL below is Mark's brief, verbatim; only this header, the domain guard and
-- BEGIN/COMMIT are added.
--
-- WHAT anon gets (and nothing else):
--   lessons       — reader columns only; rows where reader_lesson_visible(id): published, not
--                   archived, track (if any) not archived (archival is derived — invariant 6).
--   segments      — id, lesson_id, segment_order, seg_status; seg_status='complete' of a visible lesson.
--   sub_segments  — id, seg_id, title, content, image, sequence; cards of such a segment.
--   app_settings  — key, value; the 'domain' row only.
-- Column-level: the table-level SELECT is revoked from anon, then per-column SELECT granted, so
-- e.g. curator_note / internal_name / prompts are "permission denied" for anon. `authenticated`,
-- the CMS and the backend (service_role) are untouched. anon's INSERT/UPDATE/DELETE grants are
-- untouched and still have no anon policy (RLS denies).
--
-- reader_lesson_visible is SECURITY DEFINER so the lesson policy can see track archival without
-- giving anon any access to `tracks`. It is deliberately callable by anon (not the service_role-only
-- rule for BACKEND functions, 094/095): it returns one boolean about a lesson anon can already read.
--
-- NOT CHANGED: quiz_questions / quiz_answers (slice 2); Moosii (parenting) — FINANCIAL ONLY, so the
-- two projects' privileges differ from here (the schema is unchanged). Pre-existing and NOT fixed
-- here: plain (non-invoker) views over these tables that anon can SELECT bypass RLS and these column
-- grants (see the report / docs/rls-sweep.md).
--
-- Idempotent: CREATE OR REPLACE, DROP POLICY IF EXISTS, REVOKE/GRANT. A re-run is a no-op.
-- APPLY per migrations/README.md: FINANCIAL ONLY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 'financial'; six rows, all t:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT c.relname, c.relrowsecurity FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relname IN
--      ('lessons','segments','sub_segments','quiz_questions','quiz_answers','app_settings');
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '096 is FINANCIAL ONLY — app_settings.domain is not ''financial''';
  END IF;
END $$;

-- shared visibility rule (SECURITY DEFINER so anon can see track archival)
create or replace function public.reader_lesson_visible(p_lesson_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from lessons l
    left join tracks t on t.id = l.track_id
    where l.id = p_lesson_id
      and l.is_published = true
      and l.archived_at is null
      and (l.track_id is null or t.archived_at is null)
  );
$$;
revoke all on function public.reader_lesson_visible(uuid) from public;
grant execute on function public.reader_lesson_visible(uuid) to anon, authenticated;

-- column-level grants: anon sees only reader columns; authenticated untouched
revoke select on public.lessons, public.segments, public.sub_segments,
  public.app_settings from anon;
grant select (id, lesson_name, description, with_quiz, quiz_onboarding_text,
  quiz_onboarding_image, points) on public.lessons to anon;
grant select (id, lesson_id, segment_order, seg_status) on public.segments to anon;
grant select (id, seg_id, title, content, image, sequence) on public.sub_segments to anon;
grant select (key, value) on public.app_settings to anon;

-- policies, TO anon only
drop policy if exists reader_anon_lessons on public.lessons;
create policy reader_anon_lessons on public.lessons for select to anon
  using (public.reader_lesson_visible(id));

drop policy if exists reader_anon_segments on public.segments;
create policy reader_anon_segments on public.segments for select to anon
  using (seg_status = 'complete' and public.reader_lesson_visible(lesson_id));

drop policy if exists reader_anon_sub_segments on public.sub_segments;
create policy reader_anon_sub_segments on public.sub_segments for select to anon
  using (exists (select 1 from public.segments s where s.id = seg_id
    and s.seg_status = 'complete' and public.reader_lesson_visible(s.lesson_id)));

drop policy if exists reader_anon_app_settings on public.app_settings;
create policy reader_anon_app_settings on public.app_settings for select to anon
  using (key = 'domain');

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION — as anon, each statement on its own:
--   SET ROLE anon;
--   SELECT id, lesson_name FROM lessons;      -- published, unarchived lessons only
--   SELECT curator_note FROM lessons;         -- MUST fail: permission denied (42501)
--   SELECT id, seg_status FROM segments;      -- only seg_status = 'complete' rows
--   SELECT key, value FROM app_settings;      -- exactly one row: domain / financial
--   RESET ROLE;
-- ---------------------------------------------------------------------------
