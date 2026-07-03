-- ============================================================================
-- Migration 019: classify enrich-apply (slice 2) — milestones, activations, apply fn
-- ============================================================================
-- PENDING CONFIRMATION: activation writes user_tracks (the per-user membership base
-- table that the user_active_tracks VIEW unions as active). Confirm via
-- pg_get_viewdef('user_active_tracks') that active user_tracks rows surface in the
-- view before applying — user_active_tracks is a VIEW (can't be inserted/constrained
-- directly); the earlier "insert the view" premise was wrong.
--
-- Slice 2 of §2j: POST /classify-update with apply=true activates proposed tracks
-- and records milestone facts, atomically. Adds:
--   milestones             — canonical taxonomy, NOT derived from tracks.
--   child_milestones       — per-child REACHED facts, first-reach-wins.
--   user_track_activations — RICH classify provenance (event ref + confidence);
--                            user_tracks.source is the coarse membership source.
--   UNIQUE(user_id,track_id) on user_tracks (base table, currently empty → safe).
--   apply_classification()  — atomic: user_tracks add + provenance + milestone facts.
--
-- PROVENANCE SCOPE — user_track_activations is CLASSIFY-ONLY for now; other writers
--   (questionnaire/demographic/manual) still live in app/BuildShip. Not complete
--   activation history yet.
--
-- RLS SWEEP: milestones + child_milestones are child-health-adjacent — RLS ENABLED
--   here; child-scoped policies set by the developer (pre-launch gate).
--   user_track_activations is backend-only; no RLS.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — on the 008..019 reconciliation list.
-- Regenerate database.types.ts after applying.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS milestones (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  label      text,
  created_at timestamptz not null default now()
);

INSERT INTO milestones (name, label) VALUES
  ('rolling',                'Rolling over'),
  ('sitting',                'Sitting up'),
  ('crawling',               'Crawling'),
  ('pulling_up',             'Pulling up to stand'),
  ('walking',                'Walking'),
  ('babbling',               'Babbling'),
  ('first_words',            'First words'),
  ('solids',                 'Starting solids'),
  ('teething',               'Teething'),
  ('separation_anxiety',     'Separation anxiety'),
  ('sleeping_through_night', 'Sleeping through the night')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS child_milestones (
  id                uuid primary key default gen_random_uuid(),
  child_id          uuid not null,
  milestone_id      uuid not null references milestones(id),
  first_reported_at timestamptz not null default now(),
  source            text not null,   -- 'classify' | 'questionnaire' | 'manual'
  source_ref        text,
  confidence        numeric,
  created_at        timestamptz not null default now(),
  UNIQUE (child_id, milestone_id)
);

CREATE TABLE IF NOT EXISTS user_track_activations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  track_id   uuid not null,
  source     text not null,   -- classify-only for now
  source_ref text,
  confidence numeric,
  created_at timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS idx_uta_user ON user_track_activations (user_id);

-- Idempotency guard on the membership BASE table (user_tracks, currently empty).
ALTER TABLE user_tracks
  ADD CONSTRAINT user_tracks_user_track_uniq UNIQUE (user_id, track_id);

ALTER TABLE milestones       ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_milestones ENABLE ROW LEVEL SECURITY;

-- Atomic apply: add membership to user_tracks (skip if already present), write rich
-- provenance ONLY for newly-added tracks, and record milestone facts (independent of
-- activation).
CREATE OR REPLACE FUNCTION apply_classification(
  p_user_id    uuid,
  p_child_id   uuid,
  p_event_id   uuid,
  p_proposals  jsonb,   -- [{ "track_id", "confidence", "source_signal" }, ...]
  p_milestones jsonb    -- [{ "milestone_id", "confidence" }, ...]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_activated jsonb;
  v_ms_count  integer;
BEGIN
  WITH ins AS (
    INSERT INTO user_tracks (user_id, track_id, source, active, added_at)
    SELECT p_user_id, (e->>'track_id')::uuid, 'classify', true, now()
    FROM jsonb_array_elements(p_proposals) e
    ON CONFLICT (user_id, track_id) DO NOTHING
    RETURNING track_id
  ),
  prov AS (
    INSERT INTO user_track_activations (user_id, track_id, source, source_ref, confidence)
    SELECT p_user_id, ins.track_id, 'classify', p_event_id::text, (e->>'confidence')::numeric
    FROM ins
    JOIN jsonb_array_elements(p_proposals) e ON (e->>'track_id')::uuid = ins.track_id
    RETURNING track_id
  )
  SELECT COALESCE(jsonb_agg(track_id), '[]'::jsonb) INTO v_activated FROM prov;

  WITH m AS (
    INSERT INTO child_milestones (child_id, milestone_id, source, source_ref, confidence)
    SELECT p_child_id, (e->>'milestone_id')::uuid, 'classify', p_event_id::text,
           NULLIF(e->>'confidence','')::numeric
    FROM jsonb_array_elements(p_milestones) e
    ON CONFLICT (child_id, milestone_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_ms_count FROM m;

  RETURN jsonb_build_object('activated_track_ids', v_activated, 'milestones_recorded', v_ms_count);
END $$;

COMMIT;
