-- CampConnect: every username (@handle) is the school email ID.
-- e.g. w25009@osfl.ac.jp -> @w25009
-- Run once in the Supabase SQL editor (after 0001-0017). Safe to re-run.
--
-- 1. New sign-ups get their username from their email, no matter what the form sends.
-- 2. Existing members are renamed to their email ID (unless that name is already taken).
-- 3. Members can no longer change their username themselves.

-- Same rule as handleFromEmail() in src/App.jsx: lower-case the part before "@",
-- turn anything that isn't a-z, 0-9 or _ into _, make sure it starts with a letter,
-- and keep it 3-34 characters long (the limit from 0001).
create or replace function public.handle_from_email(email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  h text;
begin
  h := pg_catalog.lower(pg_catalog.split_part(coalesce(email, ''), '@', 1));
  h := pg_catalog.regexp_replace(h, '[^a-z0-9_]', '_', 'g');
  if h !~ '^[a-z]' then
    h := 'u_' || h;
  end if;
  h := pg_catalog.left(h, 34);
  if pg_catalog.char_length(h) < 3 then
    h := pg_catalog.rpad(h, 3, '_');
  end if;
  return h;
end;
$$;

-- Sign-up trigger from 0001, now using the email instead of a username typed in the form.
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
  requested_handle := public.handle_from_email(new.email);
  if requested_handle !~ '^[a-z][a-z0-9_]{2,33}$' then
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

-- Rename existing school members to their email ID. If two people would end up
-- with the same name (very unlikely), neither is renamed and they keep their old one.
with wanted as (
  select p.id, public.handle_from_email(u.email) as new_handle
  from public.profiles p
  join auth.users u on u.id = p.id
  where u.email ilike '%@osfl.ac.jp'
)
update public.profiles p
   set handle = w.new_handle
  from wanted w
 where p.id = w.id
   and p.handle <> w.new_handle
   and w.new_handle ~ '^[a-z][a-z0-9_]{2,33}$'
   and (select count(*) from wanted w2 where w2.new_handle = w.new_handle) = 1
   and not exists (select 1 from public.profiles other where other.handle = w.new_handle and other.id <> p.id);

-- The username now always follows the email, so members can't edit it.
revoke update (handle) on public.profiles from authenticated;
