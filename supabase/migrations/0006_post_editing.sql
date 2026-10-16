-- CampConnect: edit your own posts, and up to 4 images per post.
-- Run once in the Supabase SQL editor (after 0005). Safe to re-run.

-- Several images per post. Older single-image posts are copied into the list.
alter table public.posts add column if not exists image_paths text[] not null default '{}';
alter table public.posts drop constraint if exists posts_image_paths_max;
alter table public.posts add constraint posts_image_paths_max check (cardinality(image_paths) <= 4);
update public.posts
  set image_paths = array[image_path]
  where image_path is not null and cardinality(image_paths) = 0;

-- A post needs text or at least one image.
alter table public.posts drop constraint if exists posts_body_or_image;
alter table public.posts add constraint posts_body_or_image check (
  char_length(body) <= 500
  and (char_length(btrim(body)) >= 1 or image_path is not null or cardinality(image_paths) > 0)
);

-- When a post was last edited. Set by the database, so it can't be faked.
alter table public.posts add column if not exists edited_at timestamptz;

create or replace function public.mark_post_edited()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body or new.image_paths is distinct from old.image_paths then
    new.edited_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

drop trigger if exists mark_post_edited on public.posts;
create trigger mark_post_edited
  before update on public.posts
  for each row execute function public.mark_post_edited();

-- Members may edit the text and images of their own posts only.
grant insert (author_id, body, image_path, image_paths) on public.posts to authenticated;
grant update (body, image_path, image_paths) on public.posts to authenticated;

drop policy if exists posts_update_self on public.posts;
create policy posts_update_self on public.posts for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
