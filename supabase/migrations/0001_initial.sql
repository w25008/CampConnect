-- Pulse SNS: run once in the Supabase SQL editor or via Supabase migrations.
-- Re-running this script preserves data and refreshes its policies and trigger.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique
    check (handle ~ '^[a-z][a-z0-9_]{2,33}$'),
  display_name text not null
    check (char_length(btrim(display_name)) >= 1 and char_length(display_name) <= 60),
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null
    check (char_length(btrim(body)) >= 1 and char_length(body) <= 500),
  created_at timestamptz not null default now()
);

create table if not exists public.likes (
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null
    check (char_length(btrim(body)) >= 1 and char_length(body) <= 300),
  created_at timestamptz not null default now()
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  primary key (follower_id, following_id),
  constraint follows_no_self_follow check (follower_id <> following_id)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  body text not null
    check (char_length(btrim(body)) >= 1 and char_length(body) <= 1000),
  created_at timestamptz not null default now(),
  constraint direct_messages_no_self_message check (sender_id <> recipient_id)
);

-- Feed, conversations, and non-leading foreign key lookups/deletes.
create index if not exists posts_created_at_idx
  on public.posts (created_at desc, id desc);
create index if not exists posts_author_created_idx
  on public.posts (author_id, created_at desc);
create index if not exists likes_user_id_idx
  on public.likes (user_id);
create index if not exists comments_post_created_idx
  on public.comments (post_id, created_at asc, id asc);
create index if not exists comments_author_id_idx
  on public.comments (author_id);
create index if not exists follows_following_id_idx
  on public.follows (following_id);
create index if not exists direct_messages_sender_created_idx
  on public.direct_messages (sender_id, created_at desc);
create index if not exists direct_messages_recipient_created_idx
  on public.direct_messages (recipient_id, created_at desc);

-- Signup may have a missing, invalid, or already claimed handle. In those cases
-- use a stable handle based on the new user's UUID. No email is made public.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_handle text;
  safe_display_name text;
  fallback_handle text;
begin
  requested_handle := pg_catalog.lower(pg_catalog.btrim(new.raw_user_meta_data ->> 'handle'));
  if requested_handle is null or requested_handle !~ '^[a-z][a-z0-9_]{2,33}$' then
    requested_handle := null;
  end if;

  safe_display_name := pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name');
  if safe_display_name is null or safe_display_name = '' then
    safe_display_name := 'New member';
  end if;
  safe_display_name := pg_catalog.left(safe_display_name, 60);
  fallback_handle := 'u_' || pg_catalog.replace(new.id::text, '-', '');

  if requested_handle is not null then
    insert into public.profiles (id, handle, display_name)
    values (new.id, requested_handle, safe_display_name)
    on conflict (handle) do nothing;
  end if;

  if not exists (select 1 from public.profiles where id = new.id) then
    insert into public.profiles (id, handle, display_name)
    values (new.id, fallback_handle, safe_display_name)
    on conflict (handle) do nothing;
  end if;

  if not exists (select 1 from public.profiles where id = new.id) then
    raise exception 'Could not assign a unique profile handle for user %', new.id;
  end if;

  return new;
end;
$$;

revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.follows enable row level security;
alter table public.direct_messages enable row level security;

-- Explicit table and column privileges, including limits on what a client can
-- supply at INSERT. A user's UUID in a row is also checked by RLS below.
revoke all on public.profiles, public.posts, public.likes,
  public.comments, public.follows, public.direct_messages
  from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (handle, display_name) on public.profiles to authenticated;
grant select on public.posts to authenticated;
grant insert (author_id, body) on public.posts to authenticated;
grant delete on public.posts to authenticated;
grant select on public.likes to authenticated;
grant insert (post_id, user_id) on public.likes to authenticated;
grant delete on public.likes to authenticated;
grant select on public.comments to authenticated;
grant insert (post_id, author_id, body) on public.comments to authenticated;
grant delete on public.comments to authenticated;
grant select on public.follows to authenticated;
grant insert (follower_id, following_id) on public.follows to authenticated;
grant delete on public.follows to authenticated;
grant select on public.direct_messages to authenticated;
grant insert (sender_id, recipient_id, body) on public.direct_messages to authenticated;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (true);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select to authenticated
  using (true);
drop policy if exists posts_insert_self on public.posts;
create policy posts_insert_self on public.posts for insert to authenticated
  with check (author_id = (select auth.uid()));
drop policy if exists posts_delete_self on public.posts;
create policy posts_delete_self on public.posts for delete to authenticated
  using (author_id = (select auth.uid()));

drop policy if exists likes_read on public.likes;
create policy likes_read on public.likes for select to authenticated
  using (true);
drop policy if exists likes_insert_self on public.likes;
create policy likes_insert_self on public.likes for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists likes_delete_self on public.likes;
create policy likes_delete_self on public.likes for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select to authenticated
  using (true);
drop policy if exists comments_insert_self on public.comments;
create policy comments_insert_self on public.comments for insert to authenticated
  with check (author_id = (select auth.uid()));
drop policy if exists comments_delete_self on public.comments;
create policy comments_delete_self on public.comments for delete to authenticated
  using (author_id = (select auth.uid()));

drop policy if exists follows_read on public.follows;
create policy follows_read on public.follows for select to authenticated
  using (true);
drop policy if exists follows_insert_self on public.follows;
create policy follows_insert_self on public.follows for insert to authenticated
  with check (follower_id = (select auth.uid()));
drop policy if exists follows_delete_self on public.follows;
create policy follows_delete_self on public.follows for delete to authenticated
  using (follower_id = (select auth.uid()));

drop policy if exists direct_messages_read_participant on public.direct_messages;
create policy direct_messages_read_participant on public.direct_messages
  for select to authenticated
  using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));
drop policy if exists direct_messages_insert_sender on public.direct_messages;
create policy direct_messages_insert_sender on public.direct_messages
  for insert to authenticated
  with check (sender_id = (select auth.uid()));

-- Aggregate per-post totals on demand so the client does not need to fetch
-- every like and comment. security_invoker applies the caller's table RLS.
create or replace view public.post_counts
with (security_invoker = true)
as
select
  p.id as post_id,
  (select count(*) from public.likes l where l.post_id = p.id) as like_count,
  (select count(*) from public.comments c where c.post_id = p.id) as comment_count
from public.posts p;

revoke all on public.post_counts from public, anon, authenticated;
grant select on public.post_counts to authenticated;
