# FINDINGS — financial image prompts: scene derivation, overlay, and amounts in cards

2026-09-28 · Investigate-first · no prompt or code changes. Financial DB read in read-only
transactions; files read at `05b85d8`+.

Lesson under test: **"Why Your Credit Balance-to-Limit Ratio Matters"** (`f9b2c834-…`), track
Credit Health, **topic `credit`**, unpublished; segment `de92c336-…` (`pending`). It has **six** cards,
not three. All six images were generated 2026-09-28 03:12–03:13 UTC, all `candidate`.

## TL;DR

- **The empty rooms aren't a scene-derivation bug. They're what the financial prompts ask for.**
  The financial `base.md` v3 says "Depict a PLACE" and "Prefer objects, spaces and traces of people to
  people themselves… A room that someone has just left is usually better than a person in it." The
  `credit.md` v3 overlay's first metaphor is "Headroom in a space: a shelf… with clearly unused room
  left", explicitly for "limits, balances, utilization". The hard constraints then ban every object
  that could carry the card's meaning (numbers, cards, charts). The writer did exactly that: card 1
  "a wooden shelf… with some empty space above it **symbolizing headroom in credit utilization**",
  card 2 "a bookshelf… leaving a visible gap… **representing credit headroom**", card 3 "a small potted
  plant… leans slightly… an overlooked detail" (the overlay's "small slip" metaphor).
- **There is no separate scene-derivation step.** The stored `scene` is the raw context block
  (Track / Track description / Lesson / Lesson description / Sub-segment / Content), built by
  `buildUserPrompt` (`src/prompts/assemble.ts:90-98`) and saved as `content_images.scene`
  (`generateSubSegmentImage.ts:167`). One LLM call turns context + base + overlay into the final image
  prompt. That's by design (contract: `scene` = "the derived card-content scene"), but it means no
  one-line depiction ever exists to inspect or override.
- **The financial overlays are in use.** `imagePromptRoot('financial')` → `prompts/image/financial/`;
  topic `credit` → `topics/credit.md`. All six rows record base v3 / overlay v3, topic `credit`. The
  parenting root `base.md` (crib, parent-and-baby) is **not** used on financial.
- **Amounts:** the Plain Money tone block (`prompt_blocks` …0204) **is present and was in the prompt**
  for this segment. It forbids the *reader's* amounts ("you do not know them"), but the model wrote
  *illustrative* amounts ("if your credit limit is $1,000"), which that wording doesn't clearly cover.
  And **financial has zero `voice_lint_rules`**, so the lint ran and found nothing (`lint: []`).

## 1. Scene derivation: what goes in, what comes out

**Code path.** `generateSubSegmentImage` (`src/jobs/handlers/generateSubSegmentImage.ts:124-208`):
load context (`:146`; topic = `topics.name` of the *lesson's* `topic_id`, `:60,71`) → `assembleImagePrompt(topicName,
metadata, instructions_override, scene, DOMAIN)` (`:157-163`) → the user prompt is `scene` if a scene
was given, else `buildUserPrompt(metadata)` (`assemble.ts:111`) → `sceneUsed = assembled.userPrompt`
(`:167`) → one LLM call with `instructions = base.body + "\n\n" + overlay.body` (`assemble.ts:141`),
schema `{prompt, name, tags}` (`:79-87`) → the image model gets only `prompt`.

So **the raw context *is* the "scene"**. It's stored in `content_images.scene` and shown by the CMS
panel. No one-line depiction is produced or stored; the image prompt the LLM writes is the only place
the chosen scene exists.

**`ai_generation_log` rows for cards 1–3** (one `image_prompt_generate` + one `image_generate` per card,
tied by `correlation_id`):

| Card | `image_prompt_generate` (gpt-4o-2024-08-06) | `image_generate` (gemini-3.1-flash-image) | content_image |
|---|---|---|---|
| 1 "What's This Ratio?" | `9818fc46-557c-4774-867a-ea53f6e00035` (03:12:27, 4120 ms) | `128f8350-3eb6-4975-bb12-4432702d574d` (8186 ms) | `2bcf5a10-…` |
| 2 "Low Balance, Healthy Ratio" | `5cbcdc81-6b50-446e-9466-0dcb2acc5ea5` (03:12:27, 3594 ms) | `e42b4a6f-c0c5-4d90-b503-ba6a80d3ae17` (9537 ms) | `7d4a3f8f-…` |
| 3 "How It's Calculated" | `02e6ad68-fa21-4581-8947-af5a887a7f1b` (03:12:42, 3699 ms) | `0f88f756-8e23-4c1f-a477-bc7f2199e0c6` (7583 ms) | `64b3b0b1-…` |

**Full rendered prompt, card 1** (log `9818fc46…`, 12,855 chars). The `[SYSTEM]` part is
**byte-identical** to `prompts/image/financial/base.md` v3 body + `"\n\n"` + `topics/credit.md` v3
body (verified: 12,142 chars, exact string match), so it's cited by file rather than pasted. The
`[USER]` part, verbatim:
```
[SYSTEM]
<prompts/image/financial/base.md v3 body>

