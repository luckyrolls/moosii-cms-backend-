# 078 local test — RLS on the active-tracks views

Throwaway-Postgres test for `migrations/078_user_active_tracks_rls.sql`, run against a **schema-only
dump of Moosii's `public` schema**, so it exercises the real 354 policies, views and functions rather
than stubs. The dump is not committed; regenerate it (read-only) before running.

```
pg_dump "$MOOSII_DB_URL" --schema-only --schema=public --no-owner --no-comments -f moosii_public_schema.sql
```

Setup on a local cluster (port 55432): create roles `anon`, `authenticated`, `authenticator` and
`service_role BYPASSRLS`; schemas `auth` and `extensions` (`uuid-ossp`); `auth.users (id uuid pk)`;
and `auth.uid()` / `auth.role()` copied verbatim from live (they read `request.jwt.claims`). Restore
the dump — the only expected errors are grants to `supabase_admin`. Then run, in order:
`seed_and_before.sql`, `078_user_active_tracks_rls.sql` (twice, to prove it re-runs), `after.sql`.

Each role check simulates a PostgREST request: `SET LOCAL ROLE` plus `request.jwt.claims`.

Result on 2026-09-14 — the restored schema matched live exactly (function, view and with_reason md5):

- BEFORE 078: anon read all 6 track rows and every user's `user_mlp_data` (incl. profile columns);
  an ordinary user read 4 rows belonging to other users.
- AFTER 078: service/postgres and service_role unchanged; admin and super_admin identical to the
  service; an ordinary user sees only their own rows, identical to the service's view of them, with
  default and fact tracks intact; another user cannot see their facts; anon gets 0 rows from every
  view and the function, without an error; no policy recursion through `is_admin()`.
