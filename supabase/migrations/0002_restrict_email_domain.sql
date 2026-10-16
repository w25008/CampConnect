-- CampConnect: only allow sign-ups with a school email address (@osfl.ac.jp).
-- Run once in the Supabase SQL editor. Safe to re-run.
-- The app checks this too, but this trigger is what actually enforces it,
-- because the browser-side check can be bypassed.

create or replace function public.enforce_school_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Existing accounts keep working; only new sign-ups and real email changes are checked.
  if tg_op = 'UPDATE' and new.email is not distinct from old.email then
    return new;
  end if;
  if new.email is null or pg_catalog.lower(new.email) not like '%@osfl.ac.jp' then
    raise exception 'Only @osfl.ac.jp school email addresses can sign up.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_school_email() from public, anon, authenticated;

-- Also fires on email changes, so nobody can switch an account to a non-school address.
drop trigger if exists enforce_school_email on auth.users;
create trigger enforce_school_email
  before insert or update of email on auth.users
  for each row execute function public.enforce_school_email();
