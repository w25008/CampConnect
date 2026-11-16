-- Apply after 0024_edit_post_requires_visibility.sql with the Supabase
-- migration role. Existing rows are preserved. Safe to re-run.
--
-- 1. Editing a post no longer rewrites its recipient list unless the list or
--    audience actually changed, and a save with no changes does not update the
--    row or mark the post as edited.
-- 2. edited_at is left to the mark_post_edited trigger (0014), except when only
--    the selected recipients changed, which the trigger cannot see.
-- 3. Selected-audience posts can have at most 200 recipients, on create and
--    on edit.
-- 4. Post edits are rate limited: 30 a minute per student.
--
-- edit_audience_post() was last defined in 0024 and create_audience_post() in
-- 0008. Start from this file for any future change to either function.
begin;

-- 4. Edit rate limit ------------------------------------------------------------
-- enforce_rate_limit() (0022) counts recent rows in the table it is attached to,
-- so edits are recorded in a small private table. Rows older than an hour are
-- removed on each edit.
create table if not exists public.post_edit_events (
  id bigint generated always as identity primary key,
  author_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now()
);
create index if not exists post_edit_events_author_idx
  on public.post_edit_events(author_id, created_at);
alter table public.post_edit_events enable row level security;
revoke all on public.post_edit_events from public, anon, authenticated;

drop trigger if exists rate_limit_post_edits on public.post_edit_events;
create trigger rate_limit_post_edits before insert on public.post_edit_events
  for each row execute function public.enforce_rate_limit('author_id', '30', '1 minute');

-- 1-4. Edit function --------------------------------------------------------------
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
  v_recipients_changed boolean := false;
  v_post_changed boolean;
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;

  select * into v_post
    from public.posts
    where id = p_post_id and author_id = auth.uid()
    for update;
  if not found or not public.can_view_post(
    v_post.id, v_post.author_id, v_post.audience,
    v_post.group_id, v_post.created_at, auth.uid()
  ) then
    raise exception 'Post not found or edit not allowed';
  end if;

  delete from public.post_edit_events
    where author_id = auth.uid() and created_at < pg_catalog.now() - interval '1 hour';
  insert into public.post_edit_events(author_id) values (auth.uid());

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
    if cardinality(p_user_ids) > 200 then
      raise exception 'Choose at most 200 students';
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

  -- Recipient rows exist only for 'selected' posts. They need rewriting when
  -- the post moves into or out of 'selected', or when the chosen set differs.
  if v_post.audience = 'selected' or p_audience = 'selected' then
    v_recipients_changed :=
      v_post.audience is distinct from p_audience
      or exists (
        select r.user_id from public.post_recipients r where r.post_id = p_post_id
        except
        select x.user_id from unnest(p_user_ids) x(user_id)
      )
      or exists (
        select x.user_id from unnest(p_user_ids) x(user_id)
        except
        select r.user_id from public.post_recipients r where r.post_id = p_post_id
      );
  end if;

  v_post_changed :=
    v_post.body is distinct from v_body
    or v_post.audience is distinct from p_audience
    or v_post.group_id is distinct from p_group_id
    or v_post.image_path is not null
    or v_post.image_paths is distinct from v_image_paths;

  if v_post_changed or v_recipients_changed then
    -- mark_post_edited stamps edited_at when a post column changes. A change
    -- to the recipients alone does not touch a post column, so stamp it here.
    update public.posts
      set body = v_body,
          audience = p_audience,
          group_id = p_group_id,
          image_path = null,
          image_paths = v_image_paths,
          edited_at = case when v_recipients_changed then pg_catalog.now()
                           else edited_at end
      where id = p_post_id;
  end if;

  if v_recipients_changed then
    delete from public.post_recipients where post_id = p_post_id;
    if p_audience = 'selected' then
      insert into public.post_recipients(post_id, user_id)
        select p_post_id, x.user_id
          from unnest(p_user_ids) x(user_id)
          group by x.user_id;
    end if;
  end if;

  return p_post_id;
end;
$$;

revoke all on function public.edit_audience_post(uuid,text,text,uuid[],uuid,text[]) from public, anon;
grant execute on function public.edit_audience_post(uuid,text,text,uuid[],uuid,text[]) to authenticated;

-- 3. Recipient cap on create --------------------------------------------------------
-- Same as 0008 apart from the 200-recipient limit.
create or replace function public.create_audience_post(
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
declare v_id uuid; v_count integer; v_body text := coalesce(btrim(p_body), '');
        v_image_paths text[] := coalesce(p_image_paths, '{}');
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
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
  if p_audience not in ('school', 'selected', 'group') then
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
    ) then raise exception 'Group membership required'; end if;
  end if;
  if p_audience = 'selected' then
    if p_group_id is not null or coalesce(array_length(p_user_ids, 1), 0) = 0
       or array_position(p_user_ids, null) is not null then
      raise exception 'Choose at least one student';
    end if;
    if cardinality(p_user_ids) > 200 then
      raise exception 'Choose at most 200 students';
    end if;
    select count(distinct x.user_id) into v_count
      from unnest(p_user_ids) x(user_id)
      where public.is_verified_student(x.user_id) and x.user_id <> auth.uid();
    if v_count <> (select count(distinct x.user_id) from unnest(p_user_ids) x(user_id)) then
      raise exception 'Recipients must be other verified students';
    end if;
  end if;
  insert into public.posts(author_id, body, audience, group_id, image_paths)
    values (auth.uid(), v_body, p_audience, p_group_id, v_image_paths)
    returning id into v_id;
  if p_audience = 'selected' then
    insert into public.post_recipients(post_id, user_id)
      select v_id, x.user_id from unnest(p_user_ids) x(user_id)
      group by x.user_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.create_audience_post(text,text,uuid[],uuid,text[]) from public, anon;
grant execute on function public.create_audience_post(text,text,uuid[],uuid,text[]) to authenticated;

commit;
