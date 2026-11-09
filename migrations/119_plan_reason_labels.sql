-- ============================================================================
-- MIGRATION 119: authored REASON LABELS for the routing rules + user_track_reasons_for_user
--   (read-only sibling of user_active_tracks_for_user) — BOTH PROJECTS — DRAFT (pending apply)
-- ============================================================================
-- WHY (F83, Mark 2026-11-09; docs/FINDINGS-plan-reasons.md §2). A member should be able to see WHY an
-- item is in their plan. Every reason already exists in data — the five UNION arms of
-- user_active_tracks_for_user ARE the reasons — but the member-facing sentence does not. Decision 2 in
-- the findings: the copy is AUTHORED per rule, never derived; a generated string
-- ("because new_subscription_recent is true") is not shippable.
--
-- WHAT:
--   1. fact_track_rules.reason_label  — text, NOT NULL (populated first), CHECK non-empty AND no digits.
--   2. new_user_tracks.reason_label   — text, NULLABLE, same CHECK.
--   3. Populate financial's 7 fact rules + its one default track with Mark's wording.
--   4. user_track_reasons_for_user(uuid) — NEW, read-only, one row per REASON for each track that is
--      actually active. Service-role EXECUTE only (the 094 rule).
--
-- ⚠ THE FROZEN ALGORITHM IS NOT TOUCHED (invariant 1). Nothing here changes generateFullMLP,
--   computeUserMlp, user_active_tracks_for_user or mlp_item_pool. The new function CALLS
--   user_active_tracks_for_user; it does not alter it, and no reason row can add or remove a track.
--
-- WHY A COLUMN ON new_user_tracks RATHER THAN A `reason_kind -> label` LOOKUP:
--   the default arm's reason is per-TRACK, not per-kind. Moosii has 12 rows in new_user_tracks (every
--   new parent gets all 12 default tracks); financial has 1. A lookup keyed by kind could hold only ONE
--   sentence for the whole arm, which is wrong the moment a project has more than one default track —
--   and it would need its own RLS, grants and CMS surface for a single useful row. new_user_tracks is
--   already the authoritative default-arm table and is exactly 1:1 with the reason. The other arms
--   (demographic_track_rules, questionnaire_response) can each gain the same column later by the same
--   pattern; a per-arm lookup would fragment that.
--
-- WHY new_user_tracks.reason_label IS NULLABLE WHILE fact_track_rules.reason_label IS NOT NULL:
--   financial's single default track has Mark's stated sentence, and its 7 fact rules are all covered,
--   so NOT NULL on fact_track_rules is free today AND forces every future routing rule to carry copy.
--   Moosii's 12 default tracks are PARENTING copy (Sleep, Safety, Parental Wellness, …) which is not
--   this seat's to write — invariant 11's posture on member-facing clinical-adjacent copy. They stay
--   NULL, GET /plan returns label: null for them, and there is NO fallback text in code (the same
--   discipline as the grounding block). Authoring those 12 is a Moosii content task.
--
-- NO AMOUNTS: the CHECK rejects any digit in a label, structurally (invariants 3 and 12 — facts are
--   banded tokens, never amounts, so the sentence that explains one must not carry a number either).
--
-- BOTH PROJECTS (invariant 4): the two columns and the function are schema and land on both. The
--   populate UPDATEs match on financial's rule rows / track id, so they are natural no-ops on Moosii
--   (0 fact_track_rules rows there, and no Getting Oriented track) — no domain guard needed, and the
--   file is NOT marked project-only.
-- ⚠ MIGRATION BEFORE CODE: GET /plan reads reason_label and calls user_track_reasons_for_user, so
--   apply this on BOTH projects before the code is pushed (a push deploys both services).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. The tables are there and the columns are free — EXPECT 2 rows with has_label 'f':
--      SELECT c.relname AS tbl,
--             EXISTS (SELECT 1 FROM information_schema.columns
--                      WHERE table_schema='public' AND table_name=c.relname AND column_name='reason_label') AS has_label
--        FROM pg_class c WHERE c.relname IN ('fact_track_rules','new_user_tracks') ORDER BY 1;
-- 2. The function is free — EXPECT 0 rows:
--      SELECT proname FROM pg_proc WHERE proname = 'user_track_reasons_for_user';
-- 3. What the populate must cover — EXPECT every fact rule to be matched by the UPDATEs below
--    (financial 7 rows; Moosii 0):
--      SELECT ftr.fact_key, ftr.value, t.track_name FROM public.fact_track_rules ftr
--        JOIN public.tracks t ON t.id = ftr.track_id ORDER BY 1, 2;
--      SELECT nut.track_id, t.track_name FROM public.new_user_tracks nut
--        JOIN public.tracks t ON t.id = nut.track_id ORDER BY 2;
-- 4. The shared object this file must NOT change — record it and compare after:
--      SELECT md5(prosrc) FROM pg_proc WHERE proname = 'user_active_tracks_for_user';
-- ---------------------------------------------------------------------------

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.fact_track_rules') IS NULL OR to_regclass('public.new_user_tracks') IS NULL THEN
    RAISE EXCEPTION '119: fact_track_rules / new_user_tracks missing — apply 069..076 first';
  END IF;
  IF to_regclass('public.user_track_activations') IS NULL THEN
    RAISE EXCEPTION '119: user_track_activations missing — apply 019 first';
  END IF;
