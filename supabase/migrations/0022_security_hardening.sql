-- Security hardening. Apply after 0021_leave_and_delete_groups.sql with the
-- Supabase migration role. Existing rows are preserved. Safe to re-run.
--
-- 1. Posts can only be edited through edit_audience_post().
-- 2. A block now also stops follows, likes, comments, selected-audience posts
--    and group invitations between the two students, not just messages.
-- 3. Size limits on encrypted chat data, and per-student rate limits.
-- 4. Read receipts and image replacement require a verified school account.
-- 5. Internal helper functions are no longer callable through the API.
begin;

-- 1. Post edits ---------------------------------------------------------------
-- 0006 let authors UPDATE body/image columns directly. Since 0014 the app
-- edits through edit_audience_post(), which also checks that every image sits
-- in the author's own folder. The direct path skipped that check.
revoke update on public.posts from authenticated;
revoke update (body, image_path, image_paths) on public.posts from authenticated;
drop policy if exists posts_update_self on public.posts;

-- 2. Blocking -----------------------------------------------------------------
-- These run as triggers, so they also cover rows written by the
-- security-definer RPCs (create_audience_post, add_student_group_member, ...).
-- The same message is used everywhere so it does not say who blocked whom.
create or replace function public.users_blocked(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;
revoke all on function public.users_blocked(uuid,uuid) from public, anon, authenticated;

create or replace function public.enforce_block_on_follow()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.users_blocked(new.follower_id, new.following_id) then
    raise exception 'This action is not available for this student.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_block_on_follow() from public, anon, authenticated;
drop trigger if exists enforce_block_on_follow on public.follows;
create trigger enforce_block_on_follow
  before insert on public.follows
  for each row execute function public.enforce_block_on_follow();

-- Likes and comments: the actor and the post's author must not have a block.
-- TG_ARGV[0] names the column that holds the acting student.
create or replace function public.enforce_block_on_post_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (pg_catalog.to_jsonb(new) ->> tg_argv[0])::uuid;
  v_author uuid;
begin
  select p.author_id into v_author from public.posts p where p.id = new.post_id;
  if v_author is not null and v_author <> v_actor
     and public.users_blocked(v_actor, v_author) then
    raise exception 'This action is not available for this student.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_block_on_post_activity() from public, anon, authenticated;
drop trigger if exists enforce_block_on_comment on public.comments;
create trigger enforce_block_on_comment
  before insert on public.comments
  for each row execute function public.enforce_block_on_post_activity('author_id');
drop trigger if exists enforce_block_on_like on public.likes;
create trigger enforce_block_on_like
  before insert on public.likes
  for each row execute function public.enforce_block_on_post_activity('user_id');

-- "Selected students" posts cannot be addressed to someone on either side of a block.
create or replace function public.enforce_block_on_post_recipient()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_author uuid;
begin
  select p.author_id into v_author from public.posts p where p.id = new.post_id;
  if v_author is not null and public.users_blocked(v_author, new.user_id) then
    raise exception 'This action is not available for this student.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_block_on_post_recipient() from public, anon, authenticated;
drop trigger if exists enforce_block_on_post_recipient on public.post_recipients;
create trigger enforce_block_on_post_recipient
  before insert on public.post_recipients
  for each row execute function public.enforce_block_on_post_recipient();

-- A group owner cannot add a student on either side of a block.
create or replace function public.enforce_block_on_group_member()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select g.owner_id into v_owner from public.student_groups g where g.id = new.group_id;
  if v_owner is not null and v_owner <> new.user_id
     and public.users_blocked(v_owner, new.user_id) then
    raise exception 'This action is not available for this student.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_block_on_group_member() from public, anon, authenticated;
drop trigger if exists enforce_block_on_group_member on public.student_group_members;
create trigger enforce_block_on_group_member
  before insert on public.student_group_members
  for each row execute function public.enforce_block_on_group_member();

-- Blocking someone also ends any follow between the two students.
create or replace function public.unfollow_on_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.follows f
   where (f.follower_id = new.blocker_id and f.following_id = new.blocked_id)
      or (f.follower_id = new.blocked_id and f.following_id = new.blocker_id);
  return new;
end;
$$;
revoke all on function public.unfollow_on_block() from public, anon, authenticated;
drop trigger if exists unfollow_on_block on public.user_blocks;
create trigger unfollow_on_block
  after insert on public.user_blocks
  for each row execute function public.unfollow_on_block();

-- 3a. Size limits ---------------------------------------------------------------
-- The app's own values are far smaller: a P-256 public key is about 150 bytes,
-- a key backup about 700, and a message payload a few KB at most. NOT VALID
-- skips checking rows that already exist; every new or changed row is checked.
alter table public.direct_messages drop constraint if exists direct_messages_payload_size;
alter table public.direct_messages add constraint direct_messages_payload_size
  check (encrypted_payload is null or pg_catalog.octet_length(encrypted_payload::text) <= 16384) not valid;
alter table public.chat_public_keys drop constraint if exists chat_public_keys_size;
alter table public.chat_public_keys add constraint chat_public_keys_size
  check (pg_catalog.octet_length(public_key::text) <= 1024) not valid;
alter table public.chat_key_history drop constraint if exists chat_key_history_size;
alter table public.chat_key_history add constraint chat_key_history_size
  check (pg_catalog.octet_length(public_key::text) <= 1024) not valid;
alter table public.chat_key_backups drop constraint if exists chat_key_backups_size;
alter table public.chat_key_backups add constraint chat_key_backups_size
  check (pg_catalog.octet_length(encrypted_private_key::text) <= 8192) not valid;

-- 3b. Rate limits -----------------------------------------------------------------
-- Usage: execute function public.enforce_rate_limit('<owner column>', '<max rows>', '<interval>').
-- Counts the student's own recent rows in the same table. Dashboard and
-- service-role writes (no signed-in user) are not limited.
create or replace function public.enforce_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := (pg_catalog.to_jsonb(new) ->> tg_argv[0])::uuid;
  v_recent integer;
begin
  if auth.uid() is null then
    return new;
  end if;
  execute pg_catalog.format(
    'select count(*) from %I.%I where %I = $1 and created_at > pg_catalog.now() - $2::interval',
    tg_table_schema, tg_table_name, tg_argv[0])
    into v_recent using v_owner, tg_argv[2];
  if v_recent >= tg_argv[1]::integer then
    raise exception 'You are doing that too often. Please wait a moment and try again.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_rate_limit() from public, anon, authenticated;

-- Group chat messages are posts, so the post limit has to allow a conversation.
drop trigger if exists rate_limit_posts on public.posts;
create trigger rate_limit_posts before insert on public.posts
  for each row execute function public.enforce_rate_limit('author_id', '20', '1 minute');
drop trigger if exists rate_limit_comments on public.comments;
create trigger rate_limit_comments before insert on public.comments
  for each row execute function public.enforce_rate_limit('author_id', '20', '1 minute');
drop trigger if exists rate_limit_direct_messages on public.direct_messages;
create trigger rate_limit_direct_messages before insert on public.direct_messages
  for each row execute function public.enforce_rate_limit('sender_id', '40', '1 minute');
drop trigger if exists rate_limit_reports on public.reports;
create trigger rate_limit_reports before insert on public.reports
  for each row execute function public.enforce_rate_limit('reporter_id', '10', '1 hour');

-- 4. Consistent "verified student" checks -----------------------------------------
-- 0007 checked only the email in the session token. Use the same confirmed
-- school-account check as everything else since 0008.
create or replace function public.mark_messages_read(other_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.direct_messages
     set read_at = pg_catalog.now()
   where recipient_id = (select auth.uid())
     and sender_id = other_user
     and read_at is null
     and public.is_verified_student((select auth.uid()));
$$;
revoke all on function public.mark_messages_read(uuid) from public, anon;
grant execute on function public.mark_messages_read(uuid) to authenticated;

-- 0005's replace-image policy had no account check at all.
drop policy if exists campconnect_images_update_own on storage.objects;
create policy campconnect_images_update_own on storage.objects for update to authenticated
  using (
    bucket_id in ('avatars', 'post-images')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_verified_student((select auth.uid())))
  )
  with check (
    bucket_id in ('avatars', 'post-images')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_verified_student((select auth.uid())))
  );

-- 5. Internal functions -------------------------------------------------------------
-- Trigger and helper functions that the browser never needs to call.
revoke all on function public.mark_post_edited() from public, anon, authenticated;
revoke all on function public.handle_from_email(text) from public, anon, authenticated;
-- Supabase's "enable RLS on new tables" event trigger exists on some projects only.
do $$
begin
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

commit;
