-- Apply after 0016_saved_posts.sql with the Supabase migration role.
begin;

create table public.saved_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null
    check (char_length(btrim(name)) between 1 and 50),
  created_at timestamptz not null default now()
);
create unique index saved_collections_user_name_idx
  on public.saved_collections(user_id, lower(btrim(name)));

alter table public.saved_posts
  add column collection_id uuid references public.saved_collections(id) on delete set null;
create index saved_posts_collection_idx
  on public.saved_posts(user_id, collection_id);

alter table public.saved_collections enable row level security;
revoke all on public.saved_collections from public, anon, authenticated;
grant select, insert, update, delete on public.saved_collections to authenticated;

create policy saved_collections_read_self on public.saved_collections
  for select to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));
create policy saved_collections_insert_self on public.saved_collections
  for insert to authenticated
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));
create policy saved_collections_update_self on public.saved_collections
  for update to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())))
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));
create policy saved_collections_delete_self on public.saved_collections
  for delete to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));

grant update (collection_id) on public.saved_posts to authenticated;
create policy saved_posts_update_collection_self on public.saved_posts
  for update to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())))
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid()))
    and (collection_id is null or exists (
      select 1
      from public.saved_collections
      where saved_collections.id = saved_posts.collection_id
        and saved_collections.user_id = (select auth.uid())
    )));

commit;
