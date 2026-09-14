-- ============================================================================
-- MIGRATION 078: active-tracks views read with the CALLER's rights, under per-user RLS
--                — APPLIED financial 2026-09-14 · APPLIED moosii 2026-09-14 (R1 + admin widening accepted)
-- ============================================================================
-- THE HOLE. user_active_tracks, user_active_tracks_with_reason and the two views under them
-- (user_mlp_data, questionnaire_responses_tracks) are PLAIN views owned by postgres, and postgres
-- has BYPASSRLS. So every read of them ignores RLS on the tables underneath: anyone holding the
-- public anon key can read any user's tracks by user_id — pg_stat_statements on Moosii shows anon
-- doing exactly that ~2,600 times — and user_mlp_data hands out every user's `financials`,
-- `gender`, `parenting_status` and child ages. On the financial project, a user's tracks reveal the
-- facts that granted them.
--
-- THE FIX, per Mark (2026-09-14): security_invoker on the views, plus RLS on the underlying
-- tables — a user reads their own rows, admins (and the service role) read all, anon reads none.
--
-- WHAT THIS FILE DOES, in one transaction:
--   1. is_admin() / is_super_admin() become SECURITY DEFINER with a pinned search_path. REQUIRED,
--      not tidy-up: both read public."user", and step 2 drops `user`'s blanket read policy. Without
--      this, every policy that calls them (213 policies on 64 tables) re-enters `user`'s RLS, which
--      calls them again — infinite recursion. Today a `true` policy on `user` short-circuits that.
--      Results are unchanged for every caller: the same EXISTS on the same row, just without RLS
--      inside the check.
--   2. Per-user tables: DROP the three blanket "Enable read access for all users" (USING true)
--      policies on children, completed_items and user, and widen the own-row SELECT policies from
--      is_super_admin() to is_admin() so a plain `admin` (the CMS inspector) reads all. Config the
--      views need gets an authenticated read: new_user_tracks (today admin-only, so ordinary users
--      would silently lose their default tracks) and fact_track_rules. user_facts gets own-or-admin.
--   3. security_invoker = true on user_facts_latest, user_mlp_data, questionnaire_responses_tracks,
--      user_active_tracks, user_active_tracks_with_reason. All five, because a plain view nested
--      inside an invoker view still runs as its owner and would reopen the hole.
--   4. user_active_tracks_for_user reads user_facts_latest directly again, and the 074 helper
--      user_fact_track_ids is DROPPED. The helper existed only because 071 revoked the facts view
--      from clients; with a real policy on user_facts that workaround is no longer needed, and the
--      function and view read the same tables under the same RLS again.
--
-- DECISION R1 — ACCEPTED by Mark 2026-09-14. REVERSES 071's POSTURE. After this file a signed-in user can SELECT their own
-- raw facts (user_facts / user_facts_latest) through PostgREST, and an admin can read everyone's.
-- 071 kept facts unreadable by any client. The alternative keeps that: leave the REVOKE, keep the
-- SECURITY DEFINER helper, and route BOTH views' fact arm through a definer function that filters
-- to (own OR admin OR service). That costs a second definer function and a caller test inside it.
-- RECOMMENDED: this file's version — standard RLS, no definer workarounds, and a user's own facts
-- are their own data.
--
-- WHO THIS CHANGES, measured on Moosii (pg_stat_statements since 2025-03-14):
--   * anon reading user_active_tracks by user_id (~2,600 calls): gets 0 rows instead of the user's
--     tracks. No error — anon keeps its grants, RLS returns nothing. anon's reads of children and
--     completed_items already return nothing today, so the app already tolerates this. ⚠ Confirm
--     with the moosii-rn seat that the app reads tracks with the user's session.
--   * a signed-in app user: unchanged for their OWN rows. They can no longer read other users'
--     `user`, `children` or `completed_items` rows. The ~172k authenticated reads of `user` all
--     filter `id = $1`, consistent with reading one's own profile. ⚠ Same confirmation.
--   * the CMS inspector (an admin's session reading user_active_tracks_with_reason for another
--     user): still sees everything — requires role admin or super_admin on public."user"
--     (Moosii: 2 admin, 2 super_admin). ⚠ SECOND SURFACE: open the inspector after applying.
--   * (ACCEPTED 2026-09-14) a plain `admin` GAINS read on children, completed_items, user, user_demographic_responses,
--     user_mlp_mods and questionnaire_user_answers (today super_admin only, or everyone via `true`).
--   * the backend: unchanged. service_role and postgres have BYPASSRLS; apply_classification and
--     the renumber functions are SECURITY DEFINER owned by postgres.
--   * financial: 0 users today, so nothing observable changes yet.
--
-- NOT CHANGED: write policies (INSERT/UPDATE/DELETE, and the ALL policies' write side); config
-- tables' existing reads (tracks, questionnaire*, demographic_*, track_tag_map); any table not
-- read by these views.
--
-- APPLY per migrations/README.md (Claude, psql, after Mark's go): financial, then Moosii.
-- Needs PostgreSQL 15+ (security_invoker): financial 17.6, Moosii 15.8.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. Everything below was captured live on BOTH projects on 2026-09-14,
-- identical on each; a mismatch means something changed since — stop and re-base.
-- 1. PostgreSQL 15+ — EXPECT true:
--    SELECT current_setting('server_version_num')::int >= 150000;
-- 2. The objects this file rewrites still have their post-074 text — EXPECT
--    7acd32f0c9ff47b98b38c5ff4c18e16c | bef6fc0d78d2a0b0082a8265970bae80 | 6c0d4ad3ea5611cdb2fec3d230b21ac5:
--    SELECT md5(pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure)),
--           md5(pg_get_viewdef('user_active_tracks'::regclass, true)),
--           md5(pg_get_viewdef('user_active_tracks_with_reason'::regclass, true));
-- 3. The policies on the tables this file touches are unchanged — EXPECT
--    bd4095a73ddf496523482b3bfb25d283 | 68:
--    SELECT md5(string_agg(tablename||'|'||policyname||'|'||permissive||'|'||roles::text||'|'||cmd||'|'||
--               coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n' ORDER BY tablename, policyname)), count(*)
--      FROM pg_policies WHERE schemaname = 'public' AND tablename IN
--      ('children','user','completed_items','user_demographic_responses','user_mlp_mods',
--       'questionnaire_user_answers','new_user_tracks','user_facts','fact_track_rules','tracks',
--       'track_tag_map','questionnaire','questionnaire_response','questionnaire_answer_actions',
--       'demographic_questions','demographic_answers','demographic_track_rules');
-- 4. is_admin() / is_super_admin() are still the plain SQL checks on public."user" — EXPECT f | f:
--    SELECT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_admin()'::regprocedure),
--           (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_super_admin()'::regprocedure);
-- 5. No table under the views FORCEs RLS (that would bind even the owner) — EXPECT 0:
--    SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relforcerowsecurity;
-- 6. No other object reads the helper this file drops — EXPECT only user_active_tracks_for_user:
--    SELECT p.oid::regprocedure FROM pg_proc p WHERE p.prosrc LIKE '%user_fact_track_ids%'
--      AND p.oid <> 'public.user_fact_track_ids(uuid)'::regprocedure;
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- 1. Admin checks: owner's rights, pinned search_path ---------------------------------
-- Same body, same result. CREATE OR REPLACE keeps their existing EXECUTE grants.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."user"
    WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."user"
    WHERE id = auth.uid() AND role = 'super_admin'
  );
$$;

-- ---- 2. Per-user tables: own rows, admins all, anon none ----------------------------------
-- (select auth.uid()) / (select is_admin()) are evaluated once per statement, not per row.

-- children
DROP POLICY IF EXISTS "Enable read access for all users" ON public.children;
ALTER POLICY children_sel ON public.children
  USING (parent_id = (select auth.uid()) OR (select public.is_admin()) OR (select auth.role()) = 'service_role');

-- completed_items
DROP POLICY IF EXISTS "Enable read access for all users" ON public.completed_items;
ALTER POLICY completed_items_sel ON public.completed_items
  USING (user_id = (select auth.uid()) OR (select public.is_admin()) OR (select auth.role()) = 'service_role');

-- user
DROP POLICY IF EXISTS "Enable read access for all users" ON public."user";
ALTER POLICY user_self_select ON public."user"
  USING (id = (select auth.uid()) OR (select public.is_admin()) OR (select auth.role()) = 'service_role');

-- user_demographic_responses
ALTER POLICY user_demographic_responses_select_own_or_admin ON public.user_demographic_responses
  USING (user_id = (select auth.uid()) OR (select public.is_admin()));

-- user_mlp_mods
ALTER POLICY user_mlp_mods_sel ON public.user_mlp_mods
  USING (user_id = (select auth.uid()) OR (select public.is_admin()) OR (select auth.role()) = 'service_role');

-- questionnaire_user_answers (the policy name says "own"; it now also admits admins)
ALTER POLICY quua_select_own ON public.questionnaire_user_answers
  USING (user_id = (select auth.uid()) OR (select public.is_admin()));

-- user_facts: own or admin (decision R1)
DROP POLICY IF EXISTS user_facts_select_own_or_admin ON public.user_facts;
CREATE POLICY user_facts_select_own_or_admin ON public.user_facts
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()) OR (select public.is_admin()));

-- Config the views need, readable by any signed-in user
DROP POLICY IF EXISTS new_user_tracks_select_authenticated ON public.new_user_tracks;
CREATE POLICY new_user_tracks_select_authenticated ON public.new_user_tracks
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS fact_track_rules_select_authenticated ON public.fact_track_rules;
CREATE POLICY fact_track_rules_select_authenticated ON public.fact_track_rules
  FOR SELECT TO authenticated USING (true);

-- ---- 3. The views read with the caller's rights --------------------------------------------
-- 071's header said never to make user_facts_latest security_invoker. That was right while
-- user_facts had RLS and NO policy — an invoker view then returned nothing to a signed-in
-- reader. Step 2 gives it a policy, so invoker is now the correct setting.
ALTER VIEW public.user_facts_latest              SET (security_invoker = true);
ALTER VIEW public.user_mlp_data                  SET (security_invoker = true);
ALTER VIEW public.questionnaire_responses_tracks SET (security_invoker = true);
ALTER VIEW public.user_active_tracks             SET (security_invoker = true);
ALTER VIEW public.user_active_tracks_with_reason SET (security_invoker = true);

-- Clients may now SELECT the facts view; RLS on user_facts decides the rows (anon: none).
-- Without the anon grant, an anon read of user_active_tracks would ERROR instead of returning
-- no rows.
GRANT SELECT ON public.user_facts_latest TO anon, authenticated;

-- ---- 4. The function reads facts directly again; the 074 helper goes -----------------------
-- Body = migration 074's, with ONLY the fact_tracks CTE changed back to a direct read
-- (marked `-- CHANGED (078)`).
CREATE OR REPLACE FUNCTION user_active_tracks_for_user(p_user_id uuid)
RETURNS TABLE (user_id uuid, track_id uuid, track_name text, priority integer, weight integer)
LANGUAGE sql
STABLE
AS $$
  WITH base_tracks AS (
    SELECT DISTINCT udr.user_id, dtr.track_id
    FROM user_demographic_responses udr
      JOIN demographic_questions dq ON dq.id = udr.question_id AND dq.is_active = true
      JOIN demographic_answers da ON da.id = udr.answer_id AND da.is_active = true
      JOIN demographic_track_rules dtr ON dtr.answer_id = udr.answer_id
    WHERE udr.user_id = p_user_id
  ), default_tracks AS (
    SELECT u.user_id, nut.track_id
    FROM user_mlp_data u
      CROSS JOIN new_user_tracks nut
    WHERE u.user_id = p_user_id
  ), fact_tracks AS (                        -- CHANGED (078): direct read, RLS on user_facts
    SELECT ufl.user_id, ftr.track_id
    FROM user_facts_latest ufl
      JOIN fact_track_rules ftr
        ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
    WHERE ufl.user_id = p_user_id
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
    UNION
    SELECT fact_tracks.user_id, fact_tracks.track_id FROM fact_tracks
  ), questionnaire_track_actions AS (
    SELECT qrt.user_id, qrt.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
    WHERE qrt.track_id IS NOT NULL AND qrt.user_id = p_user_id
    UNION ALL
    SELECT qrt.user_id, ttm.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
      JOIN track_tag_map ttm ON qrt.tag_id = ttm.tag_id
    WHERE qrt.tag_id IS NOT NULL AND qrt.user_id = p_user_id
  ), latest_questionnaire_action AS (
    SELECT DISTINCT ON (qta.user_id, qta.track_id) qta.user_id, qta.track_id, qta.add, qta.action_at
    FROM questionnaire_track_actions qta
    ORDER BY qta.user_id, qta.track_id, qta.action_at DESC, qta.add DESC
  ), after_questionnaire AS (
    (
      SELECT base_set.user_id, base_set.track_id FROM base_set
      UNION
      SELECT latest_questionnaire_action.user_id, latest_questionnaire_action.track_id
      FROM latest_questionnaire_action
      WHERE latest_questionnaire_action.add = true
    ) EXCEPT
    SELECT latest_questionnaire_action.user_id, latest_questionnaire_action.track_id
    FROM latest_questionnaire_action
    WHERE latest_questionnaire_action.add = false
  ), latest_user_mod AS (
    SELECT DISTINCT ON (umm.user_id, umm.track_id) umm.user_id, umm.track_id, lower(umm.action) AS action, umm.created_at AS action_at
    FROM user_mlp_mods umm
    WHERE umm.user_id = p_user_id
    ORDER BY umm.user_id, umm.track_id, umm.created_at DESC
  ), final_tracks AS (
    (
      SELECT after_questionnaire.user_id, after_questionnaire.track_id FROM after_questionnaire
      UNION
      SELECT latest_user_mod.user_id, latest_user_mod.track_id
      FROM latest_user_mod
      WHERE latest_user_mod.action = 'add'::text
    ) EXCEPT
    SELECT latest_user_mod.user_id, latest_user_mod.track_id
    FROM latest_user_mod
    WHERE latest_user_mod.action = 'delete'::text
  )
  SELECT ft.user_id, ft.track_id, t.track_name, t.priority, t.weight
  FROM final_tracks ft
    JOIN tracks t ON t.id = ft.track_id
  WHERE t.track_name IS DISTINCT FROM '* All Tracks'::text
    AND t.archived_at IS NULL          -- from 045: archived tracks are invisible to parents
  ORDER BY t.weight DESC;
$$;

COMMENT ON FUNCTION user_active_tracks_for_user(uuid) IS
  'Per-user twin of the user_active_tracks view (migration 037): same resolution, filtered '
  'by user_id in each arm so it is O(one user). Keep in sync with the view definition. '
  'Facts arm since 074; since 078 both twins read under the CALLER''s RLS (security_invoker '
  'views, own-or-admin policies), so a caller sees only what they may see.';

DROP FUNCTION IF EXISTS public.user_fact_track_ids(uuid);

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. The role checks simulate a PostgREST request inside a
-- transaction that is ROLLED BACK: SET LOCAL ROLE plus request.jwt.claims, which is exactly
-- what auth.uid() and auth.role() read.
-- 1. Catalog: is_admin/is_super_admin SECURITY DEFINER with search_path pinned; all five views
--    security_invoker; the three blanket `true` policies gone; helper gone; the function no
--    longer mentions the helper.
-- 2. As the SERVICE (no role switch): user_active_tracks and with_reason return exactly the rows
--    they returned before applying (row count + md5), and the twins agree.
-- 3. As an ADMIN (role admin or super_admin): the same full row set as the service.
-- 4. As an ordinary USER: user_active_tracks returns only their own rows, and those rows equal
--    the service's rows for that user. Their `user` read returns 1 row; they read no other
--    user's children or completed_items; they still get their default tracks.
-- 5. As ANON: user_active_tracks, with_reason, user_mlp_data and user_facts_latest all return
--    0 rows, WITHOUT an error.
-- 6. Facts (rolled back): a fact authored for the ordinary user grants their track in both
--    twins; that user sees their own fact in user_facts_latest; another user and anon see none;
--    an admin sees it.
-- Then open the CMS inspector for a user (second surface).
-- ============================================================================
