-- ============================================================================
-- DRAFT 074: fact arm on user_active_tracks_for_user + its VIEW TWIN (NOT APPLIED)
-- ============================================================================
-- RATIONALE: this is the ONE line of code that makes facts do anything. Track assignment
-- is DERIVED, and every source (defaults, demographic rules, questionnaire routing,
-- classify/manual mods) converges on this single resolution. Adding facts as a sixth arm
-- means the MLP, archival, the CMS preview and the questionnaire inspector all pick it up
-- with NO further changes — exactly how migration 045 made archival universal.
--
-- ⚠⚠ THE FUNCTION AND THE VIEW ARE THE SAME LOGIC IN TWO PLACES AND MUST STAY IN SYNC.
-- (Established by migration 037, re-stated by 045.) They have different consumers —
-- the function is read by the backend recompute (loadUserMlpInputs), the view by
-- apply_classification (migrations 020/021) and any app-side reader — so a change to one
-- without the other silently gives two users different plans depending on entry point.
-- Both are changed here, identically, in one transaction. Never split them.
--
-- ⚠ TRANSCRIPTION WARNING: the function and view bodies below are migration 045's verbatim,
-- with ONE arm added and ONE line added to base_set (both marked `-- ADDED (074)`). Nothing
-- else in them differs. CONFIRMED LIVE 2026-09-14 on both projects: the view text is identical
-- (md5 79bf5b04...), and the function differs only in $$ vs $function$ quoting. The file ALSO
-- adds a SECURITY DEFINER helper (section 0) and replaces user_active_tracks_with_reason
-- (section 3) — see the two WHY notes below. BEFORE APPLYING, confirm 045 is still what is live — if anything has been
-- re-created since, re-base onto the live text instead of this file:
--   SELECT pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure);
--   SELECT pg_get_viewdef('user_active_tracks'::regclass, true);
--
-- INTERACTION WITH MIGRATION 059 (user_mlp_data LEFT JOIN rewrite) — NOW APPLIED.
-- 059 went live 2026-09-11 and does NOT touch these two objects, so it does not conflict
-- with this file. It DOES change what the `default_tracks` arm returns: zero-child users now
-- get a user_mlp_data row, hence the default tracks (verified live 2026-09-12: 2 of 5 rows
-- have zero children). That matters for facts specifically — financial-domain users are
-- zero-child, so they now receive default tracks AND fact-granted tracks through the same
-- resolution, rather than fact tracks alone.
--
-- WHY A SECURITY DEFINER HELPER (decision D7, 2026-09-14). 071 REVOKEs user_facts_latest from
-- anon/authenticated. The function is SECURITY INVOKER, so reading that view directly would
-- make every anon/authenticated CALL of the function fail — and pg_stat_statements on Moosii
-- shows `authenticated` calling it through PostgREST rpc. So the function reads facts through
-- user_fact_track_ids(p_user_id): SECURITY DEFINER, pinned search_path, returning ONLY track ids
-- (never a fact key or value). Callers keep exactly the access they have today and raw facts
-- stay unreadable. EXECUTE mirrors the function's current ACL (anon, authenticated,
-- service_role) so nothing that works today breaks. ⚠ That includes anon — which, like the
-- view's existing owner-rights read, lets the anon key see which tracks a user's facts grant.
-- The follow-up RLS migration (077, proposed) removes anon from both.
-- The VIEW twin keeps reading user_facts_latest directly: a plain view runs with its owner's
-- rights, so the REVOKE does not touch it (tested).
--
-- WHY with_reason IS REPLACED HERE. user_active_tracks_with_reason exists live but in no earlier
-- migration. It reads user_active_tracks and LEFT JOINs one reason per arm, so without a fact
-- arm a fact-granted track would still APPEAR but be labelled active_reason='unknown'. It gains
-- `fact_match` (after profile_match, before unknown) in this same transaction. Section 3's body
-- is the LIVE text (pg_get_viewdef, identical on both projects, md5 8393d8ef...) plus the lines
-- marked `-- ADDED (074)`; output columns are unchanged, so grants and the PostgREST shape are
-- kept. It is the CMS inspector's read (authenticated) — verify the inspector after applying.
--
-- SEMANTICS OF THE NEW ARM:
--   * ADDITIVE ONLY. It contributes rows to base_set and can never emit a removal —
--     there is no `add=false` equivalent for facts (mirroring the check-in routing arm,
--     migration 048/049, which likewise only ever adds).
--   * A human `delete` in user_mlp_mods still WINS: the final EXCEPT runs after base_set,
--     so a fact cannot resurrect a track an admin explicitly removed.
--   * An ARCHIVED target track stays inert — the final `JOIN tracks … archived_at IS NULL`
--     (045) filters it exactly as it does every other arm.
--   * A CLEARED fact stops contributing immediately (user_facts_latest flips), so the
--     track leaves on the next recompute UNLESS another arm also grants it. See
--     `docs/drafts/facts-v1/README.md` §4 — this is the point Mark must confirm.
--   * EMPTY VOCABULARY = NO-OP. With no fact_track_rules rows the arm returns nothing and
--     resolution is byte-identical to 045, so this is safe to apply to BOTH Supabase
--     projects to keep the schemas identical.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — LAST in the facts-v1 set. Requires 071
-- (user_facts_latest) and 072 (fact_track_rules) to exist first, or it fails to compile.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. This file REPLACES two live objects wholesale, so these checks
-- guard against silently reverting anything that changed since migration 045.
-- 1. 071 and 072 are applied (the arm will not compile without them) — EXPECT both not NULL:
--    SELECT to_regclass('public.user_facts_latest') AS latest_view,
--           to_regclass('public.fact_track_rules')  AS track_rules;
-- 2. The live bodies are still 045's: each must mention `archived_at IS NULL` and must NOT
--    already contain `fact_tracks`. If either differs, RE-BASE this file on the live text.
--    SELECT pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure);
--    SELECT pg_get_viewdef('user_active_tracks'::regclass, true);
--    (Checked 2026-09-12 by repo audit: only 048/049 mention these objects after 045, and
--    both change the questionnaire_responses_tracks view they READ, never the pair itself.)
-- 3. The twins are in sync BEFORE the change — EXPECT ZERO ROWS. (Verified live on Moosii
--    2026-09-12: 0 mismatches across all 5 users. A non-zero result means the pair has already
--    drifted, and this migration would bake that drift in.)
--    ⚠ ON FINANCIAL THIS CHECK IS VACUOUS: no users, so zero rows proves nothing. There, run
--    3b on BOTH projects and compare.
--    WITH users AS (SELECT DISTINCT user_id FROM user_active_tracks)
--    (SELECT user_id, track_id FROM user_active_tracks
--      EXCEPT SELECT f.user_id, f.track_id
--      FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f)
--    UNION ALL
--    (SELECT f.user_id, f.track_id
--      FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
--      EXCEPT SELECT user_id, track_id FROM user_active_tracks);
-- 3b. The live definitions are the SAME on financial as on Moosii. Run on each; financial first:
--    SELECT current_setting('server_version_num') AS pg,
--           md5(pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure)) AS fn_md5,
--           md5(pg_get_viewdef('user_active_tracks'::regclass, true))                  AS view_md5;
--    Same Postgres MAJOR on both -> both hashes must match. Different majors -> the deparsed
--    view text can differ cosmetically; diff the two pre-check-2 outputs by eye instead.
-- 4. Capture the current total, to prove the arm is a no-op with no rules authored:
--    SELECT count(*) FROM user_active_tracks;   -- note the number; re-run after applying
-- 5. WHO CALLS THE FUNCTION, AS WHICH ROLE. Answered 2026-09-14 — Moosii: service_role 148,
--    authenticated 9, postgres 1; financial: postgres only. The authenticated calls are why the
--    fact arm goes through the section-0 helper, so any role may keep calling. Re-run only to
--    see what changed:
--    SELECT r.rolname, sum(s.calls) AS calls
--      FROM extensions.pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
--     WHERE s.query ILIKE '%user_active_tracks_for_user%'
--     GROUP BY r.rolname ORDER BY calls DESC;
-- 6. with_reason is still the live text section 3 was built from — EXPECT md5
--    8393d8efcc135d42d2ece9011797620f (identical on both projects, 2026-09-14). If it differs,
--    RE-BASE section 3 on the live text before applying:
--    SELECT md5(pg_get_viewdef('user_active_tracks_with_reason'::regclass, true));
-- 7. The helper name is free — EXPECT NULL:
--    SELECT to_regprocedure('public.user_fact_track_ids(uuid)');
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- 0. Helper: ONE user's fact-granted track ids, with owner's rights ------------------
-- Returns track ids only — never a fact key or value. search_path is pinned, as every
-- SECURITY DEFINER function must be, so a caller cannot shadow user_facts_latest.
CREATE OR REPLACE FUNCTION public.user_fact_track_ids(p_user_id uuid)
RETURNS TABLE (track_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT ftr.track_id
  FROM public.user_facts_latest ufl
    JOIN public.fact_track_rules ftr
      ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
  WHERE ufl.user_id = p_user_id;
$$;

COMMENT ON FUNCTION public.user_fact_track_ids(uuid) IS
  'Facts v1 (migration 074): track ids granted to ONE user by their latest facts. SECURITY '
  'DEFINER so user_active_tracks_for_user (SECURITY INVOKER) can read facts for callers that '
  'cannot read user_facts_latest. Returns ids only. EXECUTE mirrors that function''s ACL.';

REVOKE ALL ON FUNCTION public.user_fact_track_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_fact_track_ids(uuid) TO anon, authenticated, service_role;

-- ---- 1. Per-user function (twin of the view; migrations 037/045) ----------------------
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
  ), fact_tracks AS (                        -- ADDED (074): via the SECURITY DEFINER helper
    SELECT p_user_id AS user_id, uft.track_id
    FROM user_fact_track_ids(p_user_id) uft
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
    UNION
    SELECT fact_tracks.user_id, fact_tracks.track_id FROM fact_tracks   -- ADDED (074)
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
  'Migration 074 added the fact_tracks arm, read through user_fact_track_ids (SECURITY DEFINER).';

-- ---- 2. The view twin (KEEP IN SYNC WITH THE FUNCTION ABOVE) --------------------------
CREATE OR REPLACE VIEW public.user_active_tracks AS
  WITH base_tracks AS (
    SELECT DISTINCT udr.user_id, dtr.track_id
    FROM user_demographic_responses udr
      JOIN demographic_questions dq ON dq.id = udr.question_id AND dq.is_active = true
      JOIN demographic_answers da ON da.id = udr.answer_id AND da.is_active = true
      JOIN demographic_track_rules dtr ON dtr.answer_id = udr.answer_id
  ), default_tracks AS (
    SELECT u.user_id, nut.track_id
    FROM user_mlp_data u
      CROSS JOIN new_user_tracks nut
  ), fact_tracks AS (                        -- ADDED (074): keep in sync with the function
    SELECT ufl.user_id, ftr.track_id
    FROM user_facts_latest ufl
      JOIN fact_track_rules ftr
        ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
    UNION
    SELECT fact_tracks.user_id, fact_tracks.track_id FROM fact_tracks   -- ADDED (074)
  ), questionnaire_track_actions AS (
    SELECT qrt.user_id, qrt.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
    WHERE qrt.track_id IS NOT NULL
    UNION ALL
    SELECT qrt.user_id, ttm.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
      JOIN track_tag_map ttm ON qrt.tag_id = ttm.tag_id
    WHERE qrt.tag_id IS NOT NULL
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
    AND t.archived_at IS NULL          -- from 045: keep in sync with the function twin
  ORDER BY ft.user_id, t.weight DESC;

-- ---- 3. user_active_tracks_with_reason: LIVE text + a fact_match reason ----------------
-- Output columns and their order are unchanged, so CREATE OR REPLACE keeps grants and the
-- PostgREST shape. Reads user_facts_latest directly: a plain view, owner's rights.
CREATE OR REPLACE VIEW public.user_active_tracks_with_reason AS
 WITH default_tracks AS (
         SELECT u.user_id,
            nut.track_id
           FROM user_mlp_data u
             CROSS JOIN new_user_tracks nut
        ), questionnaire_track_actions AS (
         SELECT qrt.user_id,
            qrt.track_id,
            qrt.add,
            qrt.action_at,
            qrt.questionnaire_id,
            qrt.response_id,
            qrt.tag_id,
            qrt.score AS questionnaire_score,
            'direct_track'::text AS q_source
           FROM questionnaire_responses_tracks qrt
          WHERE qrt.track_id IS NOT NULL
        UNION ALL
         SELECT qrt.user_id,
            ttm.track_id,
            qrt.add,
            qrt.action_at,
            qrt.questionnaire_id,
            qrt.response_id,
            qrt.tag_id,
            qrt.score AS questionnaire_score,
            'tag_map'::text AS q_source
           FROM questionnaire_responses_tracks qrt
             JOIN track_tag_map ttm ON qrt.tag_id = ttm.tag_id
          WHERE qrt.tag_id IS NOT NULL
        ), latest_questionnaire_action AS (
         SELECT DISTINCT ON (qta.user_id, qta.track_id) qta.user_id,
            qta.track_id,
            qta.add,
            qta.action_at,
            qta.questionnaire_id,
            qta.response_id,
            qta.tag_id,
            qta.questionnaire_score,
            qta.q_source
           FROM questionnaire_track_actions qta
          ORDER BY qta.user_id, qta.track_id, qta.action_at DESC NULLS LAST, qta.add DESC
        ), latest_user_mod AS (
         SELECT DISTINCT ON (umm.user_id, umm.track_id) umm.user_id,
            umm.track_id,
            lower(umm.action) AS action,
            umm.created_at AS action_at,
            umm.id AS mod_id
           FROM user_mlp_mods umm
          ORDER BY umm.user_id, umm.track_id, umm.created_at DESC NULLS LAST, umm.id DESC
        ), demographic_rule AS (
         SELECT DISTINCT ON (udr.user_id, dtr.track_id) udr.user_id,
            dtr.track_id,
            dq.prompt_text,
            da.display_text
           FROM user_demographic_responses udr
             JOIN demographic_questions dq ON dq.id = udr.question_id AND dq.is_active = true
             JOIN demographic_answers da ON da.id = udr.answer_id AND da.is_active = true
             JOIN demographic_track_rules dtr ON dtr.answer_id = udr.answer_id
          ORDER BY udr.user_id, dtr.track_id, dq.sort_order, dq.prompt_text
        ), fact_rule AS (                                   -- ADDED (074): one fact per granted track
         SELECT DISTINCT ON (ufl.user_id, ftr.track_id) ufl.user_id,
            ftr.track_id,
            ufl.fact_key,
            ufl.value
           FROM user_facts_latest ufl
             JOIN fact_track_rules ftr ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
          ORDER BY ufl.user_id, ftr.track_id, ufl.fact_key
        )
 SELECT uat.user_id,
    uat.track_id,
    uat.track_name,
    uat.priority,
    uat.weight,
        CASE
            WHEN lum.action = 'add'::text THEN 'manual_add'::text
            WHEN lqa.add IS TRUE THEN 'questionnaire_add'::text
            WHEN dt.track_id IS NOT NULL THEN 'new_user_default'::text
            WHEN dr.track_id IS NOT NULL THEN 'profile_match'::text
            WHEN fr.track_id IS NOT NULL THEN 'fact_match'::text                    -- ADDED (074)
            ELSE 'unknown'::text
        END AS active_reason,
    lum.action_at AS manual_action_at,
    lum.mod_id AS manual_mod_id,
    lqa.action_at AS questionnaire_action_at,
    lqa.questionnaire_id,
    lqa.response_id AS questionnaire_rule_id,
    lqa.tag_id AS questionnaire_tag_id,
    lqa.q_source AS questionnaire_source,
    lqa.questionnaire_score,
        CASE
            WHEN lum.action = 'add'::text THEN 'Manual override'::text
            WHEN lqa.add IS TRUE THEN concat_ws(' | '::text, concat('Questionnaire: ', q.questionnaire_name), concat('Score: ', lqa.questionnaire_score),
            CASE
                WHEN lqa.q_source = 'tag_map'::text THEN 'Via tag'::text
                ELSE NULL::text
            END)
            WHEN dt.track_id IS NOT NULL THEN 'Default track'::text
            WHEN dr.track_id IS NOT NULL THEN concat('Demographic: ', dr.prompt_text, ' = ', dr.display_text)
            WHEN fr.track_id IS NOT NULL THEN concat('Fact: ', fr.fact_key, ' = ', fr.value)  -- ADDED (074)
            ELSE NULL::text
        END AS reason_detail
   FROM user_active_tracks uat
     LEFT JOIN latest_user_mod lum ON lum.user_id = uat.user_id AND lum.track_id = uat.track_id
     LEFT JOIN latest_questionnaire_action lqa ON lqa.user_id = uat.user_id AND lqa.track_id = uat.track_id
     LEFT JOIN default_tracks dt ON dt.user_id = uat.user_id AND dt.track_id = uat.track_id
     LEFT JOIN demographic_rule dr ON dr.user_id = uat.user_id AND dr.track_id = uat.track_id
     LEFT JOIN fact_rule fr ON fr.user_id = uat.user_id AND fr.track_id = uat.track_id  -- ADDED (074)
     LEFT JOIN questionnaire q ON q.id = lqa.questionnaire_id;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. NO-OP PROOF (run BEFORE authoring any fact_track_rules row). With an empty rule
--    table the arm must contribute nothing — EXPECT ZERO ROWS from both halves:
--      WITH users AS (SELECT DISTINCT user_id FROM user_active_tracks)
--      (
--        SELECT 'in_view_not_fn' AS diff, user_id, track_id FROM user_active_tracks
--        EXCEPT
--        SELECT 'in_view_not_fn', f.user_id, f.track_id
--        FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
--      )
--      UNION ALL
--      (
--        SELECT 'in_fn_not_view' AS diff, f.user_id, f.track_id
--        FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
--        EXCEPT
--        SELECT 'in_fn_not_view', user_id, track_id FROM user_active_tracks
--      );
--
-- 2. ARM PROOF. Author one rule, write one matching fact, and confirm the track appears
--    in BOTH objects; then write a CLEARING observation and confirm it disappears from
--    both (assuming no other arm grants that track):
--      SELECT track_id FROM user_active_tracks_for_user('<uuid>');
--      SELECT track_id FROM user_active_tracks WHERE user_id = '<uuid>';
--
-- 3. CALLERS KEEP THEIR ACCESS, FACTS STAY PRIVATE (both tested locally):
--      SET ROLE authenticated;
--      SELECT count(*) FROM user_active_tracks_for_user('<uuid>');  -- works, includes fact tracks
--      SELECT 1 FROM user_facts_latest LIMIT 1;                     -- permission denied
--      RESET ROLE;
--
-- 4. with_reason LABELS a fact-granted track — after the ARM PROOF, EXPECT 'fact_match':
--      SELECT active_reason, reason_detail FROM user_active_tracks_with_reason
--       WHERE user_id = '<uuid>' AND track_id = '<fact track uuid>';
--    With zero rules, with_reason must be row-for-row what it was before (no-op).
--    Then open the CMS inspector for a user and confirm it still renders (second surface).
-- ============================================================================
