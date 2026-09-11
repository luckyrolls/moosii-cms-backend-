-- ============================================================================
-- Migration 064: app_settings.domain + the published-content edit guard (APPLIED 2026-09-11)
-- ============================================================================
-- FROM: FINDINGS-published-edit.md §C. Implements the BLOCK half of the per-domain
-- published-content edit policy. The WARN half deliberately has no code — see below.
--
-- POLICY: Moosii = warn (the CMS asks the editor to choose), financial = block (content on a
-- published lesson cannot be edited at all; unpublish first).
--
-- ⚠ THE WARN DOMAIN GETS NO TRIGGER, ON PURPOSE. The brief specified "warn-domain → the
-- trigger sets published_unreviewed". There is nothing to set: that state is DERIVED from
-- `lessons.is_published` + the segment's `seg_status` (itself derived from card review_state,
-- migration 056), so it is already correct the instant a card goes back to 'draft'. Stamping
-- it would create a second source of truth for something computable — precisely what
-- invariants 6 and 12 exist to prevent. Migration 065 NAMES the state in a view instead.
-- Under `domain='moosii'` the function below returns on its first branch and changes nothing.
--
-- WHY A TRIGGER AND NOT A ROUTE GUARD. The CMS writes content Supabase-DIRECT on three paths
-- (card reorder, add card, quiz edit — §A.2 rows 10-12) and flips `lessons.is_published`
-- directly too (§A.4), so the backend is not reliably in the loop. A route guard would be
-- advisory; this is the wall.
--
-- ⚠ CONTRACT DRIFT THIS DEPENDS ON — READ §A.4. The CMS still flips `lessons.is_published`
-- Supabase-direct, contrary to what api-contract.md §3 claims. That does NOT break this guard
-- (it reads the column, not the route), but it does mean an option-A unpublish is unaudited.
-- Fixing that is a separate, recommended CMS change.
--
-- FINANCIAL PROJECT: inherits this via the schema dump. It MUST get its own
-- `('domain','financial')` row — the seed below writes 'moosii', so seeding the other project
-- correctly is a manual step, called out in the verification block.
-- ⚠ The financial project inherits `app_settings.domain = 'moosii'` with the dump and must be
-- UPDATEd to `'financial'` IMMEDIATELY AFTER it, because the financial backend boots with
-- `DOMAIN=financial`, sees the inherited `'moosii'` row, and REFUSES TO START on the mismatch
-- (src/lib/domain.ts assertDomainMatchesDatabase → process.exit(1)).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..064 reconciliation list. Idempotent
-- throughout. No CONCURRENTLY (see the standing rule in migrations/README.md).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. Nothing already owns these names:
--    SELECT to_regclass('public.app_settings') AS settings_table,
--           to_regprocedure('public.content_edit_policy_guard()') AS guard_fn;
--    -- EXPECT both NULL on a first apply.
-- 2. How many published lessons would the financial policy currently lock? (On Moosii this
--    is informational — the guard is inert there.)
--    SELECT count(*) FROM lessons WHERE is_published;
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- 1. The settings row the DB reads its policy from ----------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        text        NOT NULL,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_pkey PRIMARY KEY (key)
);

COMMENT ON TABLE public.app_settings IS
  'Deployment-scoped settings the DATABASE itself needs (migration 064). Currently one row: '
  'domain = moosii | financial. MUST match the backend DOMAIN env — src/lib/domain.ts fails '
  'the boot if they differ, so a mislabelled deployment cannot run.';

-- Seeded to 'moosii'. ⚠ The financial project must be updated to 'financial' after the
-- schema dump — see the verification block.
INSERT INTO public.app_settings (key, value) VALUES ('domain', 'moosii')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_domain_valid;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_domain_valid
  CHECK (key <> 'domain' OR value IN ('moosii', 'financial'));

-- Config, backend-mediated: default-deny (docs/rls-sweep.md pattern). The guard function runs
-- as its definer and reads the table regardless.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- ---- 2. The guard ----------------------------------------------------------
-- SECURITY DEFINER so it can read app_settings under any caller's RLS. STABLE reads only.
CREATE OR REPLACE FUNCTION public.content_edit_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain    text;
  v_lesson_id uuid;
  v_name      text;
