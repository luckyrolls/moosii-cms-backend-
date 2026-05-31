-- 001_create_jobs_and_content_images.sql
-- Moosii CMS phase 2: async job tracking + content image management.

-- =========================================================================
-- jobs  (created first: content_images references it)
-- =========================================================================
create table jobs (
  id uuid primary key default gen_random_uuid(),

  type text not null,

  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),

  input  jsonb not null default '{}'::jsonb,
  result jsonb,
  error  jsonb,

  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create index jobs_status_started_at_idx on jobs (status, started_at);
create index jobs_created_at_idx         on jobs (created_at desc);

alter table jobs enable row level security;

-- =========================================================================
-- content_images  (generic across lesson / segment / sub_segment owners)
-- =========================================================================
create table content_images (
  id uuid primary key default gen_random_uuid(),

  -- Exactly one owner is set. Only sub_segment_id is used today; the others
  -- are reserved for future lesson-intro and segment images.
  lesson_id      uuid references lessons(id)      on delete cascade,
  segment_id     uuid references segments(id)     on delete cascade,
  sub_segment_id uuid references sub_segments(id) on delete cascade,

  constraint content_images_one_owner check (
    num_nonnulls(lesson_id, segment_id, sub_segment_id) = 1
  ),

  storage_path text not null,

  status text not null default 'candidate'
    check (status in ('candidate', 'approved', 'superseded', 'rejected')),

  image_prompt text not null,
  final_prompt text not null,

  prompt_writer_name      text,
  prompt_writer_version   text,
  image_generator_name    text not null,
  image_generator_version text,

  instruction_version_base    text,
  instruction_version_overlay text,
  topic_name                  text,

  job_id uuid references jobs(id) on delete set null,

  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid
);

create index content_images_lesson_id_idx
  on content_images (lesson_id, created_at desc)
  where lesson_id is not null;

create index content_images_segment_id_idx
  on content_images (segment_id, created_at desc)
  where segment_id is not null;

create index content_images_sub_segment_id_idx
  on content_images (sub_segment_id, created_at desc)
  where sub_segment_id is not null;

create index content_images_job_id_idx on content_images (job_id);

create unique index content_images_one_approved_per_lesson
  on content_images (lesson_id)
  where status = 'approved' and lesson_id is not null;

create unique index content_images_one_approved_per_segment
  on content_images (segment_id)
  where status = 'approved' and segment_id is not null;

create unique index content_images_one_approved_per_sub_segment
  on content_images (sub_segment_id)
  where status = 'approved' and sub_segment_id is not null;

alter table content_images enable row level security;