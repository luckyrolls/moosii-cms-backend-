# FINDINGS — backend prep for games (2026-11-07)

Investigation only. No code, schema or data was changed. Every DB check was read-only, apart from one
probe on each project that ran inside a transaction and was rolled back (§1.3). Projects were confirmed
before any query: financial is PG 17.6, `system_identifier` …7684, `app_settings.domain = financial`;
Moosii is PG 15.8, …0655, `domain = moosii`.
Source brief: lesson-delete ordering (item 1) and image width/height for Jigsaw (item 2), following
`moosii-games/docs/FINDINGS-integration.md` §C and row 10.

---

## Step 0 — uncommitted files (none touched, none to be committed)

| Path | What it is | Likely origin | Secrets? |
|---|---|---|---|
| `.claude/settings.json` (modified) | Three entries added to the Claude Code `allow` list: `Bash(grep -E '(^\|/)\\.env$')`, `Bash(git commit -m '@ *)`, `Bash(git commit *)` | "Always allow" prompts accepted during recent commit sessions | No. Note that `Bash(git commit *)` lets Claude commit without asking. |
| `docs/Daily-reminder.zip` (untracked, 2.9 kB, 2026-09-12) | One file, `index.ts`, byte-identical to the committed `docs/legacy/daily-reminder/index.ts` | The download the legacy copy was taken from (commit db440ae) | No. It reads `SUPABASE_SERVICE_ROLE_KEY` and `FIREBASE_*` from `Deno.env` and holds no values. It's redundant. |
| `supabase/.temp/` (untracked) | `linked-project.json` (project ref, name "MoosiiApp", org id) + `cli-latest` (`v3.0.0`) | Supabase CLI cache, written by `supabase link` / `gen types` runs (last 2026-11-07, today's type regen) | No keys. It holds the Moosii project ref and org id, which are identifiers, not credentials. |
| `src/types/supabase/.temp/linked-project.json` (untracked, 2026-07-02) | Same content as above | A CLI run from inside `src/types/` early on | Same as above |

Neither `.temp` folder is gitignored. Adding `supabase/.temp/` and `**/supabase/.temp/` to `.gitignore` would stop
them from showing up. That's your call.

---

## Item 1 — lesson delete ordering

### 1.1 The route, end to end

Mounted at `src/index.ts:59` behind `jwtAuthMiddleware` (any CMS admin).

1. `src/routes/lessons.ts:374` calls `planLessonDelete` (`src/lib/contentTeardown.ts:36-78`). It only reads: it gets the
   segment ids and card ids and counts every cascade descendant for the confirm modal.
2. `lessons.ts:380-388` returns **409 `unpurgeable_images`** when lesson- or segment-level `content_images` exist.
3. `lessons.ts:390-393` handles `?dry_run=true`: it returns the counts and stops.
4. **`lessons.ts:397` runs `purgeImagesForSubSegments(cardIds)`** (`src/storage/purgeImages.ts:24-61`). Every step here is a
   separate PostgREST call with no transaction, and none of their errors are checked:
   - `:39` clears `sub_segments.image`/`image_path` (a write)
   - `:43` deletes the cards' `content_images` (a write)
   - `:49` removes the storage objects through the Storage API; the AFTER DELETE trigger drops `image_assets`
   - `:55` deletes any leftover `image_assets` (safety net)
5. **`lessons.ts:399`** deletes the `lessons` row. If that fails it returns `500 delete_failed`, but steps 4a–4d have already happened.
6. `lessons.ts:404` enqueues a coalesced MLP rebuild.

So the brief's claim is right: everything about the images is destroyed before the one statement that can be refused.

### 1.2 Every FK in the delete's reach (both projects identical)

I walked `pg_constraint` from `lessons` through every CASCADE edge. Both projects return the same 24 edges.

| Depth | Parent → child (column) | Constraint | ON DELETE |
|---|---|---|---|
| 1 | lessons → completed_items(lesson_id) | completed_items_lesson_id_fkey | CASCADE |
| 1 | lessons → content_findings(lesson_id) | content_findings_lesson_id_fkey | CASCADE |
| 1 | lessons → content_images(lesson_id) | content_images_lesson_id_fkey | CASCADE |
| 1 | **lessons → fact_entry_map(lesson_id)** | fact_entry_map_lesson_id_fkey | **RESTRICT** |
| 1 | lessons → lesson_source_documents(lesson_id) | lesson_source_documents_lesson_id_fkey | CASCADE |
| 1 | lessons → lesson_tags(lesson_id) | lesson_tags_lesson_id_fkey | CASCADE |
| 1 | lessons → questions_legacy(lesson_id) | questions_lesson_id_fkey | CASCADE |
| 1 | lessons → quiz_response(lesson_id) | quiz_response_lesson_id_fkey | CASCADE |
| 1 | lessons → quiz_user_progress(lesson_id) | quiz_user_progress_lesson_id_fkey | CASCADE |
| 1 | lessons → segments(lesson_id) | segments_lesson_id_fkey | CASCADE |
| 1 | lessons → starred_items(lesson_id) | starred_items_lesson_id_fkey | CASCADE |
| 1 | lessons → user_activity_followups(lesson_id) | user_activity_followups_lesson_id_fkey | CASCADE |
| 1 | lessons → user_lesson_progress(lesson_id) | user_lesson_progress_lesson_id_fkey | CASCADE |
| 2 | questions_legacy → answers_legacy(question_id) | answers_question_id_fkey | CASCADE |
| 2 | segments → content_images(segment_id) | content_images_segment_id_fkey | CASCADE |
| 2 | **segments → fact_entry_map(segment_id)** | fact_entry_map_segment_id_fkey | **RESTRICT** |
| 2 | segments → questions_legacy(segment_id) | questions_segment_id_fkey | CASCADE |
| 2 | segments → quiz_questions(segment_id) | quiz_questions_segment_id_fkey | CASCADE |
| 2 | segments → sub_segments(seg_id) | sub_segment_seg_id_fkey | CASCADE |
| 3 | quiz_questions → quiz_answers(question_id) | quiz_answers_question_id_fkey | CASCADE |
| 3 | quiz_questions → quiz_user_progress(question_id) | quiz_user_progress_question_id_fkey | CASCADE |
| 3 | sub_segments → content_findings(sub_segment_id) | content_findings_sub_segment_id_fkey | CASCADE |
| 3 | sub_segments → content_images(sub_segment_id) | content_images_sub_segment_id_fkey | CASCADE |

There is also one FK outside the cascade: `sub_segments(image) → image_assets(url)` `ON DELETE RESTRICT`. That's why the
purge has to clear the pointer before removing the file.

Triggers in the subtree: `content_edit_policy_guard` (AFTER I/D/U on segments, sub_segments, quiz_questions,
quiz_answers; AFTER U on lessons). It raises only when `domain = 'financial'` and the lesson is published.
Others: `segments_sync_with_quiz`, `quiz_questions_sync_with_quiz`, `sub_segments_reset_review`, `quiz_reset_review`.
On `storage.objects`: `protect_objects_delete` (BEFORE D) **refuses any direct SQL delete** ("Use the Storage API
instead") and `trg_delete_image_assets_on_storage_delete` / `trg_sync_image_assets_from_storage_{ins,upd}`.

### 1.3 Is the bug live today?

**Not through an FK, but the RESTRICT is already in place and needs only one row.** `fact_entry_map` has RESTRICT on both
`lessons` and `segments` (migration 073), but it has **0 rows in both projects** today. The first entry-map row authored for a
lesson makes deleting that lesson destroy its images and then fail with 23503. The games `lesson_id … ON DELETE RESTRICT`
link tables would do the same.

**Two paths that do fire today:**

- **Any failure of the row delete after the purge.** A network error, a timeout or a 5xx from PostgREST at `lessons.ts:399`
  leaves the lesson in place with its card images gone. That's the same data loss, triggered by chance.
- **Financial, published lesson: files leak and images are lost.** I probed this in a rolled-back transaction on a published
  financial lesson that has a card image. Purge step 1 (`UPDATE sub_segments SET image = NULL`) **raises**
  `published_content_locked` from `content_edit_policy_guard`. The route ignores that error. Step 2 still deletes the
  `content_images`. In step 3 the storage trigger tries to drop an `image_assets` row that `sub_segments.image` still
  references, so RESTRICT fails it and the Storage API call errors. That's a logged warning only, and the file stays. The
  lesson `DELETE` then **succeeds**: the probe returned `DELETE 1` with the guard passing on the cascade. Result: the lesson is
  gone, and its storage files and `image_assets` rows are orphaned with no record of them. On Moosii, where the guard is
  inert, both statements succeed.

### 1.4 Proposed fix: make the row delete the only decision, then purge storage from a durable record

Constraints that shape it:

- Storage objects **cannot** be deleted inside a DB transaction (`storage.protect_delete`), so a storage purge can never
  be atomic with a row delete.
- The object has to go before its `image_assets` row. Here the Storage API removal does that in one statement through the
  trigger.
- Once the lesson is deleted, the cards (and therefore every `sub_segments.image` pointer) are gone by cascade. Nothing
  references those `image_assets` rows any more, so **no pointer-clearing UPDATE is needed**. That UPDATE is the step
  the financial guard rejects.

Design:

1. **RPC `delete_lesson(p_lesson_id)`, one transaction** (migration 119, below). It locks the lesson, collects every
   storage path the subtree owns (card, segment and lesson-level `content_images`, plus the files behind the live
   `sub_segments.image` pointers), and then deletes the row. **Any RESTRICT raises 23503 here and the whole call rolls
   back: rows, images and files are all untouched.** If the delete succeeds, the same transaction writes the paths that
   nothing else still references into a new backend-only table, `storage_purge_queue`. The guarantee is structural:
   either the lesson is gone and its files are queued for removal, or nothing changed.
2. **Route** (`lessons.ts:395-406`): call the RPC in place of `purgeImagesForSubSegments` + `.delete()`. A 23503 maps to
   **409 `delete_blocked`**, naming the referencing table from the error detail ("still referenced by fact_entry_map").
   Any other error stays 500, and nothing has changed in either case. After the commit, `drainStoragePurgeQueue(ids)` calls
   `storage.remove(paths)`. The trigger drops `image_assets`, and the rows get stamped `purged_at`. A failure increments
   `attempts`, records `last_error`, logs, and never fails the response.
3. **Retry**: drain every unpurged row at boot, next to the stale-job reaper, and at the start of each drain. If a
   purge fails, the leftover file is a recorded, retried row instead of a silent leak.
4. **The 409 `unpurgeable_images` refusal goes away.** The RPC collects lesson- and segment-level images too, so the gap
   it guarded is closed. The CMS modal's refused state becomes dead code (flag for the CMS seat). No such images exist in
   either project today.
5. **Response**: `{ ok, lesson_id, deleted, images_purged }` keeps its shape. `images_purged` reports
   `{ files, image_assets, content_images }` as before, and one field is added: `purge_pending` (paths queued but not yet
   removed). The dry run is unchanged.
6. **Tests**: unit tests for the 23503 → 409 mapping and for the drain (stubbed storage: success stamps, failure counts).
   The RPC itself gets a local PG 17 harness check before the first apply: blocked delete leaves the lesson, cards,
   `content_images` and an empty queue; successful delete queues exactly the unshared paths.

This also makes the guard the games FINDINGS proposed (`409 has_game_puzzles` before the purge) unnecessary. With this
fix, RESTRICT on its own is safe.

**Same pattern elsewhere (not in this slice):** `DELETE /sub-segments/:id` (`subSegments.ts:147-151`) and the content
regen paths (`generateSegmentContent.ts:315`, `regenSegmentContent.ts:218,277`) also purge before a write that can fail,
and the financial guard can reject them the same way. They could reuse the queue later. That needs its own brief.

### 1.5 Draft SQL: migration 119 (both projects; DRAFT, not applied)

```sql
-- MIGRATION 119: delete_lesson — the row delete decides; storage is purged from a durable queue
-- DRAFT (pending apply) · both projects · financial first
BEGIN;

CREATE TABLE public.storage_purge_queue (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket      text        NOT NULL,
  path        text        NOT NULL,
  reason      text        NOT NULL,          -- 'lesson_delete'
  source_id   uuid,                          -- the deleted lesson's id (no FK: the row is gone)
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempts    integer     NOT NULL DEFAULT 0,
  last_error  text,
  purged_at   timestamptz
);
CREATE UNIQUE INDEX storage_purge_queue_pending_uq
  ON public.storage_purge_queue (bucket, path) WHERE purged_at IS NULL;
ALTER TABLE public.storage_purge_queue ENABLE ROW LEVEL SECURITY;   -- backend-only: no policy
REVOKE ALL ON public.storage_purge_queue FROM anon, authenticated;

CREATE FUNCTION public.delete_lesson(p_lesson_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_paths  text[];
  v_queued text[];
BEGIN
  PERFORM 1 FROM lessons WHERE id = p_lesson_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Every file the subtree owns, read while the rows still exist.
  SELECT coalesce(array_agg(DISTINCT p), '{}') INTO v_paths FROM (
    SELECT ci.storage_path AS p
      FROM content_images ci
     WHERE ci.lesson_id = p_lesson_id
        OR ci.segment_id IN (SELECT s.id FROM segments s WHERE s.lesson_id = p_lesson_id)
        OR ci.sub_segment_id IN (SELECT ss.id FROM sub_segments ss
                                   JOIN segments s ON s.id = ss.seg_id
                                  WHERE s.lesson_id = p_lesson_id)
    UNION
    SELECT ia.path
      FROM sub_segments ss
      JOIN segments s      ON s.id = ss.seg_id
      JOIN image_assets ia ON ia.url = ss.image
     WHERE s.lesson_id = p_lesson_id
  ) x
  WHERE p IS NOT NULL AND p <> 'pending';

  -- The decision. A RESTRICT reference raises 23503 here and the whole call rolls back.
  DELETE FROM lessons WHERE id = p_lesson_id;

  -- Queue only files nothing else still points at (never purge a shared file).
  WITH q AS (
    INSERT INTO storage_purge_queue (bucket, path, reason, source_id)
    SELECT 'lessons', p, 'lesson_delete', p_lesson_id
      FROM unnest(v_paths) AS p
     WHERE NOT EXISTS (SELECT 1 FROM content_images ci WHERE ci.storage_path = p)
       AND NOT EXISTS (SELECT 1 FROM sub_segments ss JOIN image_assets ia ON ia.url = ss.image
                        WHERE ia.path = p)
    ON CONFLICT DO NOTHING
    RETURNING path
  )
  SELECT coalesce(array_agg(path), '{}') INTO v_queued FROM q;

  RETURN jsonb_build_object(
    'found', true,
    'queued_paths', to_jsonb(v_queued),
    'not_queued', cardinality(v_paths) - cardinality(v_queued)
  );
END $$;

REVOKE ALL ON FUNCTION public.delete_lesson(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lesson(uuid) TO service_role;

COMMIT;
```

Today no path is shared (`content_images.storage_path` duplicates: 0, shared `sub_segments.image`: 0, in both projects),
so the "nothing else points at it" filter guards the future rather than any current row.

---

## Item 2 — image width/height

### 2.1 Where images are written and how `image_assets` rows appear

- **The only uploader is `uploadImage`** (`src/storage/upload.ts:20-53`). It re-encodes with sharp to WebP q80, ≤1200 px on the
  long edge, never enlarging (`:29-32`), and **already returns the output `width`/`height`** (`:50-51`) from
  `resolveWithObject`. Callers:
  - `generateSubSegmentImage.ts:257` (generated images) **discards** them.
  - `subSegments.ts:239` (human upload) echoes them in the 201 body (`:285-286`) and stores them nowhere.
- **`image_assets` rows are created only by the storage trigger** `sync_image_assets_from_storage` (AFTER INSERT/UPDATE on
  `storage.objects`, bucket `lessons` only). It upserts `(bucket, path, name, url)` `ON CONFLICT (path)`. **Its body
  hardcodes each project's public URL**, so the two projects' functions differ (Moosii's is from the original setup;
  financial's comes from 087). A migration that rewrites that function would have to differ per project. The design below
  leaves it alone.
- Nothing else writes `image_assets` except the purge's safety-net delete (`purgeImages.ts:55`). The CMS and the app never
  upload to storage (§2.5).
- Current state:

  | | financial | Moosii |
  |---|---|---|
  | `image_assets` rows | 82 | 406 |
  | rows not from `content_images` (legacy/manual) | 0 | 73 |
  | cards whose live `image` is not their own `content_images` file | 0 | 11 |
  | file types in bucket `lessons` | webp | webp, png, jpg, jfif (+ one `.emptyFolderPlaceholder` with no asset row) |
  | objects with `user_metadata` set | 82 (all `{}`) | 396 (all `{}`) |

  **The columns belong on `image_assets`, not `content_images`** (the games FINDINGS proposed `content_images`). Jigsaw
  reads the live image (`sub_segments.image` → `image_assets.url`), and on Moosii 73 assets and 11 live card images have
  no `content_images` row to carry a size.

### 2.2 Proposed: filled in the same statement as the insert

1. **Migration 120**: nullable `width`/`height` on `image_assets`, a CHECK that they are positive and set together, and a
   **BEFORE INSERT OR UPDATE trigger on `image_assets`** that copies `width`/`height` from the storage object's
   `user_metadata` when they're present. The storage trigger's upsert goes through it, so the row is born with its size
   in the same statement. The per-project URL function is untouched.
2. **Code**: `uploadImage` passes `metadata: { width, height }` (the output dims it already has) on `.upload()`
   (storage-js 2.106.2 supports `FileOptions.metadata` → `storage.objects.user_metadata`). It then reads the asset row
   back and, if the size is still null, writes it with a plain UPDATE. **This fallback exists because I haven't verified
   that the Storage API sets `user_metadata` in the INSERT rather than in a later UPDATE.** Either way the trigger catches
   it, since it also fires on UPDATE. The first upload after 120 settles this on financial. `generateSubSegmentImage` needs
   no other change. No response shape changes (the upload route already returns `width`/`height`).
3. **Backfill script** `src/scripts/backfillImageDimensions.ts` (`npm run images:dims -- --project financial|moosii
   [--apply]`). It connects with `FINANCIAL_DB_URL`/`MOOSII_DB_URL` and checks `app_settings.domain` against `--project`
   first (the `demoReset.ts` pattern). For each `image_assets` row with a null size it fetches the **public URL** (the
   bucket is public, so no key is needed) and reads the size with `sharp().metadata()`, honouring EXIF orientation for the
   legacy JPGs (swapping `width`/`height` for orientations 5–8). **Dry-run is the default**: it writes nothing and reports
   total / measured / unparseable / fetch-failed, with the failing paths listed. `--apply` writes in one transaction
   (`UPDATE … WHERE width IS NULL`, so a rerun is a no-op).
4. **Migration 121**: `SET NOT NULL` on both, guarded to RAISE with the count if any row is still unmeasured. **What NOT NULL
   enforces:** any upload to bucket `lessons` that doesn't send `width`/`height` metadata will fail, because the trigger's
   insert breaks the constraint. That covers Supabase-dashboard uploads. Nothing else uploads there today (§2.5), so I read
   this as the intended structural guarantee, but it does change what the dashboard can do.

### 2.3 Draft SQL (DRAFT, not applied)

```sql
-- MIGRATION 120: image_assets width/height (nullable) + fill from storage user_metadata
-- DRAFT (pending apply) · both projects · financial first
BEGIN;

ALTER TABLE public.image_assets
  ADD COLUMN width  integer,
  ADD COLUMN height integer,
  ADD CONSTRAINT image_assets_dimensions_positive CHECK (width > 0 AND height > 0),
  ADD CONSTRAINT image_assets_dimensions_paired   CHECK ((width IS NULL) = (height IS NULL));

-- The storage trigger (sync_image_assets_from_storage, per-project URL, untouched) upserts
-- image_assets; this fills the size from the object's user_metadata in the SAME statement.
-- A row whose object carries no size keeps what it has (NULL until the backfill).
CREATE FUNCTION public.image_assets_fill_dimensions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb;
BEGIN
  SELECT o.user_metadata INTO v_meta
    FROM storage.objects o
   WHERE o.bucket_id = NEW.bucket AND o.name = NEW.path;

  IF coalesce(v_meta->>'width', '')  ~ '^[1-9][0-9]*$'
     AND coalesce(v_meta->>'height', '') ~ '^[1-9][0-9]*$' THEN
    NEW.width  := (v_meta->>'width')::integer;
    NEW.height := (v_meta->>'height')::integer;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.image_assets_fill_dimensions() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER image_assets_fill_dimensions_trg
  BEFORE INSERT OR UPDATE ON public.image_assets
  FOR EACH ROW EXECUTE FUNCTION public.image_assets_fill_dimensions();

COMMIT;
```

```sql
-- MIGRATION 121: image_assets width/height NOT NULL (after the backfill)
-- DRAFT (pending apply) · both projects · financial first · only after the backfill reports 0 unmeasured
BEGIN;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.image_assets WHERE width IS NULL OR height IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '121: % image_assets row(s) have no size; run the backfill (--apply) first', n;
  END IF;
END $$;

ALTER TABLE public.image_assets
  ALTER COLUMN width  SET NOT NULL,
  ALTER COLUMN height SET NOT NULL;

COMMIT;
```

### 2.4 Apply order (each step only after your go)

1. **119**: financial (pre-check, apply, verify), report, then Moosii.
2. **120**: financial, then Moosii.
3. Push the item 1 and item 2 code (it tolerates the old schema: without 120 the fallback UPDATE fails softly and
   logs; without 119 the route returns a clear 500 naming the missing function).
4. One generated or uploaded image on **financial** to see whether `user_metadata` reaches the INSERT (§2.2 step 2).
5. Backfill **dry-run** on financial and Moosii, with the counts reported to you. Then `--apply` on both after your go
   (it writes Moosii data, 406 rows of `image_assets`).
6. **121**: financial, then Moosii.

Numbering: both high-waters are 118 (`migrations/README.md`), so these are 119/120/121 on both projects.

### 2.5 Not in this slice, but it affects Jigsaw

Generated images are capped at **1200 px on the long edge without enlarging** (`upload.ts:17,30`), and generation never
requests an aspect ratio. Jigsaw's "long edge ≥ 1200, aspect 1.6–2.1" rule will therefore pass only images that came
out at exactly 1200 wide and close to 16:9. Once the backfill runs, the actual distribution will show how many qualify.

---

## Other surfaces (checked, not edited)

| Repo | Reads `image_assets`? | Calls `DELETE /lessons/:id`? | Uploads to storage? |
|---|---|---|---|
| moosii-cms | Generated types only (`database.types.ts:1608`, `database_types.ts:2053`). No query | **Yes**: `src/lib/api.ts:137-144` (`planDeleteLesson` dry run + `deleteLesson`), used by `src/pages/LessonsList.tsx:34,610` through `src/pages/DeleteContentModal.tsx` (`:80` handles 409 `unpurgeable_images`) | No (`src/data/images.ts:125` only builds public URLs) |
| moosii-rn | Generated types only (`src/types/database.types.ts:2053`). It reads the image as the `sub_segments.image` URL | No | No |
| moosii-games | Planned reader (Jigsaw) | No | No |

**Follow-ups for the CMS seat** (flagged, not done): show 409 `delete_blocked` in `DeleteContentModal` as its own
state, like `unpurgeable_images`, and treat the `unpurgeable_images` state as dead once item 1 ships. Regenerate its
types after 120 if it ever reads the columns. **For the games seat:** use `image_assets.width/height` through
`sub_segments.image → image_assets.url`, not `content_images`; the `has_game_puzzles` pre-check isn't needed once item 1
ships.