END $$;

-- ---- 1. the columns -----------------------------------------------------------------------------------
ALTER TABLE public.fact_track_rules ADD COLUMN IF NOT EXISTS reason_label text;
ALTER TABLE public.new_user_tracks  ADD COLUMN IF NOT EXISTS reason_label text;

-- No amounts, no empty strings. A label is a member-facing sentence, so a digit in it would be a number
-- we promised never to show (invariant 12).
ALTER TABLE public.fact_track_rules DROP CONSTRAINT IF EXISTS ftr_reason_label_shape;
ALTER TABLE public.fact_track_rules
  ADD CONSTRAINT ftr_reason_label_shape
  CHECK (reason_label IS NULL OR (btrim(reason_label) <> '' AND reason_label !~ '[0-9]'));

ALTER TABLE public.new_user_tracks DROP CONSTRAINT IF EXISTS nut_reason_label_shape;
ALTER TABLE public.new_user_tracks
  ADD CONSTRAINT nut_reason_label_shape
  CHECK (reason_label IS NULL OR (btrim(reason_label) <> '' AND reason_label !~ '[0-9]'));

COMMENT ON COLUMN public.fact_track_rules.reason_label IS
  'Member-facing sentence for WHY this rule put the track in the plan, returned by GET /plan (119). '
  'Authored, never generated; NOT NULL so a routing rule cannot ship without copy; no digits (no amounts).';
COMMENT ON COLUMN public.new_user_tracks.reason_label IS
  'Member-facing sentence for WHY this default track is in every member plan, returned by GET /plan (119). '
  'Nullable: financial has one default track with authored copy, Moosii has 12 whose parenting copy is '
  'authored separately. NULL means GET /plan returns label: null — there is no fallback text in code.';