<prompts/image/financial/topics/credit.md v3 body>

[USER]
Track: Credit Health
Track description: How credit utilization works, why the 30% guideline exists, what moves a score and what doesn't, and the difference between a limit and a balance. Practical, not aspirational.
Lesson: Why Your Credit Balance-to-Limit Ratio Matters
Lesson description: hat credit utilization is, why it weighs so heavily in a credit score, and the few moves that bring it down quickly.
Sub-segment: What's This Ratio?
Content: The credit balance-to-limit ratio is the amount you owe divided by your credit limit, shown as a percentage. It matters because it affects your credit score, influencing loan eligibility and rates. Keeping it low indicates responsible credit use.
```
(Note the lesson description's first word is truncated: "hat" instead of "What". That's a data typo on the
lesson row, not a pipeline bug.)

**What came back** (response content, verbatim):
> "Minimalist flat vector illustration, clean 2D with simple geometric shapes, soft rounded corners and
> flat blocks of colour, no gradients, textures or shadows; calm and matter-of-fact, not
> photorealistic. A cozy living room nook in the afternoon: a wooden shelf high on a slate blue wall,
> with some empty space above it symbolizing headroom in credit utilization. A few books are neatly
> arranged on the shelf, and a small potted plant in soft sage green sits at the end of the shelf.
> Light from a window on the right falls as a soft ochre block across part of the wall and the shelf.
> A comfy armchair in the foreground shows part of its armrest, contributing to the depth. The wall
> is in muted slate blue (#5E7288), the plant in soft sage green (#93A58C), and the light block in
> soft ochre (#C9A45C), all on a warm off-white ground (#F6F3EE). Three layers of depth: the armchair
> in the foreground, the shelf in the middle, and the wall in the back. No text, no letters, no
> numbers, no currency symbols, no charts or graphs, no logos, no icons or symbols, no floating shapes."
> name "Headroom on a Shelf"

Cards 2 and 3: "Spacious Reading Corner" (bookshelf with a gap "representing credit headroom") and
"Office detail needs tending" (a leaning plant on a desk). Same family.

**Answer:** the raw context is what's stored and sent. There's no one-line depiction. The prompt-writer
does the depiction itself, and the instructions steer it to *empty places + abstract metaphor*.

## 2. Base + overlay resolution on financial

- `imagePromptRoot(domain)` (`assemble.ts:16-22`) returns `prompts/image/financial/` because it holds a
  `base.md`. Everything resolves from there; there's no fallback to root files.
- The overlay key is **`topics.name` of the lesson's topic**, not the track. This lesson's topic is `credit` →
  `prompts/image/financial/topics/credit.md` (v3). Track "Credit Health" plays no part in overlay
  choice. Financial topics: accounts, credit, debt, income, money mindset, planning, saving, spending.
  Each has an overlay file, plus `_generic.md` for a lesson with no topic.
- History: `8a8cea5` (09-18, domain folders + eight overlays), `bae39b4` (09-20, v2 "scenes with place
  and depth, metaphors per topic"), `4c40227` (09-21, v3 "setting variety"). **The v2 shift to
  "place, not object" plus "prefer traces of people" is what produced the empty rooms.**

**Parenting-specific content lives only in the root `prompts/image/base.md`** (not used on financial):
role "Moosii, a parenting-education app" (`:8`); "Show a real, concrete parenting moment — people…
(a parent, a child, a parent-and-baby pair)" (`:20-31`); safe-sleep "Any crib or bassinet shown must be
completely bare… baby lying on its back" (`:58-59`); family-diversity rule (`:68-70`); a feeding worked
example (`:95-102`). **The financial `base.md` has none of these.** It's a clean separate file: no crib,
no safe-sleep, no family. The problem isn't leakage from parenting. It's the financial file's own
choices: people-averse, place-first, metaphor-driven.

## 3. File-based vs DB-composed image prompts (recommendation only)

| | Stay files (today) | Move to DB (like content prompts) |
|---|---|---|
| Per-domain | Solved by domain folders (09-18) | Natural: each project has its own rows |
| Edit loop | Commit → push → deploy. Slow for visual tuning; Mark can't edit from the CMS | CMS-editable; the tone and structure tooling already exists (`/tones`, blocks, `prompt_block_versions`) |
| Versioning | git history + a frontmatter `version` recorded on every image | needs a version per block (the `prompt_block_versions` pattern exists) |
| Validation | boot-time frontmatter check (`validateImagePrompts`) | needs admin-route validation |
| Security today | files can't be edited by any client | ⚠ `prompt_blocks` / `prompt_block_versions` have **RLS off**, and after 099 any **signed-in** user can still write them (backlog P1). Moving image prompts there first would widen that |

CLAUDE.md is explicit that this split is intentional ("IMAGE prompts are versioned files… CONTENT and
classification prompts are DB-composed"), so this isn't a rule violation today.
**Recommendation:** fix the financial files now (fast, reviewable, diffable against the images they
produced). Plan a move to DB-composed image prompts as its own slice, **after** the RLS P1 closes
`prompt_blocks`, reusing the tone and block machinery (block types `image_base` / `image_overlay` keyed
by topic). The trigger for the move is Mark wanting to tune images from the CMS without a deploy.

## 4. Proposals (drafts, not applied)

### (a) Scene-derivation instruction: "a person doing X with Y in Z"

Two options. **Recommend A now, B later.**

**A — prompt-only (no code).** Replace the financial base's "People" section and prepend a
"Scene first" step:

> ## Scene first — one line, then the prompt
> Before writing the image prompt, write the scene as ONE sentence in this exact shape:
> **"A [person] [doing a concrete action the card describes] with [one ordinary object] in [a named place]."**
> Take the action from the card's Content. It's what the reader would actually be doing when this
> card matters (checking a statement, moving money between two envelopes, setting a phone reminder,
> paying a bill at a desk). The object is the one that makes the action legible *without text or
> numbers*. The place follows the setting rules below. Then write the full image prompt around that
> sentence, and put the sentence first in the prompt.
>
> ## People
> Every image shows one adult, mid-action. The action carries the meaning, so the person is the
> subject, not a trace. Show them from the side, over the shoulder or three-quarter, face calm and not
> the focus, hands clearly doing the thing. One person, ordinary clothes, varied age, skin tone and
> build across a lesson. Never a posed stock-photo smile, never a group arranged for the camera. A
> room without a person is allowed only when the card is literally about a place or an object.

**B — structural (code change, later).** Add `scene` to the writer's output schema (`{scene, prompt,
name, tags}`, `generateSubSegmentImage.ts:79-87`) and store *that one-liner* in `content_images.scene`,
keeping the raw context recoverable from `ai_generation_log`. The CMS panel then shows the real
depiction, and "Use as starting point" edits a sentence instead of a context dump. It changes what
`scene` means in the contract, so it's Mark's call.

### (b) Financial overlay set

Overlays are keyed by **topic**, so "subscriptions / buffer / paycheck" map onto existing topics:
subscriptions → `spending`, buffer/savings → `saving`, paycheck → `income`. Credit → `credit`. Each
should lead with *actions*, keep one place metaphor at most, and drop "empty room" options.

**Draft — `prompts/image/financial/topics/credit.md` v4:**
> These rules apply on top of the base instructions for credit sub-segments.
>
> Credit is abstract, so show the **everyday action** that the card is about. The person and what their
> hands are doing carry the meaning; the setting only places it.
>
> ## Actions (options, not a checklist — pick the one that matches THIS card)
> - **Checking where things stand** — someone at a desk under a window, reading a paper statement
>   held face-down to the viewer, a pen beside it. Fits: what utilization is, how it's calculated,
>   checking your ratio.
> - **Paying something down** — someone at a kitchen-free table or a hallway shelf, sealing an envelope
>   or tapping a blank phone screen, a closed bill folder set aside. Fits: lowering a balance, paying
>   before the statement date.
> - **Leaving room** — someone putting one item into a half-full bag or cupboard and choosing not to add
>   another. Fits: keeping use low, not maxing out, headroom.
> - **Keeping something for years** — someone hanging a well-worn coat on its usual hook. Fits: account
>   age, keeping an old card open.
> - **A small slip, then fixing it** — someone finding a letter under the hall table and opening it.
>   Fits: a missed payment and what follows.
>
> ## Traps specific to this topic
> - NO score gauges, dials, meters, rising arrows, padlocks or shields, "approved/denied" stamps.
> - A card, if it appears at all, is a plain blank rectangle, held edge-on or face-down: no chip
>   pattern, no numbers, no name, no network colours. Prefer no card.
> - Not an empty room with spare shelf space: "headroom" is shown by a person choosing to leave room.

Outline for the other three (same shape, to draft after credit is approved):
- **`spending` (subscriptions):** someone on a sofa or bus seat scrolling a blank phone and pausing;
  someone cancelling something on a laptop with the screen dark and angled away; someone opening a
  small parcel they'd forgotten ordering. Trap: no streaming-service UI, no app icons.
- **`saving` (buffer):** someone moving a jar from a high shelf to a reachable one; someone putting a
  folded note in a drawer they rarely open; someone checking a spare umbrella by the door (a rainy-day
  metaphor, used sparingly). Trap: no piggy bank, no jar of coins with visible money.
- **`income` (paycheck):** someone at a desk on a Friday afternoon setting a phone reminder;
  someone handing a folded form across a counter (direct-deposit setup) with no visible text; someone
  sorting mail into two trays. Trap: no pay stubs with figures, no cash.

### (c) Financial imagery "never" list (for the base's Hard constraints)
Most of this already exists in `base.md` v3 ("Hard constraints", "Register"). Consolidated, with the
gaps marked **new**:
- No readable text, letters, numbers or digits anywhere, including screens, paper, signs and clothing.
  Screens are dark, blank or turned away.
- No currency symbols, percentage signs, charts, graphs, arrows, trend lines, dials, meters, score gauges.
- No logos, brand marks, institution names, bank storefronts; **no real card networks** — a card is a
  blank rectangle, **no chip, no hologram, no network colour pairs** (new: explicit chip and hologram).
- No cash stacks, coins, money bags, piggy banks, vaults, dollar signs.
- **No distress cues:** head in hands, crying, red stamps, overdue notices, torn-open bills, collection
  letters, eviction or repossession imagery, empty wallets turned out (partly present; **new:**
  torn bills, collection letters, eviction).
- No celebration or glossy fintech: confetti, trophies, neon, gradients, lens flare.
- **New: no identifiable real people or likenesses, no children as the subject** (financial is for
  adults; a child in the background of a home scene is fine).
- **New: no luxury signalling** (sports cars, designer bags) and **no poverty signalling**: ordinary,
  modest homes.

## 5. Dollar amounts in cards 2–3

**Which tone:** `sub_segments.tone_id` = `f0840000-0000-4000-8000-000000000301` on all six cards =
the financial `segment` prompt, tone **"Plain Money"**, `is_active` t, model `gpt-4o`. Its blocks:
tone `plain_money` (…0204), structure `standard_arc` (…0202), length `standard_400` (…0201),
card positions `card_positions_v1` (…0203), size profile …0101.

**Is "never name an amount" present?** Partly. The live tone block (…0204) says:
> "Do not state dollar amounts or balances — you do not know them. Refer to the reader's own numbers
> generically ("your balance", "the card with the highest rate")." … "Never write: … numbers you cannot
> know ("your $4,200 balance")."

**Was it active?** Yes. The segment's `segment_content` log row (`a8ce66a3-…`, 2026-09-28 03:12:10,
notes "tone: Plain Money (…0301)") contains that sentence in its prompt, and its response contains
"$1,000". **Why it failed:** the rule is justified by "you do not know them" and illustrated with the
reader's own balance. The model read it as "don't invent the reader's figures" and treated a worked
example ("if your credit limit is $1,000, ideally owe less than $300"; "If you owe $400 and have a
$1,000 limit, your ratio is 40%") as allowed. Card 3 is literally the kind of arithmetic example the
card-writer reaches for when explaining a ratio.

**The lint net is empty on financial:** `voice_lint_rules` has **0 rows** on financial (Moosii's rules
are data and never reached financial). The job `43b881fa-…` (`generate_segment_content`, succeeded)
recorded `lint: []`. Advisory or not, nothing could have flagged it.

**Also exposed:** the quiz call for the same segment (`bb6b1b03-…`, gpt-5.1) saw "$1,000" in the card
content, and the quiz prompt doesn't carry the tone block, so a quiz question can repeat the amount.

**Proposed fixes (Mark decides; each is a data migration, financial only, hash-guarded like 083):**
1. **Tone block wording** (…0204): replace the amounts sentence with
   *"Never write a dollar amount, price, balance, limit or percentage of money, not even as an example.
   Explain ratios and rules in words ("less than a third of your limit"), and refer to the reader's own
   figures generically ("your balance")."* This also matches the seed draft's now-resolved voice rule.
   Note "30%" as a *guideline* is a percentage of a limit, not an amount; decide whether "under 30%" is
   allowed. The draft above bans it, and "less than a third" says the same.
2. **Seed financial `voice_lint_rules`**: one rule, `type` regex, pattern for a currency amount
   (`\$\s?\d` and `\d[\d,]*\s?(dollars|USD)`), scope `card`, severity high, message "names an amount
   (financial tone forbids amounts)", tone Plain Money. Advisory per the existing contract. It would
   have flagged cards 2 and 3.
3. **Quiz prompt** (financial `quiz` row): the same one-line no-amounts rule, since quizzes don't see
   the tone block.
4. **This lesson:** regenerate cards 2–3 (or the segment) after fix 1. It's unpublished, so no reader has
   seen it.

## 6. Not done (at the time of the report)
No prompt, file, row or code changed. No image regenerated. (§7 records what was applied afterwards.)

## 7. Applied 2026-09-28 (Mark's decisions) — and what was not

**Applied:**
- **Migration 100** (financial only, data): the tone block's amounts sentence replaced; the same sentence
  appended to the financial quiz prompt; lesson typo fixed ("hat" → "What"). Hash-guarded; verified by
  read-back (`ff8985d0` / `52add72d` / `65a642ec`; prior tone text kept in `prompt_block_versions`).
- **Files:** `prompts/image/financial/base.md` **v4**: "Scene first" one-line step (§4a), a new People
  section (one adult mid-action), the §4c never list folded into Hard constraints, "What to return" opens
  with the scene sentence, and the worked example now has a person. The v3 example was a person-less
  bathroom tap, which would have taught against the new People rule; the reference-image paragraph gains
  one sentence noting it predates the People rule. `topics/credit.md` **v4** as drafted in §4b. The
  boot validator passes (15 files); financial `credit` resolves base 4 / overlay 4; Moosii is unchanged
  (root files, v1).
- **Not regenerated:** no image or card; Mark does that in the CMS.

**Not applied: the currency-amount lint rule. It isn't expressible without code.**
- `voice_lint_rules.type` is CHECK-limited to `ban | opener | limit | conditional | repeat`
  (`migrations/012_voice_lint_rules.sql:32`); severity is `error | warn` (`:39`). There's no "high".
- Every pattern is escaped and matched as a literal whole phrase on normalized text
  (`src/lib/voiceLint.ts` `phraseRegex` / `escapeRe`), so `\$\s?\d` would match only that literal string.
- The loader reads every active rule and ignores the `tone` column (`voiceLint.ts`, `.select(...)`
  `.eq("is_active", true)`), so a per-tone rule isn't possible today.
- Error-severity `ban` rows are **injected verbatim into every generation prompt** ("Never use these
  phrases…", `loadPromptBanInstruction`). A regex seeded as a ban would put raw regex text into every
  financial content prompt.

**Proposal (needs a go; code + schema, both projects):** add a `regex` rule type. Engine: compile
`pattern` as a case-insensitive JS RegExp against the un-lowercased card text, and hit per match. Never
inject `regex` rows into prompts (the prevention layer stays phrase-only). Honour `tone` when set
(match against the segment's tone name). Migration: widen the `type` CHECK to add `regex`, then seed
the financial rule (`rule_key` `no_currency_amount`, `type` regex, pattern
`\$\s?\d|\d[\d,]*\s?(dollars|USD)`, scope `card`, severity `error`, tone `Plain Money`,
message "names an amount (financial tone forbids amounts)"). With today's engine the closest
no-code option is a `ban` on the word "dollars" alone. It catches "100 dollars" but not "$100", and gets
injected into prompts. Not recommended.

## 8. Draft overlays — spending, saving, income (NOT applied; for a later pass)

Same shape as `credit.md` v4: actions first, one person mid-action, traps last. Topic keys are the
financial `topics.name` values.

**`topics/spending.md` v4 (subscriptions and everyday spending)**
> These rules apply on top of the base instructions for spending sub-segments.
>
> Show the moment someone notices or decides about a regular cost. The person and their hands carry
> the meaning.
>
> ## Actions (options, not a checklist — pick the one that matches THIS card)
> - **Noticing a repeat** — someone on a sofa or a bus seat, scrolling a phone whose screen is dark or
>   turned away, pausing mid-scroll. Fits: finding forgotten or recurring charges.
> - **Cancelling something** — someone at a desk under a window, laptop screen angled away, hand on the
>   trackpad, a mug set aside. Fits: cancelling a subscription, trimming a plan.
> - **An unexpected arrival** — someone in a hallway opening a small parcel they'd forgotten ordering.
>   Fits: impulse or auto-renewed purchases.
> - **Choosing not to** — someone putting an item back on a shop shelf. Fits: pausing before a purchase.
>
> ## Traps specific to this topic
> - NO app icons, streaming-service interfaces, logos or recognisable screens; screens dark or turned away.
> - NO receipts with figures, price tags, shopping bags with brand marks.

**`topics/saving.md` v4 (buffer and savings)**
> These rules apply on top of the base instructions for saving sub-segments.
>
> Show the small, deliberate act of setting something aside or keeping it within reach.
>
> ## Actions (options, not a checklist — pick the one that matches THIS card)
> - **Putting something aside** — someone slipping a folded note into a drawer they rarely open, or a
>   plain envelope into a box on a high shelf. Fits: starting a buffer, moving money to savings.
> - **Keeping it reachable** — someone moving a jar from a high shelf to one they can reach easily.
>   Fits: an emergency fund you can actually get to.
> - **Ready for a rainy day** — someone checking a spare umbrella by the front door (sparingly; once
>   per lesson at most). Fits: why a buffer matters.
> - **Topping up** — someone refilling a watering can at a garden tap before it runs out. Fits:
>   replenishing savings after using them.
>
> ## Traps specific to this topic
> - NO piggy banks, jars of visible coins or notes, money bags, safes or vaults.
> - The jar or envelope is plain and opaque: its contents are never shown.

**`topics/income.md` v4 (paycheck and direct deposit)**
> These rules apply on top of the base instructions for income sub-segments.
>
> Show the routine around money coming in: setting it up, sorting it, planning for it.
>
> ## Actions (options, not a checklist — pick the one that matches THIS card)
> - **Setting it up** — someone handing a folded form across a counter or desk, no visible writing.
>   Fits: setting up or switching direct deposit.
> - **Payday routine** — someone at a desk on a late afternoon, setting a reminder on a phone whose
>   screen faces away. Fits: what to do when the paycheck lands.
> - **Sorting the post** — someone in a hallway sorting mail into two trays. Fits: separating bills
>   from income, a regular money check-in.
>
> ## Traps specific to this topic
> - NO pay stubs, cheques or bank statements with figures; NO cash in hand; NO employer logos or
>   uniforms that read as a specific company.
