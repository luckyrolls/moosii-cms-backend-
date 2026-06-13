-- ============================================================================
-- Migration 006: parallel MLP comparison table (rebuild_mlp verification phase)
-- ============================================================================
-- Clones columns, types, defaults, constraints, and indexes from user_mlp so
-- the new rebuild_mlp job can write here and be diffed against the live
-- user_mlp output before cutover.
--
-- NOTE: LIKE ... INCLUDING ALL does NOT copy RLS policies. That's fine —
-- user_mlp_v2 is an admin/service-role-only comparison table.
--
-- CUTOVER (later, one-line change elsewhere): once the v2 output is verified
-- against live user_mlp, point the rebuild flow back at user_mlp and drop this
-- table:  DROP TABLE IF EXISTS user_mlp_v2;
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_mlp_v2 (LIKE user_mlp INCLUDING ALL);
