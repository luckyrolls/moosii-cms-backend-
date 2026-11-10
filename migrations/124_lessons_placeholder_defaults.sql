-- MIGRATION 124: drop the lessons placeholder DEFAULTs, null the placeholder values, and
--                refuse to publish a lesson that still carries one.
--
-- *** BOTH PROJECTS *** (the defaults and the data are identical on financial and moosii;
-- financial inherited them in the schema dump).
--
-- STATUS: DRAFT (pending apply). Do not apply without a go.
--
-- WHY
-- The financial reader shows a quiz intro captioned "New Quiz Onboarding Text" over an image
-- of the word QUESTIONNAIRE. Nobody typed either. They are column DEFAULTs on `lessons`:
--     quiz_onboarding_text  DEFAULT 'New Quiz Onboarding Text'
--     quiz_onboarding_image DEFAULT 'https://szhihepbqzbbmxybluql.supabase.co/storage/v1/
--                                    object/public/questionnaire_and_quiz/questionnaire.jpg'
--     abbreviated_title     DEFAULT 'Abbreviated Title defult'   (sic)
--     lesson_name           DEFAULT 'missing name'
--     description           DEFAULT 'missing description'
-- No writer anywhere sets the first three: `create_lessons_with_segments` inserts only the
-- handler-set columns ("every other column keeps its DB default"), and the backend never reads
-- or writes them. So EVERY lesson on both projects carries them -- 13/13 on financial,
-- 156/156 on moosii -- and a placeholder reaching a member is the default case, not an edge.
--
-- Three of these columns are NOT NULL, so today there is no way to say "nothing was authored".
-- This migration makes NULL that state, clears the placeholder values, and adds a CHECK so a
-- published lesson can never carry one again.
--
-- WHY A CHECK AND NOT A ROUTE GUARD
-- A guard inside set_lesson_published would be bypassed by a Supabase-direct UPDATE of
-- `is_published` (which is how publishing used to work, and how the CMS still writes other
-- lesson columns). A table CHECK binds every writer -- backend, CMS, SQL editor -- which is the
-- structural-safety preference of invariant 3. It is narrow on purpose: it rejects only these
-- literal placeholder strings, never "short" or "empty" text, and NULL is always allowed.
--
-- READER DEPENDENCY (flagged, not solved here)
-- After this, quiz_onboarding_text / quiz_onboarding_image / abbreviated_title are NULL on every
-- existing lesson and on every new one. The app (moosii-rn) must render "no intro" for NULL
-- rather than crashing or showing an empty frame. That is a change in the reader repo and this
-- migration should not be applied before that seat confirms it.

BEGIN;

-- ---------------------------------------------------------------- PRE-CHECK
DO $$
DECLARE
  v_domain text;
  v_ph_text int; v_ph_img int; v_ph_abbr int; v_ph_name int; v_ph_desc int;
  v_pub_affected int;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  RAISE NOTICE '124 PRE-CHECK: domain=% system=%', v_domain, (pg_control_system()).system_identifier;

  SELECT count(*) FILTER (WHERE quiz_onboarding_text  = 'New Quiz Onboarding Text'),
         count(*) FILTER (WHERE quiz_onboarding_image LIKE '%questionnaire_and_quiz/questionnaire.jpg'),
         count(*) FILTER (WHERE abbreviated_title     = 'Abbreviated Title defult'),
         count(*) FILTER (WHERE lesson_name           = 'missing name'),
         count(*) FILTER (WHERE description           = 'missing description'),
         count(*) FILTER (WHERE is_published AND archived_at IS NULL
                            AND (quiz_onboarding_text = 'New Quiz Onboarding Text'
                              OR quiz_onboarding_image LIKE '%questionnaire_and_quiz/questionnaire.jpg'
                              OR abbreviated_title = 'Abbreviated Title defult'
                              OR lesson_name = 'missing name'
                              OR description = 'missing description'))
    INTO v_ph_text, v_ph_img, v_ph_abbr, v_ph_name, v_ph_desc, v_pub_affected
    FROM public.lessons;

  RAISE NOTICE '124 PRE-CHECK: placeholders -- quiz_text % / quiz_image % / abbrev % / name % / description %',
    v_ph_text, v_ph_img, v_ph_abbr, v_ph_name, v_ph_desc;
  RAISE NOTICE '124 PRE-CHECK: published+unarchived lessons carrying at least one: %', v_pub_affected;

  -- lesson_name stays NOT NULL, so a row literally named 'missing name' cannot be cleared here.
  IF v_ph_name > 0 THEN
    RAISE EXCEPTION '124: % lesson(s) are named ''missing name'' -- give them real names first (this file will not invent one)', v_ph_name;
  END IF;
