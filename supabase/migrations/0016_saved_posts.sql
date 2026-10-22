-- Apply after 0015_image_cleanup.sql with the Supabase migration role.
-- Saved rows contain only each student's own post references; posts remain
-- subject to the existing post visibility policy.
begin;

create table public.saved_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index saved_posts_post_idx on public.saved_posts(post_id);

alter table public.saved_posts enable row level security;
revoke all on public.saved_posts from public, anon, authenticated;
grant select, insert, delete on public.saved_posts to authenticated;

create policy saved_posts_read_self on public.saved_posts
  for select to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));
create policy saved_posts_insert_self on public.saved_posts
  for insert to authenticated
  with check (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid()))
    and public.can_view_post_id(post_id, (select auth.uid())));
create policy saved_posts_delete_self on public.saved_posts
  for delete to authenticated
  using (user_id = (select auth.uid())
    and public.is_verified_student((select auth.uid())));

commit;
