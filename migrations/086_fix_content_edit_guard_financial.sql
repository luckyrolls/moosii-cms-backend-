-- ============================================================================
-- MIGRATION 086: content_edit_policy_guard() — per-table branches, so it runs on financial
--   — APPLIED financial 2026-09-16 · APPLIED moosii 2026-09-16 — both projects (financial first)
-- ============================================================================
-- BUG (found 2026-09-16 testing 084 on a local restore of financial's schema): on the financial
-- domain EVERY guarded write fails before the policy is even checked, e.g. creating a lesson:
--   ERROR:  record "new" has no field "seg_id"
--   CONTEXT: PL/pgSQL assignment "v_lesson_id := CASE TG_TABLE_NAME WHEN 'sub_segments' …"
--            … create_lessons_with_segments(jsonb)
-- 064 resolves the owning lesson with ONE CASE expression naming NEW.seg_id, NEW.lesson_id,
-- NEW.segment_id, NEW.question_id and NEW.id. PL/pgSQL prepares an expression as a whole, so every
-- NEW.<field> it names must exist on the table that fired — and no content table has all five.
-- So on financial, inserts/updates/deletes on segments, sub_segments, quiz_questions and
-- quiz_answers (and guarded lesson updates) all raise. `generate_lessons` cannot create a lesson
-- there (its RPC inserts a segment), nor can segment/quiz generation or any CMS card edit.
--
-- WHY MOOSII NEVER SAW IT: the function returns on its first branch unless
-- app_settings.domain = 'financial', so the CASE is never reached there.
--
-- FIX: the same lookups as IF/ELSIF branches, each naming only its own table's columns (a branch's
-- statements are prepared only when that branch runs). Policy, messages, ERRCODE and HINT are
-- unchanged. Same signature and return type, so CREATE OR REPLACE keeps the owner, grants and the
-- five triggers as they are.
--
-- BOTH PROJECTS: the function is identical on both (md5 fb4c390c776af9994d9a064920b7ff4b,
-- 2026-09-16), and one definition should stay one definition. On Moosii the change is inert (the
-- early return is untouched). Apply financial first, then Moosii.
--
-- Idempotent: CREATE OR REPLACE. No CONCURRENTLY. No return-type change.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. The live function is still 064's — EXPECT fb4c390c776af9994d9a064920b7ff4b
--    (or 086's own md5 below if already applied; the body below refuses anything else):
--    SELECT md5(pg_get_functiondef('public.content_edit_policy_guard()'::regprocedure));
-- 2. The five triggers that call it — EXPECT 5 rows (segments, sub_segments, quiz_questions,
--    quiz_answers, lessons):
--    SELECT tgrelid::regclass, tgname FROM pg_trigger
--     WHERE tgfoid = 'public.content_edit_policy_guard()'::regprocedure ORDER BY 1;
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE cur text := md5(pg_get_functiondef('public.content_edit_policy_guard()'::regprocedure));
BEGIN
  IF cur NOT IN ('fb4c390c776af9994d9a064920b7ff4b', 'ba31ffd7a734c96ed8065d59eb4b6249') THEN
    RAISE EXCEPTION '086: content_edit_policy_guard() (md5 %) is not migration 064''s definition — re-base before applying', cur;
  END IF;
END $$;

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

  -- Resolve the owning lesson for whichever content table fired this. One branch per table
  -- (migration 086): each names only that table's columns. A single CASE expression is prepared
  -- whole, so it needs every NEW.<field> it mentions to exist on the firing table.
  IF TG_TABLE_NAME = 'sub_segments' THEN
    SELECT s.lesson_id INTO v_lesson_id FROM segments s
     WHERE s.id = COALESCE(NEW.seg_id, OLD.seg_id);
  ELSIF TG_TABLE_NAME = 'segments' THEN
    v_lesson_id := COALESCE(NEW.lesson_id, OLD.lesson_id);
  ELSIF TG_TABLE_NAME = 'quiz_questions' THEN
    SELECT s.lesson_id INTO v_lesson_id FROM segments s
     WHERE s.id = COALESCE(NEW.segment_id, OLD.segment_id);
  ELSIF TG_TABLE_NAME = 'quiz_answers' THEN
    SELECT s.lesson_id INTO v_lesson_id FROM segments s
      JOIN quiz_questions q ON q.segment_id = s.id
     WHERE q.question_id = COALESCE(NEW.question_id, OLD.question_id);
  ELSIF TG_TABLE_NAME = 'lessons' THEN
    -- DECIDED 2026-09-10: `description` and `safety_sensitive` are CONTENT, so the lesson row
    -- itself is a guarded surface. Scoped by column on the trigger, so publish / unpublish /
    -- archival / priority stay editable while published.
    v_lesson_id := COALESCE(NEW.id, OLD.id);
  END IF;

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
  'Migration 064 (per-table branches since 086): per-domain published-content edit policy. Inert '
  'unless app_settings.domain = financial, where it refuses any content write touching a published '
  'lesson (HINT published_content_locked). Warn domains need no trigger — the '
  'published_unreviewed state is derived (see 065).';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Writes happen inside a transaction that is ROLLED BACK.
-- 1. md5 is 086's — EXPECT 'ba31ffd7a734c96ed8065d59eb4b6249':
--    SELECT md5(pg_get_functiondef('public.content_edit_policy_guard()'::regprocedure));
-- 2. FINANCIAL: unpublished content is writable; published content is locked.
--    BEGIN;
--      INSERT INTO tracks (id, track_name, weight) VALUES ('0c860000-0000-4000-8000-000000000001', 't086', 1);
--      SELECT created FROM create_lessons_with_segments(jsonb_build_array(jsonb_build_object(
--        'lesson_name', 'l086', 'description', 'd', 'priority', 100,
--        'track_id', '0c860000-0000-4000-8000-000000000001', 'safety_sensitive', false)));   -- EXPECT t
--      INSERT INTO sub_segments (seg_id, sequence, title, content)
--        SELECT s.id, 1, 'x', 'y' FROM segments s JOIN lessons l ON l.id = s.lesson_id WHERE l.lesson_name = 'l086';
--      UPDATE sub_segments SET title = 'x2' WHERE title = 'x';                  -- EXPECT UPDATE 1
--      UPDATE lessons SET is_published = true WHERE lesson_name = 'l086';       -- metadata: allowed
--      SAVEPOINT s1;
--      UPDATE sub_segments SET title = 'x3' WHERE title = 'x2';   -- EXPECT ERROR, HINT published_content_locked
--      ROLLBACK TO s1;
--      DELETE FROM sub_segments WHERE title = 'x2';               -- EXPECT ERROR, HINT published_content_locked
--    ROLLBACK;
-- 3. MOOSII: still inert — the same content UPDATE on a published lesson succeeds (roll back):
--    BEGIN;
--      UPDATE sub_segments SET title = title
--       WHERE seg_id = (SELECT s.id FROM segments s JOIN lessons l ON l.id = s.lesson_id
--                        WHERE l.is_published LIMIT 1);                      -- EXPECT UPDATE n, no error
--    ROLLBACK;
-- ============================================================================
