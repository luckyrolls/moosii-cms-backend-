-- ============================================================================
-- MIGRATION 112: lock "user".moosies against clients (F32) + diagnostics pay once (F33)
--   BOTH PROJECTS (grants + trigger) — DRAFT (pending apply)
-- ============================================================================
-- WHY: migration 111 made trigger_add_moosies + moosie_awards the ONLY award path, and moosii-rn b744b4f stopped
-- writing moosies. Two follow-ups (Mark 2026-10-13):
--
-- F33 — a DIAGNOSTIC questionnaire pays only on the user's FIRST completion of it. Any other completed_items row for
--   the same user + questionnaire → amount 0, and the ledger row is still written (audit). kind = 'checkin' keeps
--   paying on every completion row; lessons / activities unchanged. A per-(user, questionnaire) transaction advisory
--   lock serializes concurrent completions of the same diagnostic, so two racing retakes can't both pay (each
--   statement in the function takes a fresh snapshot, so the second sees the first once it has the lock).
--
-- F32 — signed-in users cannot change "user".moosies (nor any column no client writes). Client-writer inventory
--   2026-10-13 (moosii-rn b744b4f, moosii-cms b99c82a, moosii-reader 337f0d6) — every "user" write made as
--   `authenticated`:
--     UPDATE  useSaveUserProfile.ts:24      display_name, name, gender, parenting_status, financials, birth_date
--     UPDATE  useCompleteOnboarding.ts:16   onboarding_complete
--     UPDATE  useMlpIntro.ts:33             has_seen_mlp_intro
--     UPDATE  useFirstTimeFlag.ts:34        has_seen_lesson_intro, has_seen_questionnaire_intro (its two callers)
--     INSERT  app/(onboarding)/verify.tsx:95  id, email, daily_reminder_time, onboarding_complete
--   moosii-cms and moosii-reader only SELECT "user". Nothing writes moosies (RN b744b4f removed the last writer).
--   Lock = column-level grants, not a rule: REVOKE table-level INSERT/UPDATE from authenticated, then GRANT exactly
--   the columns above. anon loses INSERT/UPDATE entirely (no anon writer; RLS already gave it no rows).
--   Side effect, deliberate: `role`, `can_review_editorial`, `can_approve_clinical`, `is_verified`, `email` (update)
--   etc. were ALSO self-writable through user_self_update — a signed-in app user could make themselves super_admin.
--   That is closed too. A new client write to any other column now fails 42501 until a migration grants it.
--   Unaffected: service_role (table grants kept), the postgres-owned SECURITY DEFINER functions (trigger_add_moosies,
--   create_new_user, handle_user_verification_update), the backend (service role / postgres), BEFORE UPDATE
--   set_updated_at (column privileges apply to the columns the statement names, not trigger-set ones).
--   NOT changed here (reported, backlog): the INSERT policy "Enable insert for authenticated users only" WITH CHECK
--   (true) still lets a signed-in user insert a "user" row for ANOTHER id (now limited to the four granted columns).
--
-- Trigger body hash-guarded: refuses unless the live body is 111's (md5 10d3d5de…) or 112's (09d509d0…).
-- BOTH PROJECTS: one schema (invariant 4). APPLY per migrations/README.md: financial first, then Moosii.
-- No new tables or columns → database.types.ts unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT md5 10d3d5defc033fb8b7c658ad2d92d0b7; authenticated holds table-level
-- INSERT + UPDATE on "user":
--   SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE proname = 'trigger_add_moosies';
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'user' AND grantee IN ('anon','authenticated') ORDER BY 1, 2;
-- ---------------------------------------------------------------------------

BEGIN;

DO $$ DECLARE cur text; BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO cur FROM pg_proc WHERE oid = 'public.trigger_add_moosies()'::regprocedure;
  IF cur <> '10d3d5defc033fb8b7c658ad2d92d0b7' AND cur <> '09d509d0f4f6015944351b471f9f8662' THEN
    RAISE EXCEPTION '112: trigger_add_moosies body md5 % is neither 111''s nor 112''s — re-base before applying', cur;
  END IF;
END $$;

