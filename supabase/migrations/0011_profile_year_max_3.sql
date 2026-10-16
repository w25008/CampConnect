-- Apply after 0010. Year of study is 1 to 3.
alter table public.profiles drop constraint if exists profiles_year_check;
alter table public.profiles add constraint profiles_year_check check (year >= 1 and year <= 3);
