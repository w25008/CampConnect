-- Apply after 0009. Group photo, stored in the existing avatars bucket under the owner's folder.
alter table public.student_groups
  add column avatar_path text check (char_length(avatar_path) <= 300);

create or replace function public.set_student_group_avatar(p_group_id uuid, p_avatar_path text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) or
     not exists (select 1 from public.student_groups g
                 where g.id = p_group_id and g.owner_id = auth.uid()) then
    raise exception 'Only a verified group owner can edit the group';
  end if;
  if p_avatar_path is not null and (char_length(p_avatar_path) > 300
     or p_avatar_path not like auth.uid()::text || '/%') then
    raise exception 'Photo must be uploaded to your own folder';
  end if;
  update public.student_groups set avatar_path = p_avatar_path where id = p_group_id;
end;
$$;
revoke all on function public.set_student_group_avatar(uuid,text) from public, anon;
grant execute on function public.set_student_group_avatar(uuid,text) to authenticated;
