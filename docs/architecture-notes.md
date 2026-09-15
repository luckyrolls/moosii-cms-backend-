# Architecture notes (moved out of CLAUDE.md, 2026-09-15)

Detail that used to live in `CLAUDE.md`. CLAUDE.md keeps the architecture, the invariants and
the conventions; this file keeps the per-column rationale, the content-phase roadmap and parked
work. Nothing here is a contract — `docs/api-contract.md` is canonical for delivered behaviour.

## Data model detail

- `sub_segments.image_path` (migration 004): deliberate redundant convenience mirror of the
  approved image's storage_path, written on approval alongside `sub_segments.image`. Canonical
  source is `content_images.storage_path`; this column exists for easy access in the Supabase UI
  during build and is safe to remove later.
- `sub_segments.tone_id` (migration 030): the tone (`prompts.id`) each card was last written in —
  PER CARD (single-card regen can retone one card without relabeling its siblings). Nullable = not
  recorded; NEVER backfilled. Stamped by generate/regen and the batch. The CMS reads it for the
  per-card tone badge.
- `content_images.scene` (migration 031): the SCENE each image depicts (WHAT, not the STYLE) — the
  `userPrompt` sent to the prompt-writer LLM. Image gen is ONE fused LLM call: STYLE (base+overlay)
  is the model's instructions, the scene is its userPrompt. A human may OPTIONALLY supply the scene
  on generate/regen (image regen = re-fire `generate_sub_segment_image`); non-empty → used verbatim,
  skips deriving from card content; empty/absent → derived exactly as before. Stamped on every new
  row via the shared core (single + `generate_track_images` batch). NULL = whole prompt
  hand-supplied (`prompt_override`, LLM skipped) or pre-migration; NEVER backfilled. `image_prompt`
  stays the full rendered prompt. Pass 1: no scene REUSE on regen (empty always re-derives).
- `questionnaire_response.repeat_after_days` (migration 033): PER SCORE-BAND recurrence interval
  (days). Questionnaires are normally one-shot (any `completed_items` row excludes them from the MLP
  forever). When a band has a non-null interval, the rebuild (`rebuildOneUser`) turns that exclusion
  into a "not yet DUE" check: it takes the LATEST `completed_items` row per (user, questionnaire),
  finds the band(s) whose score range contains that row's `score` with a non-null interval
  (SHORTEST wins), and RE-INCLUDES the questionnaire once `now - created_at >= interval`. Null
  score / no matching band / NULL interval → one-shot (byte-identical to pre-033). Independent of
  `add`. Suppression stays a separate sibling filter (a due-again questionnaire whose milestone fact
  exists is still excluded — no coupling). Derived fresh each rebuild, no state table; re-surfaces
  only when a recompute runs. Per-user routing itself is DERIVED too:
  `questionnaire_responses_tracks` is a VIEW (`completed_items ⨝ questionnaire_response`,
  score-in-band) — nothing external writes routing; writing the ANSWER is what routes.
- Image storage / regen purge: `sub_segments.image` is an FK to `image_assets.url`, and
  `image_assets` is populated by an OUT-OF-BACKEND storage trigger (no `src` code writes it —
  auto-INSERT on upload, auto-DELETE on remove). Content regen PURGES the regenerated cards' images
  (content_images rows + storage files + image_assets rows) via `src/storage/purgeImages.ts`, so no
  orphaned-file bloat. The order trap is CLAUDE.md invariant 5.
- Content prompt composition (Level 1.5): `prompts` extended with system_message, scope,
  output_schema, model/temperature/max_tokens and FKs tone_block_id / structure_block_id /
  length_block_id / size_profile_id / card_positions_block_id; `prompt_blocks` (block_type
  tone|structure|length|card_positions) + `prompt_block_versions`; `content_size_profiles`
  (structured size); `voice_lint_rules` (AI-tell detection). `lessons` gained `band_rationale` +
  `safety_sensitive`.

## Image prompt history

Images regressed from "too busy" to "too sterile" (icon-on-white-background) because rules for
minimalism/single-focal-object/negative-space compounded. The fix direction is "depict a real
moment with people, restraint within a scene, no iconography." This is empirical tuning work, best
done inside the CMS. Overlays are written/tuned in response to observed failure modes, not all
guessed upfront.