END $$;

-- ---------------------------------------------------------------- 1. the DEFAULTs go
ALTER TABLE public.lessons ALTER COLUMN quiz_onboarding_text  DROP DEFAULT;
ALTER TABLE public.lessons ALTER COLUMN quiz_onboarding_image DROP DEFAULT;
ALTER TABLE public.lessons ALTER COLUMN abbreviated_title     DROP DEFAULT;
ALTER TABLE public.lessons ALTER COLUMN lesson_name           DROP DEFAULT;
ALTER TABLE public.lessons ALTER COLUMN description           DROP DEFAULT;

-- ---------------------------------------------------------------- 2. "nothing authored" becomes expressible
-- lesson_name keeps NOT NULL: a lesson must have a name, and the create RPC always supplies one.
ALTER TABLE public.lessons ALTER COLUMN quiz_onboarding_text  DROP NOT NULL;
ALTER TABLE public.lessons ALTER COLUMN quiz_onboarding_image DROP NOT NULL;
ALTER TABLE public.lessons ALTER COLUMN abbreviated_title     DROP NOT NULL;

-- ---------------------------------------------------------------- 3. clear the values that were only ever defaults
UPDATE public.lessons SET quiz_onboarding_text = NULL
 WHERE quiz_onboarding_text = 'New Quiz Onboarding Text';

UPDATE public.lessons SET quiz_onboarding_image = NULL
 WHERE quiz_onboarding_image LIKE '%questionnaire_and_quiz/questionnaire.jpg';

UPDATE public.lessons SET abbreviated_title = NULL
 WHERE abbreviated_title = 'Abbreviated Title defult';

UPDATE public.lessons SET description = NULL
 WHERE description = 'missing description';

-- ---------------------------------------------------------------- 4. the guard
-- A lesson may be unpublished and still carry anything (drafts are a workspace). Publishing it
-- with a placeholder in a member-facing field is refused -- by every writer, not just the route.
ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_no_placeholder_when_published
  CHECK (
    NOT is_published
    OR (
          coalesce(quiz_onboarding_text, '')  <> 'New Quiz Onboarding Text'
      AND coalesce(abbreviated_title, '')     <> 'Abbreviated Title defult'
      AND coalesce(lesson_name, '')           <> 'missing name'
      AND coalesce(description, '')           <> 'missing description'
      AND coalesce(quiz_onboarding_image, '') NOT LIKE '%questionnaire_and_quiz/questionnaire.jpg'
    )
  );

-- ---------------------------------------------------------------- VERIFICATION
DO $$
DECLARE
  v_defaults int; v_left int; v_notnull int; v_check int;
BEGIN
  SELECT count(*) INTO v_defaults
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'lessons'
     AND column_name IN ('quiz_onboarding_text','quiz_onboarding_image','abbreviated_title','lesson_name','description')
     AND column_default IS NOT NULL;
  IF v_defaults <> 0 THEN RAISE EXCEPTION '124 VERIFY: % placeholder default(s) still set', v_defaults; END IF;

  SELECT count(*) INTO v_notnull
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'lessons'
     AND column_name IN ('quiz_onboarding_text','quiz_onboarding_image','abbreviated_title')
     AND is_nullable = 'NO';
  IF v_notnull <> 0 THEN RAISE EXCEPTION '124 VERIFY: % column(s) still NOT NULL', v_notnull; END IF;

  SELECT count(*) INTO v_left FROM public.lessons
   WHERE quiz_onboarding_text = 'New Quiz Onboarding Text'
      OR quiz_onboarding_image LIKE '%questionnaire_and_quiz/questionnaire.jpg'
      OR abbreviated_title = 'Abbreviated Title defult'
      OR lesson_name = 'missing name'
      OR description = 'missing description';
  IF v_left <> 0 THEN RAISE EXCEPTION '124 VERIFY: % lesson(s) still carry a placeholder', v_left; END IF;

  SELECT count(*) INTO v_check FROM pg_constraint
   WHERE conrelid = 'public.lessons'::regclass AND conname = 'lessons_no_placeholder_when_published';
  IF v_check <> 1 THEN RAISE EXCEPTION '124 VERIFY: the publish guard is missing'; END IF;

  RAISE NOTICE '124 VERIFY OK: defaults dropped, 3 columns nullable, 0 placeholders left, guard in place';
END $$;

COMMIT;
