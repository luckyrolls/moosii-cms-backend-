# Moosii Financial — 5-minute partner demo script

Audience: product / partnerships lead at a consumer financial company that uses MX.
Thesis (say it once, first): **"Your insights get attention. They don't get follow-through. We turn the insight into a plan the user follows — and we can show you they followed it."**

Honesty rule: anything simulated is labeled on screen and said out loud. Seeded outcome data is called seeded.

Shape: Sam's story runs uninterrupted (Beats 1–4). Sarah appears once (Beat 5) to prove the plan is personal. The outcome (Beat 6) covers both, then the ask.

Personas: **Sam** — real user, facts derived live from an MX sandbox bank connection (credit utilization high/estimated → Credit Health). **Sarah** — seeded facts (no buffer, steady paycheck → Building a Buffer). Outcome movement in Beat 6 is seeded and labeled.

---

## Beat 1 — The moment (0:00–0:45)
**Screen:** `/demo/insights`, "Viewing as: Sam". Simulated partner feed, "Demo — simulated partner app" label visible. Cards: Credit card nearing its limit · New recurring charge · Credit utilization.
**Say:** "This is your app. Sam gets the insight you already send him today. Normally he reads it and nothing happens. He taps Learn more."
**Needs:** persona switcher on the feed (Sam / Sarah) that starts a real session for a demo user.

## Beat 2 — The door (0:45–1:45)
**Screen:** short lesson, "When a Card Is Nearly Maxed Out" — 5–7 cards, images that show the topic, one quiz question.
**Say:** "Two minutes, written for the moment he's in. No dollar amounts, no judgment."
**Needs:** the lesson, published.

## Beat 3 — The plan (1:45–2:30)
**Screen:** completion card, then **Sam's plan**: Credit Health first (next lesson highlighted), then Getting Oriented.
**Say:** "The insight was the door. This is the plan — built from what his accounts tell us. Yes/no facts, never amounts."
**Needs:** plan view reading the signed-in user's path (`user_mlp_not_completed`); Credit Health lessons published; fact tracks weighted above Getting Oriented.

## Beat 4 — The return (2:30–3:00)
**Screen:** `/demo/email` — "Sam, step 2 of your plan is ready." Tap → the lesson.
**Say:** "An insight happens once. A plan brings them back. The cadence is ours to run; the channel is yours to choose."
**Needs:** done (static page).

## Beat 5 — Same insight, different person (3:00–3:30)
**Screen:** switch to **Sarah**. Same feed, she taps the *same* card. Her plan leads with Building a Buffer, because she has no emergency cushion and a steady paycheck.
**Say:** "Same insight. Different person, different plan. Nobody configured that — it comes from her data."
**Needs:** Sarah with seeded facts; Building a Buffer lessons published.

## Beat 6 — The outcome (3:30–4:30) ← the pitch
**Screen:** two short timelines, every point labeled real or seeded. Sam: real facts today (utilization high), then a seeded "six weeks later" point (moderate). Sarah: seeded no buffer → buffer. Then an aggregate panel labeled **seeded example**: "Users who started a plan: N; moved a fact the right way within 30 days: X%."
**Say:** "We don't ask whether it worked. We see it in the data you already have. This is the number your team reports upward."
**Needs:** `demo_outcome_series` (seeded, labeled; never future-dated rows in user_facts), outcomes page.

## Beat 7 — The ask (4:30–5:00)
**Say:** "A 60-day pilot on one insight type. We measure fact movement against a holdout. From you: the Learn-more handoff with a user id, and either MX data access or facts passed to us."
**Have ready:** who reviews the content (**gap: name someone**); where the data lives (facts only, no amounts); webview vs. tab embedding (either works).

---

## Build list
| Item | Owner | Status |
|---|---|---|
| Mock insights feed | reader | done |
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
