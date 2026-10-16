-- Apply after 0001_initial.sql. Existing rows are preserved. Run with the
-- Supabase migration role; security-definer helpers must not be owned by a
-- browser-facing role. Email confirmation must remain enabled in Auth.

-- A signed-in account is not a school member until its school inbox is
-- confirmed. The database checks the Auth record, not editable profile data.
create or replace function public.is_verified_student(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user_id
      and u.email_confirmed_at is not null
      and pg_catalog.lower(u.email) ~ '^[^@[:space:]]+@osfl[.]ac[.]jp$'
  );
$$;
revoke all on function public.is_verified_student(uuid) from public, anon;
grant execute on function public.is_verified_student(uuid) to authenticated;

create table public.student_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.student_group_members (
  group_id uuid not null references public.student_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index student_group_members_user_idx on public.student_group_members(user_id, group_id);
create index student_groups_owner_idx on public.student_groups(owner_id);

alter table public.posts
  add column audience text not null default 'school'
    check (audience in ('school', 'selected', 'group')),
  add column group_id uuid references public.student_groups(id) on delete cascade,
  add constraint posts_audience_group_check
    check ((audience = 'group') = (group_id is not null));
create index posts_group_created_idx on public.posts(group_id, created_at desc)
  where audience = 'group';

create table public.post_recipients (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (post_id, user_id)
);
create index post_recipients_user_idx on public.post_recipients(user_id, post_id);

-- The helper accepts row values to avoid policy recursion on posts. Definer
-- access is intentional for membership and recipient lookups only.
create or replace function public.can_view_post(
  p_post_id uuid, p_author_id uuid, p_audience text,
  p_group_id uuid, p_created_at timestamptz, p_viewer_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select p_viewer_id = auth.uid() and public.is_verified_student(p_viewer_id)
    and (
      (p_author_id = p_viewer_id and p_audience <> 'group')
      or p_audience = 'school'
      or (p_audience = 'selected' and exists (
        select 1 from public.post_recipients r
        where r.post_id = p_post_id and r.user_id = p_viewer_id
      ))
      or (p_audience = 'group' and exists (
        select 1 from public.student_group_members m
        where m.group_id = p_group_id and m.user_id = p_viewer_id
          and m.joined_at <= p_created_at
      ))
    );
$$;
revoke all on function public.can_view_post(uuid,uuid,text,uuid,timestamptz,uuid) from public, anon;
grant execute on function public.can_view_post(uuid,uuid,text,uuid,timestamptz,uuid) to authenticated;

create or replace function public.can_view_post_id(p_post_id uuid, p_viewer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select public.can_view_post(p.id, p.author_id, p.audience,
      p.group_id, p.created_at, p_viewer_id)
    from public.posts p where p.id = p_post_id
  ), false);
$$;
revoke all on function public.can_view_post_id(uuid,uuid) from public, anon;
grant execute on function public.can_view_post_id(uuid,uuid) to authenticated;

alter table public.student_groups enable row level security;
alter table public.student_group_members enable row level security;
alter table public.post_recipients enable row level security;
revoke all on public.student_groups, public.student_group_members,
  public.post_recipients from public, anon, authenticated;
grant select on public.student_groups, public.student_group_members,
  public.post_recipients to authenticated;

create policy student_groups_read on public.student_groups for select to authenticated
  using (public.is_verified_student((select auth.uid())) and exists (
    select 1 from public.student_group_members m
    where m.group_id = id and m.user_id = (select auth.uid())
  ));
create or replace function public.is_student_group_owner(p_group_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = auth.uid() and exists (
    select 1 from public.student_groups g
    where g.id = p_group_id and g.owner_id = p_user_id);
$$;
revoke all on function public.is_student_group_owner(uuid,uuid) from public, anon;
grant execute on function public.is_student_group_owner(uuid,uuid) to authenticated;
create policy group_members_read on public.student_group_members for select to authenticated
  using (public.is_verified_student((select auth.uid())) and (
    user_id = (select auth.uid())
    or public.is_student_group_owner(group_id, (select auth.uid()))
  ));
create policy post_recipients_read on public.post_recipients for select to authenticated
  using (public.is_verified_student((select auth.uid())) and (
    user_id = (select auth.uid()) or exists (
      select 1 from public.posts p
      where p.id = post_id and p.author_id = (select auth.uid())
    )
  ));

-- All membership mutations are atomic RPCs. Removing a member deletes the
-- active membership; reinviting starts a new join time and cannot reveal old
-- group posts. A former member's already saved copies cannot be revoked.
create or replace function public.create_student_group(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_now timestamptz := statement_timestamp();
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Group name must contain 1 to 80 characters';
  end if;
  insert into public.student_groups(name, owner_id, created_at)
    values (btrim(p_name), auth.uid(), v_now) returning id into v_id;
  insert into public.student_group_members(group_id, user_id, joined_at)
    values (v_id, auth.uid(), v_now);
  return v_id;
end;
$$;
revoke all on function public.create_student_group(text) from public, anon;
grant execute on function public.create_student_group(text) to authenticated;

create or replace function public.add_student_group_member(p_group_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) or
     not public.is_verified_student(p_user_id) or
     not exists (select 1 from public.student_groups g
                 where g.id = p_group_id and g.owner_id = auth.uid()) then
    raise exception 'Only a verified group owner can add verified students';
  end if;
  insert into public.student_group_members(group_id, user_id)
    values (p_group_id, p_user_id) on conflict do nothing;
end;
$$;
revoke all on function public.add_student_group_member(uuid,uuid) from public, anon;
grant execute on function public.add_student_group_member(uuid,uuid) to authenticated;

create or replace function public.remove_student_group_member(p_group_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) or
     not exists (select 1 from public.student_groups g
                 where g.id = p_group_id and g.owner_id = auth.uid()) then
    raise exception 'Only a verified group owner can remove members';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'A group owner cannot remove themselves';
  end if;
  delete from public.student_group_members
    where group_id = p_group_id and user_id = p_user_id;
end;
$$;
revoke all on function public.remove_student_group_member(uuid,uuid) from public, anon;
grant execute on function public.remove_student_group_member(uuid,uuid) to authenticated;

-- One transaction creates the post and its exact selected audience. The
-- author is always able to see their own post. Client inserts are revoked.
create or replace function public.create_audience_post(
  p_body text, p_audience text, p_user_ids uuid[] default null, p_group_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_count integer;
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 500 then
    raise exception 'Post must contain 1 to 500 characters';
  end if;
  if p_audience not in ('school', 'selected', 'group') then
    raise exception 'Invalid post audience';
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
    select count(distinct x.user_id) into v_count
      from unnest(p_user_ids) x(user_id)
      where public.is_verified_student(x.user_id) and x.user_id <> auth.uid();
    if v_count <> (select count(distinct x.user_id) from unnest(p_user_ids) x(user_id)) then
      raise exception 'Recipients must be other verified students';
    end if;
  end if;
  insert into public.posts(author_id, body, audience, group_id)
    values (auth.uid(), btrim(p_body), p_audience, p_group_id)
    returning id into v_id;
  if p_audience = 'selected' then
    insert into public.post_recipients(post_id, user_id)
      select v_id, x.user_id from unnest(p_user_ids) x(user_id)
      group by x.user_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.create_audience_post(text,text,uuid[],uuid) from public, anon;
grant execute on function public.create_audience_post(text,text,uuid[],uuid) to authenticated;

-- Replace permissive policies from 0001. Related rows are visible only when
-- their parent post remains visible. The security-invoker count view inherits
-- these rules automatically.
drop policy profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_verified_student((select auth.uid())) and public.is_verified_student(id));
drop policy profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()) and public.is_verified_student((select auth.uid())))
  with check (id = (select auth.uid()) and public.is_verified_student((select auth.uid())));
drop policy posts_read on public.posts;
create policy posts_read on public.posts for select to authenticated
  using (public.can_view_post(id, author_id, audience, group_id, created_at, (select auth.uid())));
drop policy posts_insert_self on public.posts;
revoke insert on public.posts from authenticated;
drop policy posts_delete_self on public.posts;
create policy posts_delete_self on public.posts for delete to authenticated
  using (author_id = (select auth.uid()) and
    public.can_view_post(id, author_id, audience, group_id, created_at, (select auth.uid())));
drop policy likes_read on public.likes;
create policy likes_read on public.likes for select to authenticated
  using (public.can_view_post_id(post_id, (select auth.uid())));
drop policy likes_insert_self on public.likes;
create policy likes_insert_self on public.likes for insert to authenticated
  with check (user_id = (select auth.uid()) and public.can_view_post_id(post_id, (select auth.uid())));
drop policy likes_delete_self on public.likes;
create policy likes_delete_self on public.likes for delete to authenticated
  using (user_id = (select auth.uid()) and public.can_view_post_id(post_id, (select auth.uid())));
drop policy comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated
  using (public.can_view_post_id(post_id, (select auth.uid())));
drop policy comments_insert_self on public.comments;
create policy comments_insert_self on public.comments for insert to authenticated
  with check (author_id = (select auth.uid()) and public.can_view_post_id(post_id, (select auth.uid())));
drop policy comments_delete_self on public.comments;
create policy comments_delete_self on public.comments for delete to authenticated
  using (author_id = (select auth.uid()) and public.can_view_post_id(post_id, (select auth.uid())));
drop policy follows_read on public.follows;
create policy follows_read on public.follows for select to authenticated
  using (public.is_verified_student((select auth.uid())));
drop policy follows_insert_self on public.follows;
create policy follows_insert_self on public.follows for insert to authenticated
  with check (follower_id = (select auth.uid())
    and public.is_verified_student((select auth.uid()))
    and public.is_verified_student(following_id));
drop policy follows_delete_self on public.follows;
create policy follows_delete_self on public.follows for delete to authenticated
  using (follower_id = (select auth.uid()) and public.is_verified_student((select auth.uid())));

-- Separate public keys and private backups so a SELECT policy cannot reveal
-- another student's wrapped private key. The backup is ciphertext supplied by
-- the client; SQL never receives the recovery code or plaintext private key.
create table public.chat_public_keys (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  public_key jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.chat_key_backups (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  encrypted_private_key jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Retain old public keys after a reset. A student who loses their private key
-- loses their own old chat history, but the other participant can still use
-- these public keys to decrypt their own copy of older messages.
create table public.chat_key_history (
  user_id uuid not null references public.profiles(id) on delete cascade,
  fingerprint text not null check (fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  public_key jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, fingerprint)
);
alter table public.chat_public_keys enable row level security;
alter table public.chat_key_backups enable row level security;
alter table public.chat_key_history enable row level security;
revoke all on public.chat_public_keys, public.chat_key_backups,
  public.chat_key_history from public, anon, authenticated;
grant select on public.chat_public_keys to authenticated;
grant select on public.chat_key_backups to authenticated;
grant select on public.chat_key_history to authenticated;
create policy chat_public_keys_read on public.chat_public_keys for select to authenticated
  using (public.is_verified_student((select auth.uid())) and public.is_verified_student(user_id));
create policy chat_key_backups_owner_read on public.chat_key_backups for select to authenticated
  using (user_id = (select auth.uid()) and public.is_verified_student((select auth.uid())));
create policy chat_key_history_read on public.chat_key_history for select to authenticated
  using (public.is_verified_student((select auth.uid())) and public.is_verified_student(user_id));

-- Both halves of a chat identity are committed together. No browser role may
-- insert, replace, or delete either key row directly. MVP keys are immutable:
-- rotation requires a separately designed protocol for existing messages.
create or replace function public.register_chat_identity(
  p_public_key jsonb, p_encrypted_private_key jsonb, p_fingerprint text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid();
begin
  if not public.is_verified_student(v_user_id) then
    raise exception 'Verified school account required';
  end if;
  if p_public_key is null or jsonb_typeof(p_public_key) <> 'object'
     or p_encrypted_private_key is null
     or jsonb_typeof(p_encrypted_private_key) <> 'object'
     or p_fingerprint is null or p_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
     or p_encrypted_private_key ->> 'public_key_fingerprint' is distinct from p_fingerprint then
    raise exception 'Public key and encrypted private-key backup must be objects';
  end if;
  if exists (select 1 from public.chat_public_keys where user_id = v_user_id)
     or exists (select 1 from public.chat_key_backups where user_id = v_user_id) then
    raise exception 'Chat identity already exists; key replacement is disabled';
  end if;
  insert into public.chat_public_keys(user_id, public_key)
    values (v_user_id, p_public_key);
  insert into public.chat_key_backups(user_id, encrypted_private_key)
    values (v_user_id, p_encrypted_private_key);
  insert into public.chat_key_history(user_id, fingerprint, public_key)
    values (v_user_id, p_fingerprint, p_public_key);
end;
$$;
revoke all on function public.register_chat_identity(jsonb,jsonb,text) from public, anon;
grant execute on function public.register_chat_identity(jsonb,jsonb,text) to authenticated;

-- Account recovery cannot recover lost old private keys. A verified student
-- may start a fresh identity so future messages work. History stays append-only.
create or replace function public.reset_chat_identity(
  p_public_key jsonb, p_encrypted_private_key jsonb, p_fingerprint text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid();
begin
  if not public.is_verified_student(v_user_id) then
    raise exception 'Verified school account required';
  end if;
  if p_public_key is null or jsonb_typeof(p_public_key) <> 'object'
     or p_encrypted_private_key is null
     or jsonb_typeof(p_encrypted_private_key) <> 'object'
     or p_fingerprint is null or p_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
     or p_encrypted_private_key ->> 'public_key_fingerprint' is distinct from p_fingerprint then
    raise exception 'Invalid chat identity';
  end if;
  if not exists (select 1 from public.chat_public_keys where user_id = v_user_id)
     or not exists (select 1 from public.chat_key_backups where user_id = v_user_id) then
    raise exception 'Chat identity is not registered';
  end if;
  if exists (select 1 from public.chat_key_history
             where user_id = v_user_id and fingerprint = p_fingerprint) then
    raise exception 'This chat key was already registered';
  end if;
  update public.chat_public_keys set public_key = p_public_key, updated_at = now()
    where user_id = v_user_id;
  update public.chat_key_backups set encrypted_private_key = p_encrypted_private_key,
    updated_at = now() where user_id = v_user_id;
  insert into public.chat_key_history(user_id, fingerprint, public_key)
    values (v_user_id, p_fingerprint, p_public_key);
end;
$$;
revoke all on function public.reset_chat_identity(jsonb,jsonb,text) from public, anon;
grant execute on function public.reset_chat_identity(jsonb,jsonb,text) to authenticated;

-- Legacy version 0 rows remain readable only to participants. Version 1 rows
-- contain no plaintext body. New browser writes may only create version 1.
alter table public.direct_messages alter column body drop not null;
alter table public.direct_messages drop constraint if exists direct_messages_body_check;
alter table public.direct_messages add column encryption_version integer not null default 0;
alter table public.direct_messages add column encrypted_payload jsonb;
alter table public.direct_messages add constraint direct_messages_encryption_shape check (
  (encryption_version = 0 and body is not null and encrypted_payload is null)
  or (encryption_version = 1 and body is null and encrypted_payload is not null
      and jsonb_typeof(encrypted_payload) = 'object')
);
revoke insert on public.direct_messages from authenticated;
grant insert (sender_id, recipient_id, encryption_version, encrypted_payload)
  on public.direct_messages to authenticated;
drop policy direct_messages_read_participant on public.direct_messages;
create policy direct_messages_read_participant on public.direct_messages
  for select to authenticated using (
    public.is_verified_student((select auth.uid())) and
    (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()))
  );
drop policy direct_messages_insert_sender on public.direct_messages;
create policy direct_messages_insert_sender on public.direct_messages
  for insert to authenticated with check (
    sender_id = (select auth.uid()) and encryption_version = 1 and body is null
    and public.is_verified_student((select auth.uid()))
    and public.is_verified_student(recipient_id)
  );

-- Blocking is server-enforced for new messages. A student's own blocks are
-- private; the blocked student does not receive an enumeratable list.
create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on public.user_blocks(blocked_id, blocker_id);
alter table public.user_blocks enable row level security;
revoke all on public.user_blocks from public, anon, authenticated;
grant select on public.user_blocks to authenticated;
grant insert (blocker_id, blocked_id) on public.user_blocks to authenticated;
grant delete on public.user_blocks to authenticated;
create policy user_blocks_own_read on public.user_blocks for select to authenticated
  using (blocker_id = (select auth.uid()) and public.is_verified_student((select auth.uid())));
create policy user_blocks_own_insert on public.user_blocks for insert to authenticated
  with check (blocker_id = (select auth.uid()) and public.is_verified_student((select auth.uid()))
    and public.is_verified_student(blocked_id));
create policy user_blocks_own_delete on public.user_blocks for delete to authenticated
  using (blocker_id = (select auth.uid()) and public.is_verified_student((select auth.uid())));
create or replace function public.is_blocked_pair(p_sender uuid, p_recipient uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (p_sender = auth.uid() or p_recipient = auth.uid())
    and exists (select 1 from public.user_blocks b
    where (b.blocker_id = p_sender and b.blocked_id = p_recipient)
       or (b.blocker_id = p_recipient and b.blocked_id = p_sender));
$$;
revoke all on function public.is_blocked_pair(uuid,uuid) from public, anon;
grant execute on function public.is_blocked_pair(uuid,uuid) to authenticated;
drop policy direct_messages_insert_sender on public.direct_messages;
create policy direct_messages_insert_sender on public.direct_messages
  for insert to authenticated with check (
    sender_id = (select auth.uid()) and encryption_version = 1 and body is null
    and public.is_verified_student((select auth.uid()))
    and public.is_verified_student(recipient_id)
    and not public.is_blocked_pair(sender_id, recipient_id)
  );