## Content-phase roadmap (not built)

### Content generation is a BUNDLE
Generating a lesson also generates its QUIZ in the same act: lesson text (sub-segment snippets)
plus questions, each with answer options and a per-answer RESPONSE. One quiz per lesson under the
1:1 lesson:segment model. The candidate/approve lifecycle must cover the whole bundle. A
`content_drafts` table (NOT yet designed or built) would mirror `content_images`
(candidate/approved/superseded, prompts + model provenance, approval metadata) and hold the draft
bundle until a human approves it.

### generate → critique → revise (chained job)
1. GENERATE a draft with one model from a tight, structured prompt (persona + hard voice constraints).
2. CRITIQUE with a DIFFERENT model (cross-model: each model is blind to its own tells), playing an
   adversarial "skeptical reader who spots AI instantly", producing specific edits.
3. REVISE per critique.
4. Human voice + accuracy pass (~60s), then approve.
Add the critique pass only after proving a single strong-prompt generation isn't enough; measure
(blind-rank processed vs. raw) first. Over-chaining can homogenize output to "smooth" rather than
human. Jobs stay whole-unit: if retry cost ever becomes painful, that is the signal to consider a
durable workflow tool like Trigger.dev — not before.

### Making AI content feel human
Moosii's audience (tired, emotionally raw new parents) and the anti-AI-content backlash make this a
trust issue. Prompt moves: specific persona with opinions; one idea per snippet; short/varied
sentences, fragments OK; ban throat-clearing openers and hedging ("It's important to," "Many
parents find," "At the end of the day"); direct claims; concrete/sensory anchors; ~7th-grade
conversational voice. The detailed generation + critique prompts live in a separate May 29 chat —
the starting point when this phase starts.

### Risk stratification
Medical, safety-critical and emotionally loaded topics (SIDS, allergic reactions,
when-to-call-doctor, car seats, choking, PPD/PPA, infant loss) need a HIGHER bar: human-written
first with AI for polish only, plus credentialed human review. AI critique catches VOICE, never
factual accuracy. Likely a `risk_tier` on content jobs that routes handling.

### Disclosure / trust (product decision)
Leaning toward disclosing AI-assisted drafting + human review, ideally with named credentialed
reviewers ("Reviewed by [name], RN, IBCLC"). Shapes what metadata content rows may need to carry
(reviewer identity, review status).

## Working heuristic: fresh-user landmines

Several bugs were paths only an aged, privileged account exercised; assume a brand-new user hits a
different path. Examples: migration 034 (NULL questionnaire priority sorted recruiters to the
bottom); the age gate was unwired until migration 041. (Was CLAUDE.md invariant 5; moved here
2026-09-15 because it is a testing heuristic, not a cross-boundary rule.)

## Parked: multi-age MLP weighting (since 2026-07-25)

For a household with children of DIFFERENT ages, tilt the plan toward the YOUNGER child's lessons.
This is the whole reason `tracks.track_type='Age'` exists (its ONLY functional use:
`generateFullMLP` scales an `Age` track's weight by the active age brackets; newborn 4 /
infant·toddler 2 / older 1). The mechanism is BUILT but DORMANT: the recompute feeds only the
youngest child's age (`rebuildMlp.ts` computeUserMlp: `ages: [ageMonthsUsed]`), so multiple brackets
never activate; and the pool age FILTER also keys off youngest only (`isAgeEligible(youngestAgeMonths,
…)`), so an OLDER child's age-specific lessons are dropped entirely. Difficulty is LOW (~half a day
incl. proof): load ALL child ages in `loadUserMlpInputs`; pass them to `ages`; change the pool filter
to "ANY child overlaps"; thread all-ages into `questionnaireStatus.ts`; decide the preview
`ageMonthsOverride` semantics. Real work is DECISIONS: (a) any-child filter → bigger MLPs incl.
older-targeted content; (b) the tilt magnitude needs eyeballing real mixed-age output — only
meaningful once real content exists. Touches the frozen MLP (CLAUDE.md invariant 1). `track_type` is
otherwise vestigial (free-text, ~15 inconsistent values; `'milestone'` drives only a CMS badge).
