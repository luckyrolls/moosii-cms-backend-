-- ============================================================================
-- Migration 039: screen_help — per-screen CMS help content (DB-backed, no deploy)
-- ============================================================================
-- WHAT. Backs the CMS's per-screen help: a collapsible panel per screen plus targeted
-- markers on tricky concepts. Help text is CONTENT, not code (same principle as prompts)
-- — it lives in the DB and is edited without a deploy. The CMS reads/writes it
-- Supabase-direct (its convention for config tables); this backend adds NO routes.
--
-- SHAPE. One row per (screen, section):
--   * section_key NULL     => the screen's MAIN collapsible panel (at most one per screen).
--   * section_key non-NULL => a targeted marker on a concept (e.g. 'retroactivity',
--                             'host_vs_target').
-- UNIQUE (screen_key, section_key) with the standard split so NULL sections are still
-- deduped: plain UNIQUE treats NULLs as DISTINCT, so two main panels for one screen would
-- both be allowed. Two partial unique indexes instead —
--   * (screen_key, section_key) WHERE section_key IS NOT NULL  (non-null sections unique)
--   * (screen_key)              WHERE section_key IS NULL       (one main panel per screen)
--
-- updated_by is a plain nullable uuid (the editing admin) — NO FK, matching the loose
-- convention for *_by columns here. The CMS sets updated_at/updated_by on write.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..039 reconciliation list.
-- ============================================================================

begin;

create table if not exists public.screen_help (
  id          uuid        not null default gen_random_uuid(),
  screen_key  text        not null,
  section_key text,                              -- NULL = main panel; non-null = marker
  title       text        not null,
  body        text        not null,              -- markdown
  sort_order  integer     not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  constraint screen_help_pkey primary key (id)
);

-- Non-null sections: unique per (screen, section).
create unique index if not exists screen_help_screen_section_uq
  on public.screen_help (screen_key, section_key)
  where section_key is not null;

-- Main panel (NULL section): at most one per screen (plain UNIQUE won't dedupe NULLs).
create unique index if not exists screen_help_screen_main_uq
  on public.screen_help (screen_key)
  where section_key is null;

commit;
