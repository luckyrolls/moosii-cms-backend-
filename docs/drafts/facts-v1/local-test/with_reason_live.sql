-- user_active_tracks_with_reason as it exists LIVE (pg_get_viewdef on Moosii, 2026-09-14; identical
-- on financial, md5 8393d8efcc135d42d2ece9011797620f). Loaded after the 045 baseline so 074 has
-- the real object to replace.
\set ON_ERROR_STOP 1
CREATE VIEW public.user_active_tracks_with_reason AS
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
            ELSE NULL::text
        END AS reason_detail
   FROM user_active_tracks uat
     LEFT JOIN latest_user_mod lum ON lum.user_id = uat.user_id AND lum.track_id = uat.track_id
     LEFT JOIN latest_questionnaire_action lqa ON lqa.user_id = uat.user_id AND lqa.track_id = uat.track_id
     LEFT JOIN default_tracks dt ON dt.user_id = uat.user_id AND dt.track_id = uat.track_id
     LEFT JOIN demographic_rule dr ON dr.user_id = uat.user_id AND dr.track_id = uat.track_id
     LEFT JOIN questionnaire q ON q.id = lqa.questionnaire_id;
