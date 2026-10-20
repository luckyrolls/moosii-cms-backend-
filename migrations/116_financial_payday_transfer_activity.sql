-- ============================================================================
-- MIGRATION 116: "Put Your Buffer on Autopilot" becomes Sarah's verifiable activity — *** FINANCIAL ONLY ***
--   (data: one existing lesson) — DRAFT (pending apply)
-- ============================================================================
-- WHY (Mark 2026-10-23): the same pattern as "Set a Statement-Date Reminder" (114), for Sarah's Building a Buffer
-- track. Rather than add a new lesson, convert the existing unpublished "Put Your Buffer on Autopilot" (e7fc45b6): it
-- covers the same ground and already sits right after "Why One Month Comes First" (6d4502d2, priority 100) in the
-- track. "I'll do it" comes back after 14 days; verified (done by data + the activity_verified bonus) when
-- has_emergency_buffer becomes 'true', observed after the commitment (migration 113).
--
-- WHAT (lesson e7fc45b6-1c6d-4b8c-b55e-844a9a88cbaa; title, track, priority 200, topic and publish state unchanged):
--   kind = 'activity'; followup_after_days = 14; verify_fact_key = 'has_emergency_buffer'; verify_fact_value = 'true'
--   (the stored vocabulary token — fact_values; user_facts rows store 'true' / 'false' as text);
--   description = "Move a small amount to savings automatically each payday, so your buffer grows without you having to
--   remember."
--   The description is a content column: the 064 financial edit guard allows it only because the lesson is unpublished
--   (checked below), and the 066 trigger may reset its review state — moot, the segment has no cards yet.
-- Guards (refuse on any): domain ≠ financial; e7fc45b6 missing, published, archived, not in Building a Buffer
-- (f0840000-…-0004), or not titled "Put Your Buffer on Autopilot"; kind neither 'lesson' nor 'activity';
-- (has_emergency_buffer, true) not in the vocabulary; follow-up settings neither NULL nor already these values
-- (drift). Re-run = no-op.
-- Content and images are NOT here: regen_segment_content (whole_segment, structure override) and one
-- generate_sub_segment_image per card run as jobs afterwards, and stay unapproved; the lesson stays unpublished.
-- ============================================================================

-- PRE-CHECK (read-only). EXPECT financial; one row: lesson, priority 200, unpublished, NULL follow-up settings:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT lesson_name, kind, priority, is_published, archived_at, track_id, followup_after_days, verify_fact_key,
--          verify_fact_value, description FROM lessons WHERE id = 'e7fc45b6-1c6d-4b8c-b55e-844a9a88cbaa';

BEGIN;

DO $$
DECLARE
  v_domain text := (SELECT value FROM public.app_settings WHERE key = 'domain');
  l record;
BEGIN
  IF v_domain IS DISTINCT FROM 'financial' THEN RAISE EXCEPTION '116: FINANCIAL ONLY — app_settings.domain is %', v_domain; END IF;
  SELECT lesson_name, kind, is_published, archived_at, track_id, followup_after_days, verify_fact_key, verify_fact_value INTO l
    FROM public.lessons WHERE id = 'e7fc45b6-1c6d-4b8c-b55e-844a9a88cbaa';
  IF NOT FOUND THEN RAISE EXCEPTION '116: lesson e7fc45b6 not found'; END IF;
  IF l.track_id IS DISTINCT FROM 'f0840000-0000-4000-8000-000000000004' THEN
    RAISE EXCEPTION '116: lesson e7fc45b6 is not in Building a Buffer (track %)', l.track_id;
  END IF;
  IF l.lesson_name IS DISTINCT FROM 'Put Your Buffer on Autopilot' THEN
    RAISE EXCEPTION '116: lesson e7fc45b6 is titled "%", expected "Put Your Buffer on Autopilot"', l.lesson_name;
  END IF;
  IF l.is_published THEN RAISE EXCEPTION '116: lesson e7fc45b6 is published — refusing to convert it'; END IF;
  IF l.archived_at IS NOT NULL THEN RAISE EXCEPTION '116: lesson e7fc45b6 is archived'; END IF;
  IF l.kind NOT IN ('lesson', 'activity') THEN RAISE EXCEPTION '116: lesson e7fc45b6 has kind %', l.kind; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fact_values WHERE fact_key = 'has_emergency_buffer' AND value = 'true') THEN
    RAISE EXCEPTION '116: fact value (has_emergency_buffer, true) missing from the vocabulary';
  END IF;
  IF (l.followup_after_days IS NOT NULL AND l.followup_after_days <> 14)
     OR (l.verify_fact_key IS NOT NULL AND l.verify_fact_key <> 'has_emergency_buffer')
     OR (l.verify_fact_value IS NOT NULL AND l.verify_fact_value <> 'true') THEN
    RAISE EXCEPTION '116: lesson e7fc45b6 already has other follow-up settings (%, %, %) — re-base', l.followup_after_days, l.verify_fact_key, l.verify_fact_value;
  END IF;
END $$;

-- kind and the follow-up settings together (lessons_followup_only_activity), the description beside them.
UPDATE public.lessons
   SET kind = 'activity', followup_after_days = 14, verify_fact_key = 'has_emergency_buffer', verify_fact_value = 'true',
       description = 'Move a small amount to savings automatically each payday, so your buffer grows without you having to remember.'
 WHERE id = 'e7fc45b6-1c6d-4b8c-b55e-844a9a88cbaa'
   AND (kind IS DISTINCT FROM 'activity' OR followup_after_days IS DISTINCT FROM 14
        OR verify_fact_key IS DISTINCT FROM 'has_emergency_buffer' OR verify_fact_value IS DISTINCT FROM 'true'
        OR description IS DISTINCT FROM 'Move a small amount to savings automatically each payday, so your buffer grows without you having to remember.');

COMMIT;

-- VERIFICATION: e7fc45b6 reads (activity, 14, has_emergency_buffer, true, the new description); title, track_id,
-- priority 200, topic_id and is_published (false) unchanged; no other lesson changed.
