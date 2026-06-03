-- 003_approve_content_image_fn.sql
-- Atomic approval: supersede any existing approved image for the same
-- sub_segment, then approve the target row and update sub_segments.image
-- and sub_segments.image_path.
-- Runs in a single transaction — the partial unique index on approved rows
-- can never be violated even momentarily.

create or replace function approve_content_image(
  p_id           uuid,
  p_approved_by  uuid,   -- nullable; pass null when not provided
  p_public_url   text,
  p_storage_path text
) returns json
language plpgsql
as $$
declare
  v_sub_segment_id uuid;
  v_current_status text;
  v_approved_at    timestamptz;
begin
  -- Lock the target row for the duration of this transaction
  select sub_segment_id, status
  into   v_sub_segment_id, v_current_status
  from   content_images
  where  id = p_id
  for update;

  if not found then
    raise exception 'content_image not found: %', p_id
      using errcode = 'no_data_found';
  end if;

  -- Already approved: idempotent no-op
  if v_current_status = 'approved' then
    select approved_at into v_approved_at
    from   content_images
    where  id = p_id;

    return json_build_object(
      'content_image_id', p_id,
      'sub_segment_id',   v_sub_segment_id,
      'status',           'approved',
      'public_url',       p_public_url,
      'approved_at',      v_approved_at
    );
  end if;

  -- Step 1: supersede any currently approved row for this sub_segment
  --         (must happen before step 2 to avoid violating the unique index)
  update content_images
  set    status = 'superseded'
  where  sub_segment_id = v_sub_segment_id
    and  status = 'approved'
    and  id != p_id;

  -- Step 2: approve this row
  update content_images
  set    status      = 'approved',
         approved_at = now(),
         approved_by = p_approved_by
  where  id = p_id
  returning approved_at into v_approved_at;

  -- Step 3: write the public URL and storage path into sub_segments
  update sub_segments
  set    image      = p_public_url,
         image_path = p_storage_path
  where  id = v_sub_segment_id;

  return json_build_object(
    'content_image_id', p_id,
    'sub_segment_id',   v_sub_segment_id,
    'status',           'approved',
    'public_url',       p_public_url,
    'approved_at',      v_approved_at
  );
end;
$$;
