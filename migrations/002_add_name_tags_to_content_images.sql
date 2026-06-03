-- 002_add_name_tags_to_content_images.sql
-- Adds LLM-generated display metadata to content_images.
-- name: short human-readable label for the image (3–5 words)
-- tags: array of keyword tags for browsing / filtering

alter table content_images
  add column name text,
  add column tags text[] not null default '{}';
