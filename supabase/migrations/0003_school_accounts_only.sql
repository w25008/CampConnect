-- CampConnect: only @osfl.ac.jp accounts can read or write anything.
-- Run once in the Supabase SQL editor (after 0001 and 0002). Safe to re-run.
--
-- 0002 blocks new non-school sign-ups, but accounts created before it can still
-- log in. These RESTRICTIVE policies are ANDed with the existing ones, so such
-- accounts see an empty app and cannot post, like, comment, follow or message.

create or replace function public.is_school_user()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.lower(auth.jwt() ->> 'email') like '%@osfl.ac.jp', false);
$$;

revoke all on function public.is_school_user() from public, anon;
grant execute on function public.is_school_user() to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'posts', 'likes', 'comments', 'follows', 'direct_messages'] loop
    execute format('drop policy if exists school_accounts_only on public.%I', t);
    execute format(
      'create policy school_accounts_only on public.%I as restrictive for all to authenticated '
      'using ((select public.is_school_user())) with check ((select public.is_school_user()))', t);
  end loop;
end;
$$;

-- School accounts created before the profile trigger existed have no profile and
-- show up as "Member". Give them one: their sign-up name if any, else the part of
-- the email before the @ (e.g. "w25009"), and a unique placeholder username.
insert into public.profiles (id, handle, display_name)
select
  u.id,
  'u_' || replace(u.id::text, '-', ''),
  left(coalesce(nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''), split_part(u.email, '@', 1)), 60)
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null and u.email ilike '%@osfl.ac.jp'
on conflict do nothing;

-- Optional clean-up. Run these SELECTs to see which accounts are affected, then
-- delete them in Authentication -> Users (or uncomment the DELETE below).
--
-- Accounts that are not school emails:
--   select id, email, created_at from auth.users where email not ilike '%@osfl.ac.jp';
--
-- Accounts still with no profile after the backfill above (non-school ones):
--   select u.id, u.email, u.created_at from auth.users u
--   left join public.profiles p on p.id = u.id where p.id is null;
--
-- Delete all non-school accounts (cannot be undone):
--   delete from auth.users where email not ilike '%@osfl.ac.jp';
