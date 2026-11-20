-- Row counts attributable to :uid (child-keyed tables use the FROZEN kid list :kids, so a
-- post-'full' count is comparable even though the children rows themselves are gone).
SELECT
  :'phase' AS phase,
  (SELECT count(*) FROM public.user_update_signals s
    WHERE s.event_id IN (SELECT e.id FROM public.user_update_events e
                          WHERE e.user_id = :'uid' OR e.child_id = ANY(:'kids'::uuid[])))  AS uu_signals,
  (SELECT count(*) FROM public.distress_detections WHERE user_id = :'uid' OR child_id = ANY(:'kids'::uuid[])) AS distress,
  (SELECT count(*) FROM public.health_detections   WHERE user_id = :'uid' OR child_id = ANY(:'kids'::uuid[])) AS health,
  (SELECT count(*) FROM public.user_update_events  WHERE user_id = :'uid' OR child_id = ANY(:'kids'::uuid[])) AS uu_events,
  (SELECT count(*) FROM public.child_milestones    WHERE child_id = ANY(:'kids'::uuid[]))  AS milestones,
  (SELECT count(*) FROM public.moosie_awards               WHERE user_id = :'uid') AS moosie_awards,
  (SELECT count(*) FROM public.completed_items             WHERE user_id = :'uid') AS completed_items,
  (SELECT count(*) FROM public.user_lesson_progress        WHERE user_id = :'uid') AS lesson_progress,
  (SELECT count(*) FROM public.user_segement_track         WHERE user_id = :'uid') AS segement_track,
  (SELECT count(*) FROM public.starred_items               WHERE "user id" = :'uid') AS starred,
  (SELECT count(*) FROM public.user_activity_followups     WHERE user_id = :'uid') AS followups,
  (SELECT count(*) FROM public.user_questionnaire_progress WHERE user_id = :'uid') AS q_progress,
  (SELECT count(*) FROM public.questionnaire_user_answers  WHERE user_id = :'uid') AS q_answers,
  (SELECT count(*) FROM public.user_mlp                    WHERE user_id = :'uid') AS user_mlp,
  (SELECT count(*) FROM public.user_mlp_v2                 WHERE user_id = :'uid') AS user_mlp_v2,
  (SELECT count(*) FROM public.user_mlp_bs_backup          WHERE user_id = :'uid') AS user_mlp_bs,
  (SELECT count(*) FROM public.user_mlp_mods               WHERE user_id = :'uid') AS mlp_mods,
  (SELECT count(*) FROM public.user_track_activations      WHERE user_id = :'uid') AS activations,
  (SELECT count(*) FROM public.user_template_history       WHERE user_id = :'uid') AS tmpl_history,
  (SELECT count(*) FROM public.notifications               WHERE user_id = :'uid') AS notifications,
  (SELECT count(*) FROM public.notification_log            WHERE user_id = :'uid') AS notification_log,
  (SELECT count(*) FROM public.user_tag                    WHERE user_id = :'uid') AS user_tag,
  (SELECT count(*) FROM public.user_demographic_responses  WHERE user_id = :'uid') AS demographics,
  (SELECT count(*) FROM public.user_configurations         WHERE user_id = :'uid') AS configurations,
  (SELECT count(*) FROM public.user_settings               WHERE user_id = :'uid') AS settings,
  (SELECT count(*) FROM public.user_tracks                 WHERE user_id = :'uid') AS user_tracks,
  (SELECT count(*) FROM public.user_track_weights          WHERE user_id = :'uid') AS track_weights,
  (SELECT count(*) FROM public.children                    WHERE parent_id = :'uid') AS children,
  (SELECT count(*) FROM public.user_facts WHERE user_id = :'uid' AND source IN ('derived','manual'))          AS facts_activity,
  (SELECT count(*) FROM public.user_facts WHERE user_id = :'uid' AND source IN ('platform_api','estimated'))  AS facts_full,
  (SELECT count(*) FROM public.user_facts WHERE user_id = :'uid' AND source = 'seed')                         AS facts_seed,
  (SELECT count(*) FROM public.user_facts WHERE user_id = :'uid')                                             AS facts_total,
  (SELECT count(*) FROM public.test_account_events WHERE user_id = :'uid') AS audit_rows;

-- The user row: the columns 'full' resets, then the NEVER-TOUCHED ones.
SELECT
  :'phase' AS phase,
  moosies, onboarding_complete AS onb, has_seen_mlp_intro AS mlp_intro,
  has_seen_lesson_intro AS lesson_intro, has_seen_questionnaire_intro AS quest_intro,
  birth_date, (name = '') AS name_is_default, display_name, gender, birth_month, birth_year,
  parenting_status, financials, image_url, image_blur_hash, phone, region
 FROM public."user" WHERE id = :'uid';

SELECT
  :'phase' AS phase,
  role, can_publish, can_review_editorial, can_approve_clinical, is_test_account,
  (email IS NOT NULL) AS has_email, is_verified, auth_provider, daily_reminder_time,
  user_offset, (fcm_token IS NOT NULL) AS has_fcm, created_at,
  allow_daily_reminders_notifications AS allow_daily, likes_push_notifications AS likes_push
 FROM public."user" WHERE id = :'uid';
