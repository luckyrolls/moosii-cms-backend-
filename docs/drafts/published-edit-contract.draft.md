# DRAFT contract diff — published-content edit policy

**Status: `[DESIGN]`, nothing built.** Written to be pasted into `docs/api-contract.md` when
the slice is built. It is deliberately NOT in that file yet: its preamble reserves it for
DELIVERED shapes, and none of this exists. Companion to `FINDINGS-published-edit.md` and draft
migrations `064` / `065`.

One correction HAS already been made directly to `api-contract.md` §3, because it was a false
statement about delivered behaviour rather than new design: the claim that the CMS repointed
its lesson publish toggle to the backend routes. It has not. See FINDINGS §A.4.

---

## Proposed §9. Published-content edit policy — `[DESIGN]`

### 9a. The rule

Editing **content** on a **published** lesson is governed per deployment, from
`app_settings.domain` (migration 064), which must equal the backend's `DOMAIN` env:

| domain | policy |
|---|---|
| `moosii` | **warn** — the CMS asks the editor to choose (A) unpublish and re-review, or (B) keep live as `published_unreviewed` |
| `financial` | **block** — content on a published lesson cannot be written at all; unpublish first |

**Content** = `sub_segments`, segment text, `quiz_questions`, `quiz_answers`, lesson images.
**Metadata** (`priority`, `track_id`, names, ages, `topic_id`, `curator_note`, `archived_at`,
`is_published`) is unaffected and stays editable while published.

### 9b. How the CMS learns it is blocked — an error, not a pre-flight

**There is no pre-save check endpoint, deliberately.** A check is a race: the lesson can be
published between the check returning "fine" and the save landing. The database trigger is the
authority.

- **Backend-mediated writes** (`PATCH /sub-segments/:id`, `POST /sub-segments/:id/upload-image`,
  the generation jobs) surface it as:
  ```
  → 409 { error: { code: "published_content_locked",
                   message: "content of published lesson <id> (<name>) cannot be edited in this domain; unpublish it first" } }
  ```
- **CMS-direct writes** (card reorder, add card, quiz edit — the three paths in FINDINGS §A.2
  that bypass the backend) get the same failure as a PostgREST error carrying
  `SQLSTATE 23514` with `HINT = 'published_content_locked'`. One CMS error handler keyed on
  that hint covers both transports.

A **pre-flight is still worth adding for UX**, so the editor is warned before typing rather
than after saving — but it must be advisory and must never be what enforces. If added, the
natural shape is a field on the lesson payload rather than a new endpoint (see 9c).

### 9c. The state, in list and detail payloads

From the derived view `lessons_review_status` (migration 065). Nothing is stored, so nothing
can drift and nothing needs clearing.

```
content_state: "draft" | "published_reviewed" | "published_unreviewed"
cards_awaiting_editorial:  number
cards_awaiting_clinical:   number
cards_total:               number
quiz_questions_unapproved: number
content_last_edited_at:    string | null   // ISO
```

- `draft` — not published.
- `published_reviewed` — published, every card clinically approved.
- `published_unreviewed` — **published with at least one card not clinically approved.**

The CMS reads lessons Supabase-direct, so this ships as a **view it selects from**, not a route
change. `content_state` is also what a UX pre-flight would read (9b).

> ⚠ **`published_unreviewed` currently also means "the app cannot open this lesson".** The app
> selects segments with `seg_status='complete'` and throws when none matches, so a published
> lesson with any draft card errors for parents until re-approval. Until `moosii-rn` changes,
> **option B is not honestly "keep live"** — see FINDINGS §B.4. The CMS dialog must not offer
> option B as a no-consequence choice while that is true.

### 9d. Clearing it

No endpoint. `POST /lessons/:id/approve` already transitions every card to
`clinically_approved`, which recomputes `seg_status` to `complete`, which makes the derived
state `published_reviewed` again. The two-stage gate is unchanged: `POST
/lessons/:id/editorial-approve` first (editorial capability), then `approve` (clinical
capability), which still 409s if any card still awaits editorial.

### 9e. Reviewer queue

Both stages read the same view. `published_unreviewed` sorts **above** unpublished drafts: it
is the only review backlog with live (or, per 9c, erroring) parent exposure.

```sql
-- stage 1, editorial
SELECT * FROM lessons_review_status
 WHERE content_state = 'published_unreviewed' AND cards_awaiting_editorial > 0
 ORDER BY content_last_edited_at DESC NULLS LAST;

-- stage 2, clinical
SELECT * FROM lessons_review_status
 WHERE content_state = 'published_unreviewed'
   AND cards_awaiting_editorial = 0 AND cards_awaiting_clinical > 0;
```

Capability gating is unchanged (migration 056): role controls what you see, capability controls
what you may sign.

### 9f. Boot check to add alongside `DOMAIN`

`src/lib/domain.ts` gains a startup read of `app_settings.domain`:

- row missing → log loudly, continue (an unseeded project).
- row present and **different** from `process.env.DOMAIN` → `process.exit(1)`, exactly as an
  invalid `DOMAIN` does today.

A deployment whose database enforces one domain's policy while the service believes it is the
other must fail to boot rather than run. Document it in the §Conventions **Domain** bullet
added by slice 1.