BEGIN
  SELECT value INTO v_domain FROM app_settings WHERE key = 'domain';

  -- WARN DOMAINS (and an unseeded DB) do nothing here. published_unreviewed is derived; the
  -- CMS has already obtained the editor's choice, and option A means it unpublished first.
  IF v_domain IS DISTINCT FROM 'financial' THEN
    RETURN NULL;
  END IF;

  -- Resolve the owning lesson for whichever content table fired this.
  v_lesson_id := CASE TG_TABLE_NAME
    WHEN 'sub_segments'    THEN (SELECT s.lesson_id FROM segments s
                                  WHERE s.id = COALESCE(NEW.seg_id, OLD.seg_id))
    WHEN 'segments'        THEN COALESCE(NEW.lesson_id, OLD.lesson_id)
    WHEN 'quiz_questions'  THEN (SELECT s.lesson_id FROM segments s
                                  WHERE s.id = COALESCE(NEW.segment_id, OLD.segment_id))
    WHEN 'quiz_answers'    THEN (SELECT s.lesson_id FROM segments s
                                  JOIN quiz_questions q ON q.segment_id = s.id
                                 WHERE q.question_id = COALESCE(NEW.question_id, OLD.question_id))
    -- DECIDED 2026-09-10: `description` and `safety_sensitive` are CONTENT, so the lesson row
    -- itself is a guarded surface. Scoped by column on the trigger below, so publish /
    -- unpublish / archival / priority stay editable while published.
    WHEN 'lessons'         THEN COALESCE(NEW.id, OLD.id)
  END;

  IF v_lesson_id IS NULL THEN
    RETURN NULL;   -- orphan / unresolvable: nothing published to protect
  END IF;

  SELECT l.lesson_name INTO v_name
  FROM lessons l WHERE l.id = v_lesson_id AND l.is_published;

  IF FOUND THEN
    -- ERRCODE is STABLE and is the thing the CMS dialog keys off (see §D). Do not change it
    -- without updating docs/api-contract.md and the CMS error handler together.
    RAISE EXCEPTION
      'content of published lesson % (%) cannot be edited in this domain; unpublish it first',
      v_lesson_id, COALESCE(v_name, '?')
      USING ERRCODE = 'check_violation',
            HINT = 'published_content_locked';
  END IF;

  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.content_edit_policy_guard() IS
  'Migration 064: per-domain published-content edit policy. Inert unless '
  'app_settings.domain = financial, where it refuses any content write touching a published '
  'lesson (HINT published_content_locked). Warn domains need no trigger — the '
  'published_unreviewed state is derived (see 065).';

-- ---- 3. Attach to the four content tables ---------------------------------
-- AFTER, not BEFORE: this decides whether the write is ALLOWED, and raising in AFTER still
-- aborts the statement while letting the row-level checks run first.
DROP TRIGGER IF EXISTS content_edit_policy_guard_trg ON public.sub_segments;
CREATE TRIGGER content_edit_policy_guard_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.sub_segments
  FOR EACH ROW EXECUTE FUNCTION public.content_edit_policy_guard();

DROP TRIGGER IF EXISTS content_edit_policy_guard_trg ON public.quiz_questions;
CREATE TRIGGER content_edit_policy_guard_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.quiz_questions
  FOR EACH ROW EXECUTE FUNCTION public.content_edit_policy_guard();

DROP TRIGGER IF EXISTS content_edit_policy_guard_trg ON public.quiz_answers;
CREATE TRIGGER content_edit_policy_guard_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.quiz_answers
  FOR EACH ROW EXECUTE FUNCTION public.content_edit_policy_guard();

-- segments: only the CONTENT columns. Metadata and the derived seg_status must stay writable,
-- or approving/unpublishing a lesson would be blocked by its own guard.
DROP TRIGGER IF EXISTS content_edit_policy_guard_trg ON public.segments;
CREATE TRIGGER content_edit_policy_guard_trg
  AFTER INSERT OR UPDATE OF title, content, takeaway, anchor_text, description
     OR DELETE ON public.segments
  FOR EACH ROW EXECUTE FUNCTION public.content_edit_policy_guard();

