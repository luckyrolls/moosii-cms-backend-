-- 092 proof: approve a whole segment in a transaction that is ALWAYS ROLLED BACK.
-- Usage (PGCLIENTENCODING=UTF8):
--   psql "$DB" -X -At -v ON_ERROR_STOP=1 -v seg=<segment uuid> -v fix=0|1 -f docs/drafts/092-approve-proof.sql
-- fix=1 applies 092's trigger change INSIDE the transaction first (proof before the real apply);
-- fix=0 runs against the database as it is (bug demo before 092, confirmation after it).
-- Writes nothing: every statement sits between BEGIN and ROLLBACK.

\set QUIET on
BEGIN;

SELECT set_config('proof.seg', :'seg', true);

\if :fix
DROP TRIGGER IF EXISTS sub_segments_reset_review_trg ON public.sub_segments;
CREATE TRIGGER sub_segments_reset_review_trg
  AFTER INSERT OR DELETE OR UPDATE OF title, content, sequence
  ON public.sub_segments
  FOR EACH ROW EXECUTE FUNCTION public.sub_segments_reset_review();
\endif

SELECT 'trigger     | ' || pg_get_triggerdef(oid) FROM pg_trigger
 WHERE tgrelid = 'public.sub_segments'::regclass AND tgname = 'sub_segments_reset_review_trg';

-- The route's editorial gate: every card editorial_reviewed first (review_state is not a trigger column).
UPDATE sub_segments SET review_state = 'editorial_reviewed'
 WHERE seg_id = current_setting('proof.seg')::uuid;

-- p_images exactly as POST /lessons/:id/approve builds it: newest non-pending candidate per card,
-- public_url = its image_assets url.
CREATE TEMP TABLE proof_images ON COMMIT DROP AS
SELECT DISTINCT ON (ci.sub_segment_id) ci.id, ci.sub_segment_id, ci.storage_path, ia.url AS public_url
  FROM content_images ci
  JOIN sub_segments ss ON ss.id = ci.sub_segment_id
  JOIN image_assets ia ON ia.url LIKE '%/' || ci.storage_path
 WHERE ss.seg_id = current_setting('proof.seg')::uuid
   AND ci.status = 'candidate' AND ci.storage_path <> 'pending'
 ORDER BY ci.sub_segment_id, ci.created_at DESC;

SELECT 'before      | cards ' || count(*) || ', editorial_reviewed ' ||
       count(*) FILTER (WHERE review_state = 'editorial_reviewed') ||
       ', images to approve ' || (SELECT count(*) FROM proof_images)
  FROM sub_segments WHERE seg_id = current_setting('proof.seg')::uuid;

SELECT 'bundle says | seg_status ' || (r->>'seg_status') || ', images_approved ' || (r->>'images_approved')
  FROM (SELECT approve_segment_bundle(
          current_setting('proof.seg')::uuid,
          (SELECT id FROM auth.users ORDER BY created_at LIMIT 1),
          (SELECT jsonb_agg(jsonb_build_object('id', id, 'public_url', public_url, 'storage_path', storage_path))
             FROM proof_images)) AS r) x;

SELECT 'after       | ' || string_agg(review_state || ' ' || n, ', ' ORDER BY review_state)
  FROM (SELECT review_state, count(*) n FROM sub_segments
         WHERE seg_id = current_setting('proof.seg')::uuid GROUP BY 1) s;
SELECT 'after       | seg_status ' || seg_status || ', cards pointing at the approved image ' ||
       (SELECT count(*) FROM sub_segments ss JOIN proof_images p ON p.sub_segment_id = ss.id
         WHERE ss.image = p.public_url)
  FROM segments WHERE id = current_setting('proof.seg')::uuid;

-- A TEXT edit must still reset that one card (066 unchanged for content).
UPDATE sub_segments SET content = content || ' '
 WHERE id = (SELECT id FROM sub_segments WHERE seg_id = current_setting('proof.seg')::uuid ORDER BY sequence LIMIT 1);
SELECT 'text edit   | draft cards ' || count(*) FILTER (WHERE review_state = 'draft') || ' of ' || count(*) ||
       ', seg_status ' || (SELECT seg_status FROM segments WHERE id = current_setting('proof.seg')::uuid)
  FROM sub_segments WHERE seg_id = current_setting('proof.seg')::uuid;

ROLLBACK;
