-- 093 proof: picture swap on a clinically approved card. EVERY case runs in its own transaction that
-- is ROLLED BACK — nothing is written.
-- Usage (PGCLIENTENCODING=UTF8):
--   psql "$DB" -X -At -v ON_ERROR_STOP=1 -v seg=<segment uuid> -v fix=0|1 -v body=<file> -f docs/drafts/093-swap-proof.sql
-- fix=1 runs <file> (093's statements without BEGIN/COMMIT) inside each transaction first, so the
-- proof can run before the real apply; fix=0 runs against the database as it is.
-- The segment needs a linkable candidate on every card (the setup approves them like the route).

\set QUIET on
SELECT set_config('proof.seg', :'seg', false) IS NOT NULL AS seg_set \gset
\set setup 'UPDATE sub_segments SET review_state = ''editorial_reviewed'' WHERE seg_id = current_setting(''proof.seg'')::uuid; CREATE TEMP TABLE pi ON COMMIT DROP AS SELECT DISTINCT ON (ci.sub_segment_id) ci.id, ci.sub_segment_id, ci.storage_path, ia.url AS public_url FROM content_images ci JOIN sub_segments ss ON ss.id = ci.sub_segment_id JOIN image_assets ia ON ia.url LIKE ''%/'' || ci.storage_path WHERE ss.seg_id = current_setting(''proof.seg'')::uuid AND ci.status = ''candidate'' AND ci.storage_path <> ''pending'' ORDER BY ci.sub_segment_id, ci.created_at DESC; CREATE TEMP TABLE c ON COMMIT DROP AS SELECT (SELECT id FROM sub_segments WHERE seg_id = current_setting(''proof.seg'')::uuid ORDER BY sequence LIMIT 1) AS card1, (SELECT id FROM auth.users ORDER BY created_at LIMIT 1) AS actor; SELECT ''  setup: fresh images, whole-lesson approve -> bundle says '' || (approve_segment_bundle(current_setting(''proof.seg'')::uuid, (SELECT actor FROM c), (SELECT jsonb_agg(jsonb_build_object(''id'', id, ''public_url'', public_url, ''storage_path'', storage_path)) FROM pi)) ->> ''seg_status'');'
\set show 'SELECT ''  result: card1 '' || (SELECT review_state FROM sub_segments WHERE id = (SELECT card1 FROM c)) || '' | other cards '' || coalesce((SELECT string_agg(review_state || '' '' || n, '', '') FROM (SELECT review_state, count(*) n FROM sub_segments WHERE seg_id = current_setting(''proof.seg'')::uuid AND id <> (SELECT card1 FROM c) GROUP BY 1) x), ''-'') || '' | seg_status '' || (SELECT seg_status FROM segments WHERE id = current_setting(''proof.seg'')::uuid);'
-- A new candidate for card 1 showing another card's picture: a clone of that card's row (provenance
-- included, so the table's CHECKs hold) re-owned by card 1 — a real, linkable image_assets url.
\set newcand 'CREATE TEMP TABLE nc ON COMMIT DROP AS SELECT ci.* FROM content_images ci JOIN pi p ON p.id = ci.id WHERE p.sub_segment_id <> (SELECT card1 FROM c) LIMIT 1; UPDATE nc SET id = gen_random_uuid(), sub_segment_id = (SELECT card1 FROM c), status = ''candidate'', approved_at = NULL, approved_by = NULL; INSERT INTO content_images SELECT * FROM nc;'

\echo '== 0. Fresh images, whole-lesson approve (the 092 case)  EXPECT all clinically_approved, complete'
BEGIN;
\if :fix
\i :body
\endif
:setup
:show
ROLLBACK;

\echo '== 1a. Clinically approved card, SINGLE approve of a different image  EXPECT card1 editorial_reviewed, seg pending'
BEGIN;
\if :fix
\i :body
\endif
:setup
:newcand
SELECT n.id AS cand_id, n.storage_path AS cand_path, p.public_url AS cand_url FROM nc n JOIN pi p ON p.storage_path = n.storage_path LIMIT 1 \gset
SELECT '  approve_content_image -> ' || (approve_content_image(:'cand_id'::uuid, (SELECT actor FROM c), :'cand_url', :'cand_path') ->> 'status');
:show
ROLLBACK;

\echo '== 1b. Clinically approved card, WHOLE-LESSON approve with a different image  EXPECT card1 editorial_reviewed, bundle says pending'
BEGIN;
\if :fix
\i :body
\endif
:setup
:newcand
SELECT n.id AS cand_id, n.storage_path AS cand_path, p.public_url AS cand_url FROM nc n JOIN pi p ON p.storage_path = n.storage_path LIMIT 1 \gset
SELECT '  bundle says ' || (approve_segment_bundle(:'seg', (SELECT actor FROM c),
         jsonb_build_array(jsonb_build_object('id', :'cand_id', 'public_url', :'cand_url', 'storage_path', :'cand_path'))) ->> 'seg_status');
:show
ROLLBACK;

\echo '== 2. Clinically approved cards, WHOLE-LESSON approve with their EXISTING images + same URL re-written  EXPECT all clinically_approved, complete'
BEGIN;
\if :fix
\i :body
\endif
:setup
SELECT '  bundle (existing approved images) says ' || (approve_segment_bundle(:'seg', (SELECT actor FROM c),
         (SELECT jsonb_agg(jsonb_build_object('id', ci.id, 'public_url', ss.image, 'storage_path', ci.storage_path))
            FROM content_images ci JOIN sub_segments ss ON ss.id = ci.sub_segment_id
           WHERE ss.seg_id = :'seg' AND ci.status = 'approved')) ->> 'seg_status');
UPDATE sub_segments SET image = image, image_path = image_path WHERE seg_id = :'seg';
SELECT '  re-wrote the same image on every card';
:show
ROLLBACK;

\echo '== 3. EDITORIAL card, approve a new image  EXPECT card1 still editorial_reviewed'
BEGIN;
\if :fix
\i :body
\endif
:setup
UPDATE sub_segments SET review_state = 'editorial_reviewed' WHERE id = (SELECT card1 FROM c);
SELECT recompute_seg_status(:'seg') IS NOT NULL AS recomputed \gset
:newcand
SELECT n.id AS cand_id, n.storage_path AS cand_path, p.public_url AS cand_url FROM nc n JOIN pi p ON p.storage_path = n.storage_path LIMIT 1 \gset
SELECT '  approve_content_image -> ' || (approve_content_image(:'cand_id'::uuid, (SELECT actor FROM c), :'cand_url', :'cand_path') ->> 'status');
:show
ROLLBACK;

\echo '== 3b. DRAFT card, approve a new image  EXPECT card1 still draft'
BEGIN;
\if :fix
\i :body
\endif
:setup
UPDATE sub_segments SET content = content || ' ' WHERE id = (SELECT card1 FROM c);
:newcand
SELECT n.id AS cand_id, n.storage_path AS cand_path, p.public_url AS cand_url FROM nc n JOIN pi p ON p.storage_path = n.storage_path LIMIT 1 \gset
SELECT '  approve_content_image -> ' || (approve_content_image(:'cand_id'::uuid, (SELECT actor FROM c), :'cand_url', :'cand_path') ->> 'status');
:show
ROLLBACK;

\echo '== 4. Text edit on a clinically approved card  EXPECT card1 draft, others clinically_approved'
BEGIN;
\if :fix
\i :body
\endif
:setup
UPDATE sub_segments SET content = content || ' ' WHERE id = (SELECT card1 FROM c);
:show
ROLLBACK;
