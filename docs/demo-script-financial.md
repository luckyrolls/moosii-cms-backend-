# Moosii Financial — 5-minute partner demo script

Audience: product / partnerships lead at a consumer financial company that uses MX.
Thesis (say it once, first): **"Your insights get attention. They don't get follow-through. We turn the insight into a plan the user follows — and we can show you they followed it."**

Confirmed 2026-10-02: the prospect uses MX Insights. We are the follow-through behind their existing insight cards.

Honesty rule: anything simulated is labeled on screen and said out loud. Seeded outcome data is called seeded.

Shape: Moosii is a plan **widget** on the partner's own widget page. Sam's story runs uninterrupted (Beats 1–4). Sarah appears once (Beat 5) to prove the plan is personal. The outcome (Beat 6) covers both, then the ask.

Personas: **Sam** — real user, facts derived live from an MX sandbox bank connection (credit utilization high/estimated → Credit Health). **Sarah** — seeded facts (no buffer, steady paycheck → Building a Buffer). Outcome movement in Beat 6 is seeded and labeled.

---

## Beat 1 — The page they already have (0:00–0:45)
**Screen:** `/demo/partner` — a simulated partner page ("Demo — simulated partner page"), neutral grey tiles: Accounts, Spending, an Insight card ("A card is close to its limit"), and the **Moosii plan tile**. Viewing as Sam.
**Say:** "This is the kind of page you build today out of widgets. We're one more tile. Sam's tile already knows what he needs next."
**Needs:** mock partner page framing `/widget/plan`; persona switcher.

## Beat 2 — The door (0:45–1:45)
**Screen:** Sam taps **Start** on "Up next: When a Card Is Nearly Maxed Out" (or taps Learn more on the insight tile — same lesson). The lesson opens inside the tile: 5–8 cards, one quiz question.
**Say:** "Two minutes, written for the moment he's in. No dollar amounts, no judgment."
**Needs:** lesson in embedded (compact) mode inside the tile.

## Beat 3 — The plan (1:45–2:30)
**Screen:** back to the tile: that lesson marked done, "Up next" moves to the next item. Tap "See full plan": Credit Health leads, with a Getting Oriented lesson along the way.
**Say:** "The insight was a moment. The plan is what's always on his page — built from what his accounts tell us. Yes/no facts, never amounts."
**Needs:** tile updates after completion (done this visit); full plan view.

## Beat 4 — The return (2:30–3:00)
**Screen:** `/demo/email` — "Sam, step 2 of your plan is ready." Tap → the lesson.
**Say:** "An insight happens once. A plan brings them back. The cadence is ours to run; the channel is yours to choose."
**Needs:** done (static page).

## Beat 5 — Same insight, different person (3:00–3:30)
**Screen:** switch to **Sarah**. Same page, same insight tile. Her plan tile leads with "Why One Month Comes First" — Building a Buffer — because she has no emergency cushion and a steady paycheck.
**Say:** "Same insight. Different person, different plan. Nobody configured that — it comes from her data."
**Needs:** Sarah with seeded facts; Building a Buffer lessons published.

## Beat 6 — The outcome (3:30–4:30) ← the pitch
**Screen:** two short timelines, every point labeled real or seeded. Sam: real facts today (utilization high), then a seeded "six weeks later" point (moderate). Sarah: seeded no buffer → buffer. Then an aggregate panel labeled **seeded example**: "Users who started a plan: N; moved a fact the right way within 30 days: X%."
**Say:** "We don't ask whether it worked. We see it in the data you already have. This is the number your team reports upward."
**Needs:** `demo_outcome_series` (seeded, labeled; never future-dated rows in user_facts), outcomes page.

## Beat 7 — The ask (4:30–5:00)
**Say:** "Integrating is the same as adding an MX widget: your backend asks ours for a widget link for the user, and you put it on the page. A 60-day pilot; we measure fact movement against a holdout. From you: handle the insight card's Learn more tap by opening our widget link with the insight name; facts from your MX data (or access to derive them)."
**Have ready:** who reviews the content (**gap: name someone**); where the data lives (facts only, no amounts); webview vs. tab embedding (either works); which MX insights are enabled, and which were left off and why?

## Presenter notes
- Spending is real MX sandbox data; the sandbox's synthetic Fees & Charges are excluded from the view.
- Before each demo: `npm run demo:reset -- --go` (from the backend repo; without `--go` it is a dry run that prints the host and per-table counts). Clears Sam's and Sarah's completions, lesson progress, questionnaire answers and classify-applied track changes (keeps Sam's orientation completion), recomputes moosies, resets the plan intro, rebuilds both plans. Never touches facts or the seeded outcome series. Needs `FINANCIAL_DB_URL` (and `FINANCIAL_INTERNAL_API_KEY` for the rebuild) in `.env`.

---

## Build list
| Item | Owner | Status |
|---|---|---|
| Mock insights feed (secondary entry) | reader | done |
| Plan widget `/widget/plan` + embedded lesson mode | reader | new |
| Mock partner page `/demo/partner` framing the widget | reader | new |
| Production widget-link endpoint + frame-ancestors | backend + reader | after partner confirms shape |
| Lesson + quiz reader | reader | done |
| Mock email page | reader | done |
| Fact derivation (Sam, real) | backend | done |
| RLS pass (15 RLS-off tables; published-only reads) | backend | **blocks demo sign-in** |
| Demo sign-in endpoint + persona flags | backend | designed |
| Sarah seeded facts (source `seed`) | backend + Mark | designed |
| Track weights: fact tracks above Getting Oriented | Mark | decision |
| Plan view from the user's path | reader | new |
| demo_outcome_series + outcomes page | backend + reader | designed |
| Content: Credit Health ×3, Building a Buffer ×3–4, Subscription Audit ×1 | Mark | in progress |
| Content reviewer named | Mark | open |

## Cut
- Anonymous "rest of track" list; check-in questionnaire; MX Connect widget; real MX Insights.