-- ---- F33: diagnostics pay once (same name → completed_items_insert_trigger unchanged; ACL kept by OR REPLACE) ----
CREATE OR REPLACE FUNCTION public.trigger_add_moosies()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
-- 111: the ONLY Moosies award path. One ledger row per completion; the balance moves only if it was inserted.
-- 112: a diagnostic questionnaire pays only on the user's first completion of it (later rows: amount 0, still logged).
DECLARE
  v_kind     text;
  v_qkind    text;
  v_qid      uuid;
  v_retake   boolean := false;
  v_points   integer;
  v_amount   integer;
  v_award_id uuid;
BEGIN
  IF NEW.item_type = 'lesson' THEN
    SELECT l.kind, l.points INTO v_kind, v_points
      FROM public.lessons l WHERE l.id = coalesce(NEW.lesson_id, NEW.item_id);
  ELSIF NEW.item_type = 'questionnaire' THEN
    v_qid := coalesce(NEW.questionnaire_id, NEW.item_id);
    SELECT q.kind, q.points INTO v_qkind, v_points
      FROM public.questionnaire q WHERE q.id = v_qid;
    IF v_qkind = 'diagnostic' THEN
      -- Serialize completions of this diagnostic for this user; the EXISTS below is a new statement with a fresh
      -- snapshot, so it sees a concurrent first completion once that transaction has committed and released the lock.
      PERFORM pg_advisory_xact_lock(hashtextextended('moosies:diagnostic:' || NEW.user_id::text || ':' || v_qid::text, 0));
      v_retake := EXISTS (
        SELECT 1 FROM public.completed_items ci
         WHERE ci.user_id = NEW.user_id AND ci.id <> NEW.id AND ci.item_type = 'questionnaire'
           AND coalesce(ci.questionnaire_id, ci.item_id) = v_qid);
    END IF;
  END IF;

  IF v_kind = 'activity' THEN
    v_amount := 0;                                   -- activity points are reserved for the follow-up slice
  ELSIF v_retake THEN
    v_amount := 0;                                   -- diagnostic retake: paid on the first completion only
  ELSIF v_points IS NOT NULL THEN
    v_amount := v_points;
  ELSE
    SELECT uc.moosi_to_add INTO v_amount             -- fallback only when the item has no points
      FROM public.user_configurations uc WHERE uc.user_id = NEW.user_id;
  END IF;
  v_amount := greatest(coalesce(v_amount, 0), 0);    -- no config → 0; never negative

  INSERT INTO public.moosie_awards (user_id, amount, reason, source_id)
  VALUES (NEW.user_id, v_amount, 'completion', NEW.id::text)
  ON CONFLICT (reason, source_id) DO NOTHING
  RETURNING id INTO v_award_id;

  IF v_award_id IS NOT NULL AND v_amount > 0 THEN
    UPDATE public."user" SET moosies = moosies + v_amount WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.trigger_add_moosies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_add_moosies() TO service_role;

-- ---- F32: "user" writes by clients = exactly the inventoried columns ----
REVOKE INSERT, UPDATE ON public."user" FROM anon, authenticated;
GRANT UPDATE (display_name, name, gender, parenting_status, financials, birth_date,
              onboarding_complete, has_seen_mlp_intro, has_seen_lesson_intro, has_seen_questionnaire_intro)
  ON public."user" TO authenticated;
GRANT INSERT (id, email, daily_reminder_time, onboarding_complete) ON public."user" TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION (after apply):
-- 1. trigger_add_moosies: md5 = 112's, prosecdef = t, proconfig = {search_path=public, pg_temp}, EXECUTE only
--    service_role; completed_items_insert_trigger still bound.
-- 2. Grants: authenticated / anon hold NO table-level INSERT or UPDATE on "user"; authenticated column UPDATE on exactly
--    the 10 columns and column INSERT on exactly the 4; service_role table-level privileges unchanged.
-- 3. Behaviour, ROLLED BACK: docs/drafts/112-moosies-lock/verify.sql — diagnostic pays once then 0 (ledger row kept),
--    check-in pays each time, authenticated UPDATE of moosies / role → 42501, each granted column → OK, an
--    authenticated completion still moves the balance.
-- ---------------------------------------------------------------------------
