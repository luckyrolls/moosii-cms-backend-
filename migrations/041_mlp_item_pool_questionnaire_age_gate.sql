-- ============================================================================
-- Migration 041: mlp_item_pool — wire the questionnaire age gate into the pool
-- ============================================================================
-- FIRST IN-REPO RECORD of the `mlp_item_pool` VIEW. This view predates the repo (created
-- via the Supabase SQL editor / BuildShip era) and never had a migration file; this
-- migration captures its FULL definition, so the repo now owns it. The body below is
-- reconstructed verbatim from live `pg_get_viewdef('public.mlp_item_pool', true)`, with
-- exactly ONE change (marked inline).
--
-- WHY. The questionnaire age gate — `questionnaire.age`, a single LOWER bound in months
-- ("eligible once the youngest child reaches this age") written by the CMS form — was
-- never read by MLP selection. This view emitted NULL/NULL age bounds for questionnaire
-- rows, and generateFullMLP's age-overlap filter treats NULL as open-ended, so every
-- questionnaire always passed. The wire from form field to pool filter was never connected.
--
-- CHANGE (questionnaire arm ONLY): `NULL::integer AS min_child_age` becomes
-- `q.age AS min_child_age`. `max_child_age` stays NULL (single lower bound, no upper).
-- The lesson arm and every other column are byte-identical. The age FILTER is unchanged
-- (generateFullMLP): it now simply receives a real lower bound for questionnaires
-- (minOk = youngest >= age; maxOk = NULL -> true).
--
-- BEHAVIOR CHANGE: published questionnaires with a non-null `age` now gate — they drop
-- from the MLP of any user whose youngest child is younger than that age. Blast radius
-- reviewed + approved (live ages 0/0/1/3, all benign/desirable). `age IS NULL`
-- questionnaires are unaffected (open gate).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..041 reconciliation list.
-- ============================================================================

begin;

create or replace view public.mlp_item_pool as
 select l.id as item_id,
    'lesson'::text as item_type,
    l.track_id,
    l.priority,
    l.lesson_name as item_name,
    l.description as item_description,
    l.min_child_age,
    l.max_child_age,
    l.is_published,
    l.with_quiz
   from lessons l
union all
 select q.id as item_id,
    'questionnaire'::text as item_type,
    q.track_id,
    q.priority,
    q.questionnaire_name as item_name,
    q.description as item_description,
    q.age as min_child_age,          -- CHANGED (041): was NULL::integer — wire the age gate
    null::integer as max_child_age,
    q.is_published,
    q.with_quiz
   from questionnaire q;

commit;
