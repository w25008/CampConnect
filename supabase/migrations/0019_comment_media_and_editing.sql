-- Comment photos/GIFs, stickers, and author-only editing.
-- Apply after 0018. Comment images reuse the post-images bucket from 0005.

alter table public.comments
  add column if not exists image_path text,
  add column if not exists sticker_id text;

alter table public.comments alter column body set default '';

alter table public.comments drop constraint if exists comments_image_path_check;
alter table public.comments add constraint comments_image_path_check
  check (image_path is null or char_length(image_path) <= 300);

alter table public.comments drop constraint if exists comments_sticker_id_check;
alter table public.comments add constraint comments_sticker_id_check
  check (sticker_id is null or sticker_id in ('heart', 'laugh', 'party', 'love', 'thumbs-up', 'clap', 'flower', 'sparkles', 'cat', 'rainbow'));

alter table public.comments drop constraint if exists comments_body_check;
alter table public.comments drop constraint if exists comments_body_or_attachment;
alter table public.comments add constraint comments_body_or_attachment check (
  char_length(body) <= 300
  and (
    char_length(btrim(body)) >= 1
    or image_path is not null
    or sticker_id is not null
  )
);

grant update (body, image_path, sticker_id) on public.comments to authenticated;
grant insert (image_path, sticker_id) on public.comments to authenticated;

drop policy if exists comments_insert_self on public.comments;
create policy comments_insert_self on public.comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.can_view_post_id(post_id, (select auth.uid()))
    and (
      image_path is null
      or (
        image_path like (select auth.uid())::text || '/%'
        and exists (
          select 1 from public.posts p
          where p.id = post_id and p.audience = 'school'
        )
      )
    )
  );

drop policy if exists comments_update_self on public.comments;
create policy comments_update_self on public.comments for update to authenticated
  using (author_id = (select auth.uid()) and public.can_view_post_id(post_id, (select auth.uid())))
  with check (
    author_id = (select auth.uid())
    and public.can_view_post_id(post_id, (select auth.uid()))
    and (
      image_path is null
      or (
        image_path like (select auth.uid())::text || '/%'
        and exists (
          select 1 from public.posts p
          where p.id = post_id and p.audience = 'school'
        )
      )
    )
  );
