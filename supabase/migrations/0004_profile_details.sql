-- CampConnect: extra profile details (school, course, year, gender, birthday, hometown, bio).
-- Run once in the Supabase SQL editor (after 0001-0003). Safe to re-run.
-- Every field is optional. Members can only edit their own profile (profiles_update_self in 0001).

alter table public.profiles
  add column if not exists school text
    check (school in ('gaigo', 'itcollege')),
  add column if not exists course text
    check (char_length(course) <= 80),
  add column if not exists year smallint
    check (year between 1 and 6),
  add column if not exists gender text
    check (gender in ('male', 'female', 'other', 'private')),
  add column if not exists birthday date
    check (birthday >= date '1900-01-01'),
  add column if not exists hometown text
    check (char_length(hometown) <= 80),
  add column if not exists bio text
    check (char_length(bio) <= 300);

grant update (school, course, year, gender, birthday, hometown, bio) on public.profiles to authenticated;
