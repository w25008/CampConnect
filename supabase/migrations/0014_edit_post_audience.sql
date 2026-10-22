-- Apply after 0013_group_roster.sql with the Supabase migration role.
-- Update a post and its audience recipients atomically.
begin;

create or replace function public.mark_post_edited()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body
     or new.image_path is distinct from old.image_path
     or new.image_paths is distinct from old.image_paths
     or new.audience is distinct from old.audience
     or new.group_id is distinct from old.group_id then
    new.edited_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

create or replace function public.edit_audience_post(
  p_post_id uuid,
  p_body text,
  p_audience text,
  p_user_ids uuid[] default null,
  p_group_id uuid default null,
  p_image_paths text[] default '{}'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts%rowtype;
  v_count integer;
  v_body text := coalesce(btrim(p_body), '');
  v_image_paths text[] := coalesce(p_image_paths, '{}');
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;

  select * into v_post
    from public.posts
    where id = p_post_id and author_id = auth.uid()
    for update;
  if not found then
    raise exception 'Post not found or edit not allowed';
  end if;

  if char_length(v_body) > 500 or
     (v_body = '' and cardinality(v_image_paths) = 0) then
    raise exception 'Post needs text or an image, with at most 500 text characters';
  end if;
  if cardinality(v_image_paths) > 4 or exists (
    select 1 from unnest(v_image_paths) as image_entry(path)
    where image_entry.path is null or char_length(image_entry.path) > 300
      or image_entry.path not like auth.uid()::text || '/%'
  ) then
    raise exception 'Choose up to four images uploaded to your own folder';
  end if;
  if p_audience is null or p_audience not in ('school', 'selected', 'group') then
    raise exception 'Invalid post audience';
  end if;
  if p_audience <> 'school' and cardinality(v_image_paths) > 0 then
    raise exception 'Selected and group posts must be text-only';
  end if;
  if p_audience = 'school' and (p_group_id is not null or p_user_ids is not null) then
    raise exception 'School posts cannot have recipients or a group';
  end if;
  if p_audience = 'group' then
    if p_group_id is null or p_user_ids is not null or not exists (
      select 1 from public.student_group_members m
      where m.group_id = p_group_id and m.user_id = auth.uid()
    ) then
      raise exception 'Group membership required';
    end if;
  end if;
  if p_audience = 'selected' then
    if p_group_id is not null or coalesce(array_length(p_user_ids, 1), 0) = 0
       or array_position(p_user_ids, null) is not null then
      raise exception 'Choose at least one student';
    end if;
    select count(distinct x.user_id) into v_count
      from unnest(p_user_ids) x(user_id)
      where public.is_verified_student(x.user_id) and x.user_id <> auth.uid();
    if v_count <> (
      select count(distinct x.user_id)
        from unnest(p_user_ids) x(user_id)
    ) then
      raise exception 'Recipients must be other verified students';
    end if;
  end if;

  update public.posts
    set body = v_body,
        audience = p_audience,
        group_id = p_group_id,
        image_path = null,
        image_paths = v_image_paths,
        edited_at = pg_catalog.now()
    where id = p_post_id;

  delete from public.post_recipients where post_id = p_post_id;
  if p_audience = 'selected' then
    insert into public.post_recipients(post_id, user_id)
      select p_post_id, x.user_id
        from unnest(p_user_ids) x(user_id)
        group by x.user_id;
  end if;

  return p_post_id;
end;
$$;

revoke all on function public.edit_audience_post(uuid,text,text,uuid[],uuid,text[]) from public, anon;
grant execute on function public.edit_audience_post(uuid,text,text,uuid[],uuid,text[]) to authenticated;

commit;
