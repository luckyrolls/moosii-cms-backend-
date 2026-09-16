-- ============================================================================
-- MIGRATION 087: financial — attach the auth.users + storage.objects triggers, create the `lessons`
--   bucket, point image sync at financial's own storage URL — DRAFT (pending apply)   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY: financial was built from a schema-only dump of Moosii's `public` schema. Objects that live in
-- OTHER schemas did not come across, even when the function they call did. Diffed read-only against
-- Moosii on 2026-09-16 (non-public triggers, functions, policies, buckets, cron, publications, event
-- triggers, extensions, roles). App-created objects missing on financial:
--
--   auth.users       new_user_trigger        → create_new_user()                 (creates public."user")
--                    on_auth_user_verified   → handle_user_verification_update() (is_verified)
--                    on_user_update          → update_auth_provider()            (auth_provider)
--   storage.objects  trg_sync_image_assets_from_storage_ins / _upd → sync_image_assets_from_storage()
--                    trg_delete_image_assets_on_storage_delete   → delete_image_assets_on_storage_delete()
--   storage.buckets  `lessons` (public, 50 MB) — the ONLY bucket the backend (src/storage/upload.ts,
--                    purgeImages.ts, routes) and the CMS (src/data/images.ts) use.
--
-- EFFECT TODAY on financial: a sign-up creates no `user` row, so the CMS refuses the account (role and
-- review flags live on `user`) and the app user gets no default track (verified locally 2026-09-16);
-- an uploaded image creates no `image_assets` row, so `sub_segments.image` (FK → image_assets.url)
-- cannot be set and approval returns 409 image_not_linkable; and there is no bucket to upload to.
--
-- THE FUNCTIONS already exist on financial (they are public):
--   * create_new_user / handle_user_verification_update / update_auth_provider are Moosii's logic
--     exactly — financial's copies differ only in CRLF line endings (md5 of the LF-normalised body
--     matches Moosii's). Not touched.
--   * delete_image_assets_on_storage_delete — identical to Moosii. Not touched.
--   * sync_image_assets_from_storage — identical to Moosii, and therefore WRONG here: it hardcodes
--     Moosii's public URL (https://szhihepbqzbbmxybluql.supabase.co/…/lessons/). On financial every
--     image_assets.url would point at the other project, and the backend's approve pre-check (which
--     compares getPublicUrl() on financial) would never match. Replaced below with financial's ref
--     (gwxeaygksankbncptlle); everything else in the body is unchanged. Moosii's copy is untouched.
--
-- create_new_user also copies defaults from public.consts into public.user_configurations. Financial's
-- consts is EMPTY, so no user_configurations row is written (the INSERT … SELECT selects nothing; the
-- sign-up still succeeds). Whether financial needs a consts row is a product decision — not here.
--
-- NOT COPIED (deliberately):
--   * storage policies — Moosii has nine, including two blanket `allow_all` (ALL, role public, no
--     condition) on storage.buckets and storage.objects. The backend uses the service role and the CMS
--     only reads public URLs, so `lessons` needs no policy. Copying `allow_all` would let anyone with the
--     anon key write or delete any object. (Flagged separately for Moosii.)
--   * the other five Moosii buckets (moosi, onboarding, questionnaire_and_quiz, segment.images,
--     transaction-images) — app-side buckets; nothing in this repo or the CMS uses them.
--   * the supabase_realtime publication's 49 tables — the CMS subscribes to nothing; app need unknown.
--   * cron job `purge-cron-history` — per-deployment config (migrations/README.md: scheduled jobs).
--   * Supabase-managed drift (pgsodium, pgjwt, vault/pg_net/pg_cron versions, supabase_functions,
--     supabase_migrations, pgsodium event trigger, platform roles) — not ours to replicate.
--
-- PRIVILEGES (checked 2026-09-16): postgres has TRIGGER on auth.users and storage.objects and INSERT on
-- storage.buckets on financial (and on Moosii, where these triggers already exist).
--
-- ORDER: before 085 — once the auth trigger exists, Mark's sign-up creates his `user` row and 085
-- only updates it (085 is ON CONFLICT DO UPDATE, so either order works).
-- Idempotent: DROP TRIGGER IF EXISTS + CREATE, CREATE OR REPLACE, ON CONFLICT DO NOTHING.
-- APPLY per migrations/README.md: FINANCIAL ONLY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. This is financial — EXPECT 'financial':
--    SELECT value FROM app_settings WHERE key = 'domain';
-- 2. The five functions are the expected bodies — EXPECT create_new_user 9f11a167…, handle_user_verification_update
--    50f434ce…, update_auth_provider 124c91a3…, delete_image_assets_on_storage_delete a1172781…,
--    sync_image_assets_from_storage cda21009… (Moosii's) or b25890d5… (087's, on a re-run):
--    SELECT proname, md5(replace(prosrc, chr(13), '')) FROM pg_proc
--     WHERE pronamespace = 'public'::regnamespace AND proname IN ('create_new_user',
--       'handle_user_verification_update','update_auth_provider',
--       'sync_image_assets_from_storage','delete_image_assets_on_storage_delete') ORDER BY 1;
-- 3. None of the six triggers exists yet, and there is no bucket — EXPECT 0 and 0. (storage.objects
--    already carries Supabase's own protect_objects_delete + update_objects_updated_at; they stay.)
--    SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
--       AND tgrelid IN ('auth.users'::regclass, 'storage.objects'::regclass)
--       AND tgname IN ('new_user_trigger','on_auth_user_verified','on_user_update',
--                      'trg_sync_image_assets_from_storage_ins','trg_sync_image_assets_from_storage_upd',
--                      'trg_delete_image_assets_on_storage_delete');
--    SELECT count(*) FROM storage.buckets;
-- 4. Privileges — EXPECT t, t, t:
--    SELECT has_table_privilege('auth.users','TRIGGER'), has_table_privilege('storage.objects','TRIGGER'),
--           has_table_privilege('storage.buckets','INSERT');
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE bad text;
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '087 is FINANCIAL ONLY: app_settings.domain is %',
      coalesce((SELECT value FROM app_settings WHERE key = 'domain'), '<unset>');
  END IF;

  -- The functions the triggers call must be the logic this file was written against (LF-normalised;
  -- sync_image_assets_from_storage may already be 087's financial version on a re-run).
  SELECT string_agg(e.fn || ' (md5 ' || coalesce(md5(replace(p.prosrc, chr(13), '')), 'MISSING') || ')', ', ')
    INTO bad
    FROM (VALUES
      ('create_new_user',                       ARRAY['9f11a16799b58a6a5a9e571bc3a19a7c']),
      ('handle_user_verification_update',       ARRAY['50f434cee2c121d293fce58239ab5861']),
      ('update_auth_provider',                  ARRAY['124c91a363655811713fd42c5562fc4f']),
      ('delete_image_assets_on_storage_delete', ARRAY['a1172781c7652ec8b52d87a7922197ca']),
      ('sync_image_assets_from_storage',        ARRAY['cda2100918eca999d23bb28c77069819', 'b25890d57428604c67cc2337e3e1bdf5'])
    ) AS e(fn, ok)
    LEFT JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.proname = e.fn
   WHERE p.oid IS NULL OR NOT (md5(replace(p.prosrc, chr(13), '')) = ANY (e.ok));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '087: unexpected trigger function body: % — re-base before applying', bad;
  END IF;
END $$;

-- ---- 1. Sign-up: the three auth.users triggers (definitions exactly as on Moosii) ----
DROP TRIGGER IF EXISTS new_user_trigger ON auth.users;
CREATE TRIGGER new_user_trigger
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.create_new_user();

DROP TRIGGER IF EXISTS on_auth_user_verified ON auth.users;
CREATE TRIGGER on_auth_user_verified
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  WHEN (old.email_confirmed_at IS NULL AND new.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_user_verification_update();

DROP TRIGGER IF EXISTS on_user_update ON auth.users;
CREATE TRIGGER on_user_update
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.update_auth_provider();

-- ---- 2. Image sync: financial's own public URL ----
-- Moosii's body with ONLY the project ref in full_url changed (szhihepbqzbbmxybluql → gwxeaygksankbncptlle).
CREATE OR REPLACE FUNCTION public.sync_image_assets_from_storage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  object_path text;
  filename text;
  display_name text;
  full_url text;
begin
  if new.bucket_id <> 'lessons' then
    return new;
  end if;

  object_path := new.name; -- e.g. "safe_sleep_hero.webp"
  filename := regexp_replace(object_path, '^.*/', '');

  display_name := regexp_replace(filename, '\.[^.]+$', '');
  display_name := replace(display_name, '_', ' ');
  display_name := replace(display_name, '-', ' ');
  display_name := initcap(display_name);

  full_url := 'https://gwxeaygksankbncptlle.supabase.co/storage/v1/object/public/lessons/' || object_path;

  insert into public.image_assets (bucket, path, name, url)
  values (new.bucket_id, object_path, display_name, full_url)
  on conflict (path) do update
    set name = excluded.name,
        url = excluded.url,
        bucket = excluded.bucket,
        updated_at = now();

  return new;
end;
$function$;

-- ---- 3. The three storage.objects triggers (definitions exactly as on Moosii) ----
DROP TRIGGER IF EXISTS trg_sync_image_assets_from_storage_ins ON storage.objects;
CREATE TRIGGER trg_sync_image_assets_from_storage_ins
  AFTER INSERT ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.sync_image_assets_from_storage();

DROP TRIGGER IF EXISTS trg_sync_image_assets_from_storage_upd ON storage.objects;
CREATE TRIGGER trg_sync_image_assets_from_storage_upd
  AFTER UPDATE OF name, bucket_id ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.sync_image_assets_from_storage();

DROP TRIGGER IF EXISTS trg_delete_image_assets_on_storage_delete ON storage.objects;
CREATE TRIGGER trg_delete_image_assets_on_storage_delete
  AFTER DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.delete_image_assets_on_storage_delete();

-- ---- 4. The `lessons` bucket (as on Moosii: public, 50 MB limit, no MIME restriction) ----
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('lessons', 'lessons', true, 52428800)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Writes happen inside a transaction that is ROLLED BACK.
-- 1. Six triggers, definitions matching Moosii's (pg_get_triggerdef); the sync function now names
--    financial's ref and no longer Moosii's; the bucket exists, public, 52428800:
--    SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--     WHERE NOT t.tgisinternal AND t.tgrelid IN ('auth.users'::regclass, 'storage.objects'::regclass) ORDER BY 1, 2;
--    SELECT prosrc LIKE '%gwxeaygksankbncptlle%' AND prosrc NOT LIKE '%szhihepbqzbbmxybluql%'
--      FROM pg_proc WHERE oid = 'public.sync_image_assets_from_storage()'::regprocedure;     -- EXPECT t
--    SELECT id, public, file_size_limit FROM storage.buckets;                                 -- EXPECT lessons | t | 52428800
-- 2. (rolled back) a sign-up creates the user row; verifying flips is_verified; an object in `lessons`
--    creates an image_assets row with financial's URL, and deleting it removes the row:
--    BEGIN;
--      INSERT INTO auth.users (id, email, created_at, raw_app_meta_data, aud, role)
--        VALUES ('0c870000-0000-4000-8000-000000000001', 'zz-verify-087@example.invalid', now(),
--                '{"provider":"email"}', 'authenticated', 'authenticated');
--      SELECT is_verified, auth_provider, role FROM public."user" WHERE id = '0c870000-0000-4000-8000-000000000001';
--                                                                   -- EXPECT f | email | user
--      UPDATE auth.users SET email_confirmed_at = now() WHERE id = '0c870000-0000-4000-8000-000000000001';
--      SELECT is_verified FROM public."user" WHERE id = '0c870000-0000-4000-8000-000000000001';   -- EXPECT t
--      INSERT INTO storage.objects (bucket_id, name) VALUES ('lessons', 'zz_verify_087/zz_verify.webp');
--      SELECT url FROM image_assets WHERE path = 'zz_verify_087/zz_verify.webp';
--        -- EXPECT https://gwxeaygksankbncptlle.supabase.co/storage/v1/object/public/lessons/zz_verify_087/zz_verify.webp
--      SET LOCAL storage.allow_delete_query = 'true';   -- Supabase's protect_objects_delete refuses direct deletes otherwise
--      DELETE FROM storage.objects WHERE bucket_id = 'lessons' AND name = 'zz_verify_087/zz_verify.webp';
--      SELECT count(*) FROM image_assets WHERE path = 'zz_verify_087/zz_verify.webp';          -- EXPECT 0
--    ROLLBACK;
-- ============================================================================
