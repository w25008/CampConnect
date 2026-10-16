-- CampConnect: profile photos and images in posts (Supabase Storage).
-- Run once in the Supabase SQL editor, AFTER 0003 (it uses public.is_school_user()). Safe to re-run.
--
-- Files live in two public buckets. Each member may only upload, replace or delete
-- files inside a folder named after their own user id, e.g. avatars/<user-id>/photo.jpg.
-- The app shrinks images before upload; the 5 MB limit is a safety net.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('post-images', 'post-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists campconnect_images_insert_own on storage.objects;
create policy campconnect_images_insert_own on storage.objects for insert to authenticated
  with check (
    bucket_id in ('avatars', 'post-images')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_school_user())
  );

drop policy if exists campconnect_images_update_own on storage.objects;
create policy campconnect_images_update_own on storage.objects for update to authenticated
  using (bucket_id in ('avatars', 'post-images') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('avatars', 'post-images') and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists campconnect_images_delete_own on storage.objects;
create policy campconnect_images_delete_own on storage.objects for delete to authenticated
  using (bucket_id in ('avatars', 'post-images') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Where each picture is stored (a path inside the bucket, not a full URL).
alter table public.profiles add column if not exists avatar_path text check (char_length(avatar_path) <= 300);
alter table public.posts add column if not exists image_path text check (char_length(image_path) <= 300);

-- A post may now be just a picture: text is optional when an image is attached.
alter table public.posts alter column body set default '';
alter table public.posts drop constraint if exists posts_body_check;
alter table public.posts drop constraint if exists posts_body_or_image;
alter table public.posts add constraint posts_body_or_image check (
  char_length(body) <= 500 and (char_length(btrim(body)) >= 1 or image_path is not null)
);

grant update (avatar_path) on public.profiles to authenticated;
grant insert (author_id, body, image_path) on public.posts to authenticated;
