-- Apply after 0013_group_roster.sql with the Supabase migration role.
-- Storage remove() requires SELECT as well as DELETE on storage.objects.
-- The DELETE policy from 0005_images.sql already limits removal to the
-- caller's user-id folder; allow that same lookup for verified students.
-- Public image URLs continue to use the buckets' existing public setting.
begin;

drop policy if exists campconnect_images_select_own on storage.objects;
create policy campconnect_images_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id in ('avatars', 'post-images')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_verified_student((select auth.uid())))
  );

commit;
