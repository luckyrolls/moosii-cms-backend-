# RLS sweep list

The backend uses the Supabase **service-role** key and intentionally **bypasses RLS**
(see CLAUDE.md → Secrets discipline). RLS therefore does nothing for *this* service —
it exists to stop the **app's anon/authenticated clients** (which use the anon key)
from reading rows they shouldn't.

This file tracks tables that hold content the app should **not** read directly, so RLS
should be **ENABLED with no anon/public read policy**. A table with RLS *disabled* (or
enabled-but-with-a-permissive-policy) is readable by anyone with the anon key — a leak
for internal/authoring/licensed data.

> Started with migration 036 (source_documents). This is a running list; enabling RLS
> on these is a separate hardening pass (not code in this repo — it's SQL-editor policy
> work), tracked here so nothing content-bearing is forgotten.

## Should be RLS-enabled, NO anon read (internal-only)

| Table | Why | Since |
|---|---|---|
| `source_documents` | Authority/guideline text, possibly licensed (e.g. AAP). Internal review input only — never app-facing. | 036 |
| `lesson_source_documents` | Lesson↔doc linkage; internal review config. | 036 |
| `content_findings` | AI review findings for internal human judgment — not app-facing. | 035 |
| `content_approvals` | Append-only approval/attribution audit (who approved/published what). Written backend-only (service role via `logApproval`); never app-facing. A future CMS read-UI should go through a backend route (or needs an admin read policy — like `screen_help`, not a blanket deny). | 043 |
| `screen_help` | Per-screen CMS help content (panels + concept markers). Internal authoring UI only — the app has no reason to read it. Readable content, admin-writable via the CMS. **CMS-direct — needs an admin POLICY, not blanket-deny (see Notes).** | 039 |

## Notes
- Authoring tables already covered by the app's existing RLS posture (lessons, segments,
  sub_segments, quiz_*, questionnaire_*) are out of scope for this list unless a gap is
  found — this list is for tables introduced by the content-generation backend that the
  app has no reason to read.
- Verifying/enabling RLS is a manual SQL-editor step; add a table here when its migration
  lands, then do the enable pass.
- **Two access patterns on this list — don't lock them the same way:**
  - **Backend-mediated** (`source_documents`, `lesson_source_documents`,
    `content_findings`): only the service-role backend touches them (via routes), and
    service-role bypasses RLS. Safe to `enable row level security` with **NO policy**
    (default-deny) — the backend still works, all clients are shut out.
  - **CMS-direct** (`screen_help`): the CMS reads/writes it with the admin's
    **authenticated** JWT (Supabase-direct), NOT via the backend. A no-policy enable
    would **default-deny the CMS itself and break the feature.** It needs a policy that
    allows internal admins and denies anon/app users, e.g.:
    ```sql
    alter table public.screen_help enable row level security;
    create policy screen_help_admin_all on public.screen_help
      for all to authenticated
      using (exists (select 1 from users_internal ui where ui.id = auth.uid()))
      with check (exists (select 1 from users_internal ui where ui.id = auth.uid()));
    ```
    (Adjust the `users_internal` match to how that table keys to the auth user.)