-- ---- 2. populate (financial's rows; natural no-ops on Moosii) -----------------------------------------
-- Wording: Mark 2026-11-09, except the last two, which his list did not cover (proposed here).
UPDATE public.fact_track_rules SET reason_label = 'Because your cards are close to their limits'
 WHERE fact_key = 'credit_utilization_band' AND value = 'high';
UPDATE public.fact_track_rules SET reason_label = 'Because your card balances are climbing'
 WHERE fact_key = 'credit_utilization_band' AND value = 'moderate';
UPDATE public.fact_track_rules SET reason_label = 'Because there isn''t much set aside for surprises yet'
 WHERE fact_key = 'has_emergency_buffer' AND value = 'false';
UPDATE public.fact_track_rules SET reason_label = 'Because we don''t see a regular paycheck coming in'
 WHERE fact_key = 'has_direct_deposit' AND value = 'false';
UPDATE public.fact_track_rules SET reason_label = 'Because a new subscription showed up'
 WHERE fact_key = 'new_subscription_recent' AND value = 'true';
-- PROPOSED (not in Mark's list) — both are user-declared goals forwarded by the platform, so the
-- sentence states the goal and claims nothing we did not hear.
UPDATE public.fact_track_rules SET reason_label = 'Because you''re saving towards a home'
 WHERE fact_key = 'saving_for_home' AND value = 'true';
UPDATE public.fact_track_rules SET reason_label = 'Because you want a plan for paying down debt'
 WHERE fact_key = 'wants_debt_payoff_plan' AND value = 'true';

-- The default arm: financial's Getting Oriented only. Moosii's 12 rows stay NULL by design (header).
UPDATE public.new_user_tracks SET reason_label = 'A starting point for everyone'
 WHERE track_id = 'f0840000-0000-4000-8000-000000000001';

-- Fail LOUDLY rather than with a bare 23502 if a rule was added since this file was written.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%s=%s', fact_key, value), ', ' ORDER BY fact_key, value)
    INTO v_missing FROM public.fact_track_rules WHERE reason_label IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '119: fact_track_rules rows have no reason_label: %. Author the copy and add an UPDATE to this file.', v_missing;
  END IF;
END $$;

ALTER TABLE public.fact_track_rules ALTER COLUMN reason_label SET NOT NULL;

-- ---- 3. user_track_reasons_for_user — NEW, read-only ---------------------------------------------------
-- One row per REASON, for the tracks that are ACTUALLY ACTIVE: the arms are joined to
-- user_active_tracks_for_user, so a track removed by a questionnaire 'delete' or a manual 'delete'
-- reports no reasons even though its rule still matches. A track with two reasons returns two rows
-- (Building a Buffer genuinely matches has_emergency_buffer=false AND saving_for_home=true).
--
-- kind: default | fact | demographic | questionnaire | insight | manual
--   fact        — carries fact_key / value / observed_at / source (the observation behind it)
--   insight     — a user_mlp_mods 'add' WITH a backing user_track_activations row (source, confidence)
--   manual      — a user_mlp_mods 'add' with NO activation row: a human put it there
--   demographic / questionnaire — no authored copy yet, so label is NULL (see the header)
-- SECURITY INVOKER (the default) on purpose: no SECURITY DEFINER, so RLS binds for whoever calls it and
-- there is nothing for the 094 hazard to exploit. The backend calls it as service_role.
CREATE OR REPLACE FUNCTION public.user_track_reasons_for_user(p_user_id uuid)
 RETURNS TABLE (track_id uuid, track_name text, kind text, label text,
                fact_key text, value text, observed_at timestamptz,
                source text, source_ref text, confidence numeric, action_at timestamptz)
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_temp
AS $function$
  WITH active AS (
    SELECT uat.track_id, uat.track_name
      FROM public.user_active_tracks_for_user(p_user_id) uat
  ), reasons AS (
    -- default arm (user_mlp_data CROSS JOIN new_user_tracks, as the active-tracks function has it)
    SELECT nut.track_id                AS track_id,
           'default'::text             AS kind,
           nut.reason_label            AS label,
           NULL::text                  AS fact_key,
           NULL::text                  AS value,
           NULL::timestamptz           AS observed_at,
           NULL::text                  AS source,
           NULL::text                  AS source_ref,
           NULL::numeric               AS confidence,
           NULL::timestamptz           AS action_at
      FROM public.user_mlp_data u
     CROSS JOIN public.new_user_tracks nut
     WHERE u.user_id = p_user_id

    UNION ALL
    -- fact arm
    SELECT ftr.track_id, 'fact'::text, ftr.reason_label,
           ufl.fact_key, ufl.value, ufl.observed_at,
           ufl.source, ufl.source_ref, NULL::numeric, NULL::timestamptz
      FROM public.user_facts_latest ufl
      JOIN public.fact_track_rules ftr
        ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
     WHERE ufl.user_id = p_user_id

    UNION ALL
    -- demographic arm
    SELECT DISTINCT dtr.track_id, 'demographic'::text, NULL::text,
           NULL::text, NULL::text, NULL::timestamptz,
           NULL::text, NULL::text, NULL::numeric, NULL::timestamptz
      FROM public.user_demographic_responses udr
      JOIN public.demographic_questions dq ON dq.id = udr.question_id AND dq.is_active = true
      JOIN public.demographic_answers da ON da.id = udr.answer_id AND da.is_active = true
      JOIN public.demographic_track_rules dtr ON dtr.answer_id = udr.answer_id
     WHERE udr.user_id = p_user_id

    UNION ALL
    -- questionnaire arm: latest action per track, reported only when it ADDS (same ordering as the
    -- active-tracks function: action_at DESC, add DESC)
    SELECT q.track_id, 'questionnaire'::text, NULL::text,
           NULL::text, NULL::text, NULL::timestamptz,
           NULL::text, NULL::text, NULL::numeric, q.action_at
      FROM (
        SELECT DISTINCT ON (qta.track_id) qta.track_id, qta.add, qta.action_at
          FROM (
            SELECT qrt.track_id, qrt.add, qrt.action_at
              FROM public.questionnaire_responses_tracks qrt
             WHERE qrt.user_id = p_user_id AND qrt.track_id IS NOT NULL
            UNION ALL
            SELECT ttm.track_id, qrt.add, qrt.action_at
              FROM public.questionnaire_responses_tracks qrt
              JOIN public.track_tag_map ttm ON qrt.tag_id = ttm.tag_id
             WHERE qrt.user_id = p_user_id AND qrt.tag_id IS NOT NULL
          ) qta
         ORDER BY qta.track_id, qta.action_at DESC, qta.add DESC
      ) q
     WHERE q.add = true

    UNION ALL
    -- manual / insight arm: latest mod per track, reported only when it ADDS; the backing activation
    -- row (if any) makes it an insight and carries its provenance
    SELECT m.track_id,
           CASE WHEN a.id IS NULL THEN 'manual'::text ELSE 'insight'::text END,
           NULL::text, NULL::text, NULL::text, NULL::timestamptz,
           a.source, a.source_ref, a.confidence, m.created_at
      FROM (
        SELECT DISTINCT ON (umm.track_id) umm.id, umm.track_id, lower(umm.action) AS action, umm.created_at
          FROM public.user_mlp_mods umm
         WHERE umm.user_id = p_user_id
         ORDER BY umm.track_id, umm.created_at DESC
      ) m
      LEFT JOIN public.user_track_activations a ON a.source_ref = m.id::text
     WHERE m.action = 'add'
  )
  SELECT a.track_id, a.track_name, r.kind, r.label, r.fact_key, r.value, r.observed_at,
         r.source, r.source_ref, r.confidence, r.action_at
    FROM active a
    JOIN reasons r ON r.track_id = a.track_id
   ORDER BY a.track_name, r.kind, r.fact_key NULLS LAST, r.value NULLS LAST;
$function$;

COMMENT ON FUNCTION public.user_track_reasons_for_user(uuid) IS
  'One row per REASON a track is in this user''s plan (119, F83). Read-only sibling of '
  'user_active_tracks_for_user: it CALLS that function and never changes it, so no reason row can add '
  'or remove a track. kind = default|fact|demographic|questionnaire|insight|manual; label is the '
  'authored sentence (NULL where none is authored - no fallback in code).';

-- Backend-only (the 094 rule): Supabase grants anon/authenticated EXECUTE on every NEW function and
-- PostgREST exposes all of public at /rest/v1/rpc/*.
REVOKE EXECUTE ON FUNCTION public.user_track_reasons_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.user_track_reasons_for_user(uuid) TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
-- 1. Columns + constraints — EXPECT fact_track_rules.reason_label is_nullable 'NO',
--    new_user_tracks.reason_label 'YES', and both CHECKs present:
--      SELECT table_name, column_name, is_nullable FROM information_schema.columns
--       WHERE table_schema='public' AND column_name='reason_label' ORDER BY table_name;
--      SELECT conname FROM pg_constraint WHERE conname IN ('ftr_reason_label_shape','nut_reason_label_shape');
-- 2. The no-amounts CHECK bites — EXPECT 23514 twice, both rolled back:
--      BEGIN; UPDATE public.fact_track_rules SET reason_label = 'Because you are 30% utilized'; ROLLBACK;
--      BEGIN; UPDATE public.new_user_tracks  SET reason_label = '   ';                           ROLLBACK;
--      (Moosii: fact_track_rules is empty, so only the new_user_tracks half runs there.)
-- 3. Every rule has copy — EXPECT 0 rows:
--      SELECT fact_key, value FROM public.fact_track_rules WHERE reason_label IS NULL;
-- 4. The labels read back (FINANCIAL) — EXPECT 7 rows + the default sentence:
--      SELECT ftr.fact_key, ftr.value, t.track_name, ftr.reason_label
--        FROM public.fact_track_rules ftr JOIN public.tracks t ON t.id = ftr.track_id ORDER BY 1, 2;
--      SELECT t.track_name, nut.reason_label FROM public.new_user_tracks nut
--        JOIN public.tracks t ON t.id = nut.track_id ORDER BY 1;
--      (MOOSII — EXPECT 0 fact rules and 12 default tracks all reason_label NULL.)
-- 5. The function's privileges — EXPECT service_role only, no anon/authenticated:
--      SELECT array_to_string(proacl, ', ') FROM pg_proc WHERE proname='user_track_reasons_for_user';
-- 6. The frozen shared object is byte-identical — EXPECT the SAME md5 as PRE-CHECK step 4:
--      SELECT md5(prosrc) FROM pg_proc WHERE proname='user_active_tracks_for_user';
-- 7. It agrees with the active-track list (FINANCIAL, Sam) — EXPECT a reason for every active track and
--    none for an inactive one:
--      SELECT track_name, kind, label, fact_key, value
--        FROM public.user_track_reasons_for_user('19587e0a-bfe0-48e2-94a1-055a5bbc9584') ORDER BY 1, 2;
--      -- EXPECT: Credit Health / fact / 'Because your cards are close to their limits' /
--      --         credit_utilization_band=high;  Getting Oriented / default / 'A starting point for everyone'
--      SELECT count(*) AS orphan_reasons FROM public.user_track_reasons_for_user('19587e0a-bfe0-48e2-94a1-055a5bbc9584') r
--       WHERE NOT EXISTS (SELECT 1 FROM public.user_active_tracks_for_user('19587e0a-bfe0-48e2-94a1-055a5bbc9584') u
--                          WHERE u.track_id = r.track_id);   -- EXPECT 0
--      (MOOSII has no fact rules and no demo user; run it for any user_id with a "user" row — EXPECT
--       12 'default' rows with label NULL, one per new_user_tracks row, and 0 orphans.)
-- ============================================================================
