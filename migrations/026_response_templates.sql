-- ============================================================================
-- Migration 026: response_templates (parent-facing acks) + admin-write policies
-- ============================================================================
-- Authored acknowledgment templates — NEVER generated. MULTIPLE VARIANTS per key
-- (key is NOT unique): the backend picks one at random at response-assembly time
-- (slice 4) so acks don't repeat. `description` documents purpose + allowed
-- {placeholders} for the CMS and is identical across a key's variants.
--
-- ADMIN-WRITE POLICY — note the correction: the task said "users_internal-gated",
-- but users_internal is EMPTY and jwtAuth.ts intentionally does NOT use it. The real
-- admin gate is is_admin() (the existing RLS function, backed by user.role in
-- 'admin'|'super_admin'). Writes are gated on is_admin(); reads are open to any
-- authenticated user (reference content the app + CMS both read). Applied here to
-- response_templates AND (retro) distress_responses, which had read-only.
--
-- Copy is AUTHORED + reviewed (same gate as the distress seed). Flag: regenerate
-- database.types.ts after apply (response_templates).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..026 reconciliation list.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS response_templates (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,       -- NOT unique: one row per variant, several share a key
  template    text not null,       -- ack copy with {placeholders}
  description text,                 -- purpose + allowed placeholders (CMS); same across a key
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Selection reads active variants for a key.
CREATE INDEX IF NOT EXISTS response_templates_key_active_idx ON response_templates (key) WHERE is_active;

-- NOTE ON VOICE: neutral app voice — NO first-person "I" companion persona (that
-- is an unmade product decision; see docs/provisional-clinical-decisions.md D12).
-- {milestone_name} renders milestones.LABEL (e.g. "Crawling"), never the taxonomy
-- name — a user must never see "sleeping_through_night". Celebratory tone is safe
-- ONLY because the milestone taxonomy is reached-only (a recorded milestone always
-- happened).
INSERT INTO response_templates (key, template, description) VALUES
-- track_added — exactly ONE track activated. Placeholders: {track_name}
('track_added', $t$Got it — {track_name} has been added to your plan.$t$,                 $d$Ack when ONE track was added to the plan. Placeholders: {track_name}.$d$),
('track_added', $t$Nice — {track_name} is now part of your plan.$t$,                      $d$Ack when ONE track was added to the plan. Placeholders: {track_name}.$d$),
('track_added', $t$Done. {track_name} is in your plan now.$t$,                            $d$Ack when ONE track was added to the plan. Placeholders: {track_name}.$d$),

-- track_added_plural — TWO OR MORE tracks. Placeholders: {track_names} (comma list)
('track_added_plural', $t$Done — these have been added to your plan: {track_names}.$t$,   $d$Ack when TWO OR MORE tracks were added. Placeholders: {track_names} (comma-separated list).$d$),
('track_added_plural', $t$A few new things are in your plan: {track_names}.$t$,           $d$Ack when TWO OR MORE tracks were added. Placeholders: {track_names} (comma-separated list).$d$),
('track_added_plural', $t$Added to your plan: {track_names}.$t$,                          $d$Ack when TWO OR MORE tracks were added. Placeholders: {track_names} (comma-separated list).$d$),

-- milestone_recorded — a milestone recorded AND a track added. Placeholders: {milestone_name}, {track_name}
('milestone_recorded', $t$Love that — {milestone_name}! {track_name} has been added to match.$t$, $d$Ack when a milestone was recorded AND a track added as a result. Placeholders: {milestone_name} (renders milestones.label, never the taxonomy name), {track_name}. Celebratory tone is safe only because the taxonomy is reached-only.$d$),
('milestone_recorded', $t${milestone_name} — what a moment. {track_name} is in your plan now.$t$, $d$Ack when a milestone was recorded AND a track added as a result. Placeholders: {milestone_name} (renders milestones.label, never the taxonomy name), {track_name}. Celebratory tone is safe only because the taxonomy is reached-only.$d$),
('milestone_recorded', $t$Noted: {milestone_name}. {track_name} has been added to help.$t$,       $d$Ack when a milestone was recorded AND a track added as a result. Placeholders: {milestone_name} (renders milestones.label, never the taxonomy name), {track_name}. Celebratory tone is safe only because the taxonomy is reached-only.$d$),

-- milestone_only — a milestone recorded, NO track added. Placeholders: {milestone_name}
('milestone_only', $t${milestone_name} — that's a big one. Noted.$t$,                     $d$Ack when a milestone was recorded but NO track was added. Placeholders: {milestone_name} (renders milestones.label, never the taxonomy name). Celebratory tone is safe only because the taxonomy is reached-only.$d$),
('milestone_only', $t$Got it — {milestone_name}, noted.$t$,                               $d$Ack when a milestone was recorded but NO track was added. Placeholders: {milestone_name} (renders milestones.label, never the taxonomy name). Celebratory tone is safe only because the taxonomy is reached-only.$d$),
('milestone_only', $t$Love it — {milestone_name} is noted.$t$,                            $d$Ack when a milestone was recorded but NO track was added. Placeholders: {milestone_name} (renders milestones.label, never the taxonomy name). Celebratory tone is safe only because the taxonomy is reached-only.$d$),

-- nothing_matched — received, nothing added/recorded. Warm receipt only, no future
-- tense (must not claim ongoing attention/memory this path doesn't deliver). No placeholders.
('nothing_matched', $t$Thanks for sharing.$t$,                                            $d$Ack when the update was received but nothing was added or recorded. No placeholders. Warm receipt only — no claim of ongoing attention/memory.$d$),
('nothing_matched', $t$Got it — thanks for the update.$t$,                                $d$Ack when the update was received but nothing was added or recorded. No placeholders. Warm receipt only — no claim of ongoing attention/memory.$d$),
('nothing_matched', $t$Noted — thanks for keeping us posted.$t$,                          $d$Ack when the update was received but nothing was added or recorded. No placeholders. Warm receipt only — no claim of ongoing attention/memory.$d$);

-- RLS: authenticated READ; is_admin() WRITE (INSERT/UPDATE/DELETE). The read policy
-- is permissive; permissive policies OR, so SELECT is open while writes require admin.
ALTER TABLE response_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS response_templates_authenticated_read ON response_templates;
CREATE POLICY response_templates_authenticated_read
  ON response_templates FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS response_templates_admin_write ON response_templates;
CREATE POLICY response_templates_admin_write
  ON response_templates FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- distress_responses had authenticated-read only (migration 025). Add the same
-- admin-write so CMS editors can edit the provisional copy (not a blanket UPDATE).
DROP POLICY IF EXISTS distress_responses_admin_write ON distress_responses;
CREATE POLICY distress_responses_admin_write
  ON distress_responses FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

COMMIT;
