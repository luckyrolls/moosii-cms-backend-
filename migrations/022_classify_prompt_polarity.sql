-- ============================================================================
-- Migration 022: classify_update prompt — polarity handling in the proposal step
-- ============================================================================
-- Console preview caught a real miss: "Sophie is not crawling yet :(" extracted
-- the concern signal correctly (confidence 0.9) but then proposed "Baby Is
-- Crawling" (80%) — the track whose description opens "Baby has started crawling."
-- Negation lost to keyword overlap. This adds an explicit POLARITY rule to the
-- PROPOSALS step: a track for a REACHED state must never be proposed from an
-- update stating the state is NOT reached. A not-yet/absent milestone is a genuine
-- signal with NO destination track (a deliberately unserved class — screening
-- boundary, clinical territory), so the correct output is zero proposals, exactly
-- like "slept through the night" (signal, no matching track).
--
-- Fix is at the PROMPT level with negative examples — the phrase lists are NOT
-- weakened. Everything else in the 018 body is byte-for-byte unchanged.
--
-- Verify after apply: "not crawling yet" -> relevant:true, concern signal, ZERO
-- proposals; "she started crawling this week" -> proposal still fires (fix must
-- not dull genuine matches).
--
-- APPLY VIA THE SUPABASE SQL EDITOR / PostgREST — on the 008..022 reconciliation list.
-- ============================================================================

BEGIN;

UPDATE prompts
SET updated_at = now(),
    system_message = $sys$You read a parent's free-form update about their child and answer TWO SEPARATE
questions against a catalog of Moosii support TRACKS:
  (1) Does the update contain a concrete SIGNAL — a milestone, concern, or clear
      need the parent actually states?
  (2) If there is a signal, does any track's PURPOSE genuinely match it?
These are different questions. A real signal can exist with NO matching track —
when that happens you STILL report the signal (relevant: true) and simply make no
proposal. Detecting a signal and finding a track are independent; answer both
honestly. A confident signal with no matching track is valuable data (it tells us
which track to write next), so never suppress a genuine signal just because
nothing in the catalog fits.

WHAT relevant: false MEANS. It means there is NO concrete signal — weather, a
vent, a passing feeling, small talk, a photo caption. That is the CORRECT and
COMMON outcome; most updates are this. relevant: false is NOT for "there's a
signal but no track matched" — a clearly-stated milestone or concern IS a signal;
report it. Do NOT invent a signal to be helpful: a false signal is worse than a
missed weak one. When there is genuinely nothing concrete, return relevant: false.

SIGNALS — a concrete, specific thing the prose actually STATES. Report every
genuine one, whether or not a track matches. For each:
- type: short category (e.g. "milestone", "concern", "need")
- value: the specific thing (e.g. "crawling")
- confidence: 0..1, calibrated to how clearly the words state it; vague/inferred -> low
- evidence_span: the EXACT substring of the update that triggered it (verbatim)
relevant is true if and only if there is at least one genuine signal — regardless
of whether you propose any track.

PROPOSALS — SEPARATELY, for a signal whose meaning clearly matches a track's
PURPOSE (read its description), propose activating that track:
- track_id: the EXACT id from the catalog. NEVER invent an id.
- confidence: 0..1 that this track is the right enrichment for this signal
- source_signal: the signal value it came from
A loose thematic association is NOT enough — the description must genuinely fit.
If no track fits a signal, propose nothing for it; the signal still stands.

POLARITY — read the track's description for the STATE it serves, and honor the
update's polarity. A track for a REACHED state must NEVER be proposed from an
update that says the state is NOT reached. Negated / absent / not-yet phrasing
about a milestone is a genuine signal (report it — usually a concern), but it
matches NO reached-state track, so propose ZERO tracks for it. This is by design:
a milestone stated as not-yet-reached is a deliberately unserved class (a
screening boundary), not a coverage gap — treat it as signal-without-destination,
exactly like a milestone that has no matching track at all. Do NOT let keyword
overlap between the words and a track's name/phrases override the negation.
Examples (all -> concern/need signal, but ZERO proposals):
- "Sophie is not crawling yet" — the "Baby Is Crawling" track (description: "Baby
  has started crawling…") serves a child who HAS crawled; not-yet -> no proposal.
- "she hasn't rolled over", "still won't walk", "no words yet", "yet to sit up".
A track is proposed only when the update states the milestone IS reached (or a
concern the track's purpose positively serves).

CALIBRATION. Prefer fewer, higher-confidence outputs. If you cannot justify a
signal from the exact words, leave it out (and that may make the whole update
relevant: false). Proposals are held to a higher bar than signals.

Return ONLY the JSON object in the required shape. No preamble.$sys$
WHERE prompt_type = 'classify_update' AND is_active = true;

COMMIT;
