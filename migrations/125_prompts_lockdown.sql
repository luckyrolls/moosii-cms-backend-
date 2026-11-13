-- MIGRATION 125: prompts lockdown -- drop the open INSERT policy, one active row per prompt_type.
--
-- *** BOTH PROJECTS *** (identical policy and data shape on financial and moosii).
--
-- STATUS: DRAFT (pending apply). Do not apply without a go. FINANCIAL first, then MOOSII on a
-- second go, per CLAUDE.md's apply gate.
--
-- WHY
-- `public.prompts` carries a legacy permissive policy, `"Enable insert for authenticated users
-- only"` INSERT TO authenticated WITH CHECK (true). There is no UPDATE and no DELETE policy, so a
-- client cannot change an existing row -- but ANY signed-in user can INSERT one. Six generation
-- paths select their prompt row by `prompt_type` + `is_active` + `.single()`:
--     generateLessons.ts:50-54   generateQuiz.ts:51-55        generateQuestionnaire.ts:62-66
--     reviewLesson.ts:115-119    coverageAudit.ts:65-69       classifyUpdate.ts:49-53
-- PostgREST `.single()` errors on zero OR more than one row, so a second active row of the same
-- type is never silently substituted -- it makes the query FAIL. One INSERT of
-- `{prompt_type:'classify_update', is_active:true}` therefore takes down `/classify-update` for
-- every app user, and the same trick kills lesson/quiz/questionnaire generation, the reviewer or
-- the coverage audit. Segment content is the exception: it selects by explicit `prompts.id`
-- (generateSegmentContent.ts:50-55), so many active segment rows are CORRECT and expected -- a
-- tone library. See docs/FINDINGS-roles.md section 6.
--
-- Two changes, belt and braces:
--   1. the open INSERT policy goes, so no client can add a prompt row at all (the backend writes
--      prompts with the service role, which bypasses RLS: /tones, /questionnaire-prompt);
--   2. a partial UNIQUE INDEX makes "one active row per prompt_type" structural, so the invariant
--      those six `.single()` calls depend on is enforced by the database rather than by habit.
--      `prompt_type <> 'segment'` keeps the tone library out of it; a NULL prompt_type is excluded
--      by the predicate (both projects have 0 such rows today).
--
-- OUT OF SCOPE (deliberately, this file changes nothing else):
--   - the two SELECT policies on prompts (`prompts_sel` is `USING (true)` TO public, so anon can
--     still read every system_message -- a separate decision);
--   - the other 17 tables carrying `INSERT ... WITH CHECK (true)` (docs/rls-sweep.md);
--   - the missing `is_active` filter on GET /tones (src/routes/tones.ts:64-67);
--   - any code change.

BEGIN;

-- ---------------------------------------------------------------- PRE-CHECK
DO $$
DECLARE
  v_domain   text;
  v_name     text;
  v_count    int;
  v_dups     text;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  RAISE NOTICE '125 PRE-CHECK: domain=% system=%', v_domain, (pg_control_system()).system_identifier;

  -- 1. The INSERT policy must exist, and there must be exactly one. No IF EXISTS anywhere in this
  --    file: if the policy is already gone or has been renamed, this migration stops.
  SELECT count(*), max(policyname) INTO v_count, v_name
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'prompts' AND cmd = 'INSERT';

  IF v_count = 0 THEN
    RAISE EXCEPTION '125: no INSERT policy on public.prompts -- already dropped, or never existed';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION '125: % INSERT policies on public.prompts, expected exactly 1 -- re-base this file', v_count;
  END IF;

  RAISE NOTICE '125 PRE-CHECK: INSERT policy found: %', quote_literal(v_name);

  IF v_name <> 'Enable insert for authenticated users only' THEN
    RAISE EXCEPTION '125: the INSERT policy is named %, not the expected %; the DROP below names the expected one -- re-base',
      quote_literal(v_name), quote_literal('Enable insert for authenticated users only');
  END IF;

  -- 2. The unique index below must be satisfiable. Report every offending type, not just the first.
  SELECT string_agg(prompt_type || ' x' || n, ', ' ORDER BY prompt_type) INTO v_dups
    FROM (SELECT prompt_type, count(*) AS n
            FROM public.prompts
           WHERE is_active AND prompt_type <> 'segment'
           GROUP BY prompt_type HAVING count(*) > 1) d;

  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION '125: duplicate ACTIVE prompts per type (%) -- deactivate the extras first; these are the rows that break .single()', v_dups;
  END IF;

  SELECT count(*) INTO v_count FROM public.prompts WHERE is_active AND prompt_type <> 'segment';
  RAISE NOTICE '125 PRE-CHECK: % active non-segment prompt row(s), all unique per type', v_count;

  SELECT count(*) INTO v_count FROM public.prompts WHERE prompt_type IS NULL;
  IF v_count > 0 THEN
    RAISE NOTICE '125 PRE-CHECK: % row(s) with NULL prompt_type -- excluded by the index predicate, not touched', v_count;
  END IF;
END $$;

-- ---------------------------------------------------------------- 1. the open INSERT policy goes
DROP POLICY "Enable insert for authenticated users only" ON public.prompts;

-- ---------------------------------------------------------------- 2. one active row per type
-- No CONCURRENTLY: it cannot run in a transaction and a partial run leaves an INVALID index.
CREATE UNIQUE INDEX prompts_one_active_per_type
    ON public.prompts (prompt_type)
 WHERE is_active AND prompt_type <> 'segment';

-- ---------------------------------------------------------------- VERIFICATION
DO $$
DECLARE
  v_ins   int;
  v_other int;
  v_idx   int;
BEGIN
  SELECT count(*) INTO v_ins
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'prompts' AND cmd = 'INSERT';
  IF v_ins <> 0 THEN
    RAISE EXCEPTION '125 VERIFY: % INSERT policy/policies still on public.prompts', v_ins;
  END IF;

  -- The SELECT policies are deliberately untouched; assert they are still there so this file is
  -- never mistaken for a wider lockdown than it is.
  SELECT count(*) INTO v_other
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'prompts' AND cmd = 'SELECT';
  IF v_other <> 2 THEN
    RAISE EXCEPTION '125 VERIFY: expected the 2 SELECT policies to survive, found %', v_other;
  END IF;

  SELECT count(*) INTO v_idx
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'prompts'
     AND indexname = 'prompts_one_active_per_type';
  IF v_idx <> 1 THEN
    RAISE EXCEPTION '125 VERIFY: prompts_one_active_per_type is missing';
  END IF;

  RAISE NOTICE '125 VERIFY OK: no INSERT policy on prompts, 2 SELECT policies untouched, unique index in place';
END $$;

COMMIT;
