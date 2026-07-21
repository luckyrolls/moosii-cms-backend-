-- ============================================================================
-- Migration 0007: coverage_audit empty-band delta (prompt-track migration)
-- ============================================================================
-- One targeted edit to the coverage_audit prompt row's system_message, COVERAGE MAP
-- section: make a structurally-empty age band an un-missable gap. Live finding (Sleep
-- pilot: 4 lessons all at 0-1, audited at span 0-3): months 1-3 held ZERO lessons -- a
-- two-thirds-of-span void -- yet coverage_read named only two narrow thin_areas and never
-- called out the empty band, and proposals were sparse (2 vs ~12 genuine topics). never-pad
-- (delta 4) was suppressing a LEGITIMATE finding. This adds two sentences that force empty
-- bands to be named + filled, WITHOUT weakening never-pad (which still governs redundant
-- proposals only).
--
-- Byte-discipline: implemented as replace() of a SINGLE-LINE anchor substring (the anchor
-- contains no newline), so NOTHING outside the matched anchor can move -- the replace cannot
-- touch any other byte of system_message regardless of its line endings. The only bytes
-- introduced are the two new sentences (CRLF-wrapped to match the surrounding prose). No
-- schema / handler / contract change; thin_areas shape is unchanged ("all" in area was
-- already legal).
--
-- Idempotent: guarded on the inserted marker phrase, so re-running is a no-op.
-- APPLY VIA THE SUPABASE SQL EDITOR -- on the 008..043 reconciliation list (0001..0007
-- prompt track). CRLF-pinned via .gitattributes, like 0006.
-- ============================================================================

begin;

update prompts
set system_message = replace(
  system_message,
  $anchor$on what is thin there. Both fields are always required: when a$anchor$,
  $repl$on what is thin there. An age band within the audited
span that contains NO lessons at all is always a major gap: name it
explicitly in thin_areas (e.g. area "all", age_band "1–3 months") and
propose the coverage that band genuinely needs. Never-pad governs
redundant proposals — it does not license under-reporting an empty
band. Both fields are always required: when a$repl$
)
where prompt_type = 'coverage_audit'
  and position('is always a major gap' in system_message) = 0;

commit;