-- lessons: ONLY the two content-bearing columns.
--   description      — the app renders it (moosii-rn useLesson.ts returns it; the plan list
--                      shows it via user_mlp.item_description). Verified 2026-09-10.
--   safety_sensitive — a review-routing input; raising the bar on a published lesson is a
--                      content-policy act, not bookkeeping.
-- Everything else on `lessons` (is_published, published_by, priority, track_id, topic_id,
-- names, ages, curator_note, archived_at, with_quiz) is METADATA and stays writable while
-- published — which is what keeps POST /lessons/:id/publish|unpublish working under the guard.
DROP TRIGGER IF EXISTS content_edit_policy_guard_trg ON public.lessons;
CREATE TRIGGER content_edit_policy_guard_trg
  AFTER UPDATE OF description, safety_sensitive ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.content_edit_policy_guard();

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. The setting is present and legal:
--    SELECT * FROM app_settings WHERE key = 'domain';   -- EXPECT 'moosii' on this project
--    UPDATE app_settings SET value = 'nonsense' WHERE key='domain';  -- must FAIL (CHECK)
--
-- 2. ⚠ ON THE FINANCIAL PROJECT ONLY, after the schema dump:
--    UPDATE app_settings SET value = 'financial', updated_at = now() WHERE key = 'domain';
--    -- and confirm the backend there boots with DOMAIN=financial, or it will exit.
--
-- 3. Moosii is INERT (the guard must not fire). Expect this to SUCCEED, then roll back:
--    BEGIN;
--      UPDATE sub_segments SET title = title
--       WHERE seg_id = (SELECT s.id FROM segments s JOIN lessons l ON l.id = s.lesson_id
--                        WHERE l.is_published LIMIT 1);
--    ROLLBACK;
--
-- 4. The block domain DOES fire. Expect the UPDATE to raise with HINT
--    'published_content_locked', then roll the whole thing back:
--    BEGIN;
--      UPDATE app_settings SET value = 'financial' WHERE key = 'domain';
--      UPDATE sub_segments SET title = title
--       WHERE seg_id = (SELECT s.id FROM segments s JOIN lessons l ON l.id = s.lesson_id
--                        WHERE l.is_published LIMIT 1);
--    ROLLBACK;   -- ⚠ do not COMMIT: it would leave Moosii labelled financial
--
-- 5. An UNPUBLISHED lesson is editable even in the block domain (this is what makes option A
--    work). Same shape as 4 but with `WHERE NOT l.is_published` — expect SUCCESS, then
--    ROLLBACK.
--
-- 6. METADATA on a PUBLISHED lesson stays writable even in the block domain — otherwise the
--    publish route could not unpublish. Expect BOTH to SUCCEED, then roll back:
--    BEGIN;
--      UPDATE app_settings SET value = 'financial' WHERE key = 'domain';
--      UPDATE lessons SET priority = priority     WHERE is_published LIMIT 1;  -- metadata: OK
--      UPDATE lessons SET is_published = false    WHERE is_published LIMIT 1;  -- unpublish: OK
--    ROLLBACK;
--
-- 7. CONTENT columns on `lessons` ARE guarded (the 2026-09-10 decision). Expect this to RAISE:
--    BEGIN;
--      UPDATE app_settings SET value = 'financial' WHERE key = 'domain';
--      UPDATE lessons SET description = description || '' WHERE is_published LIMIT 1;
--    ROLLBACK;
-- ============================================================================

-- ============================================================================
-- CONFIRMED LIVE 2026-09-11 (read-only probe): app_settings holds ('domain','moosii'),
-- stamped 18:16:40Z. The guard is therefore INERT on this project, as intended. The trigger
-- bodies could not be confirmed read-only over PostgREST — confirm with:
--   SELECT tgrelid::regclass AS table, tgname FROM pg_trigger
--    WHERE NOT tgisinternal AND tgname = 'content_edit_policy_guard_trg' ORDER BY 1;
--   -- EXPECT 5 rows: sub_segments, quiz_questions, quiz_answers, segments, lessons
-- ============================================================================
