-- ============================================================================
-- Migration 058: tracks.weight must be positive (DRAFT — pending apply)
-- ============================================================================
-- WHY. generateFullMLP (the FROZEN BuildShip port) builds its weighted round-robin from
-- tracks.weight: minWeight = min(adjusted weights); cycles = round(weight / minWeight).
-- A track with weight 0 makes minWeight 0, the cycle count NaN/Infinity, the weighted
-- sequence empty, and Phase 1 loops forever on the event loop — the whole Render
-- instance (including /health) stops answering. Reproduced in isolation
-- (FINDINGS-financial.md §A.7, risk 1). This makes the bad row impossible instead of
-- guarding the algorithm (which stays untouched).
--
-- NULL is folded to 1 by the reader (`t.weight ?? 1`, src/mlp/generateFullMLP.ts:138,
-- 184, 186; num() in rebuildMlp.ts:21-25), so a NULL never hangs — but SET NOT NULL
-- fails if any NULL row exists. The backfill below writes the value the code already
-- assumes, so behaviour is byte-identical; only the column's contract tightens.
--
-- PRE-CHECK (run first; both must be empty or the ALTER fails):
--   SELECT id, track_name, weight FROM tracks WHERE weight IS NULL;   -- backfilled below
--   SELECT id, track_name, weight FROM tracks WHERE weight <= 0;      -- DECIDE per row —
--     a 0/negative weight is the hang itself; set a real weight before applying. This
--     migration does NOT guess one.
--
-- NOT covered here (a separate decision): track_type = 'Age' with a NULL youngest age
-- hangs by the same mechanism (adjusted weight 0). See FINDINGS-financial.md risk 1.
--
-- After apply: regenerate database.types.ts (tracks.weight Row type becomes `number`);
-- no `(supabase as any)` bridge is involved and `?? 1` still compiles, so the regen is a
-- confirm, not a blocker.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..058 reconciliation list. Idempotent:
-- the backfill is a no-op once applied; DROP CONSTRAINT IF EXISTS makes a re-run safe.
-- ============================================================================

BEGIN;

-- Behaviour-preserving backfill: NULL already reads as 1 everywhere.
UPDATE tracks SET weight = 1 WHERE weight IS NULL;

-- tracks.weight must be positive (prevents NaN cycle count in generateFullMLP)
ALTER TABLE tracks
  ALTER COLUMN weight SET NOT NULL;

ALTER TABLE tracks
  DROP CONSTRAINT IF EXISTS tracks_weight_positive;
ALTER TABLE tracks
  ADD CONSTRAINT tracks_weight_positive CHECK (weight > 0);

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Expect: is_nullable = 'NO' and one CHECK row.
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_name = 'tracks' AND column_name = 'weight';
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'tracks'::regclass AND conname = 'tracks_weight_positive';
-- ============================================================================
