-- ============================================================================
-- Migration 014 (main track): content_size_profiles — Phase 2 of tone management
-- ============================================================================
-- Structured, reusable SIZE config for segment content, decoupled from tone
-- (voice). A tone references one profile as its default via prompts.size_profile_id;
-- a regen can override it per run. At generation time the handler renders a
-- profile's numbers into the "## Length" instruction (replacing the prose length
-- block; the block stays as a fallback for any tone with no profile).
--
-- All numeric fields nullable — the renderer emits a line only for fields that are
-- set. Card COUNT stays in the structure block (arc), not here.
--
-- FK is ON DELETE SET NULL: deleting a profile makes its tones fall back to the
-- length block rather than orphaning/blocking.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in supabase_migrations.schema_
-- migrations; on the 008..014 reconciliation list. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS content_size_profiles (
  id                   uuid primary key default gen_random_uuid(),
  name                 text unique not null,   -- slug, e.g. 'standard'
  label                text,
  total_words_min      integer,
  total_words_max      integer,
  words_per_card_min   integer,
  words_per_card_max   integer,
  max_sentence_words   integer,
  max_bullet_words     integer,
  max_bullets_per_card integer,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Seed Short / Standard / Long (Standard mirrors the legacy standard_400 block).
INSERT INTO content_size_profiles
  (name, label, total_words_min, total_words_max, words_per_card_min, words_per_card_max,
   max_sentence_words, max_bullet_words, max_bullets_per_card)
VALUES
  ('short',    'Short',    200, 280, 35, 55, 17, 12, 3),
  ('standard', 'Standard', 350, 450, 45, 70, 19, 13, 4),
  ('long',     'Long',     550, 700, 60, 90, 22, 15, 5)
ON CONFLICT (name) DO NOTHING;

-- Per-tone default profile.
ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS size_profile_id uuid
    REFERENCES content_size_profiles(id) ON DELETE SET NULL;

-- Backfill: every segment tone defaults to 'standard'.
UPDATE prompts
SET    size_profile_id = (SELECT id FROM content_size_profiles WHERE name = 'standard'),
       updated_at = now()
WHERE  prompt_type = 'segment'
  AND  size_profile_id IS NULL;

COMMIT;
