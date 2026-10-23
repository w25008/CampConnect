-- Apply after 0016_saved_posts.sql with the Supabase migration role.
-- Collections and their saved-post references are private to each student.
begin;

create table public.saved_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);
create unique index saved_collections_user_name_idx
  on public.saved_collections(user_id, lower(name));

alter table public.saved_posts
  add column collection_id uuid references public.saved_collections(id) on delete set null;

alter table public.saved_collections enable row level security;
revoke all on public.saved_collections from public, anon, authenticated;
grant select, insert, delete on public.saved_collections to authenticated;

create policy saved_collections_read_self on public.saved_collections
  for select to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));
create policy saved_collections_insert_self on public.saved_collections
  for insert to authenticated
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));
create policy saved_collections_delete_self on public.saved_collections
  for delete to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));

drop policy saved_posts_insert_self on public.saved_posts;
create policy saved_posts_insert_self on public.saved_posts
  for insert to authenticated
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid()))
    and public.can_view_post_id(post_id, (select auth.uid()))
    and (collection_id is null or exists (
      select 1 from public.saved_collections c
      where c.id = saved_posts.collection_id
        and c.user_id = (select auth.uid())
    )));

grant update on public.saved_posts to authenticated;
create policy saved_posts_update_self on public.saved_posts
  for update to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())))
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid()))
    and public.can_view_post_id(post_id, (select auth.uid()))
    and (collection_id is null or exists (
      select 1 from public.saved_collections c
      where c.id = saved_posts.collection_id
        and c.user_id = (select auth.uid())
    )));

commit;
