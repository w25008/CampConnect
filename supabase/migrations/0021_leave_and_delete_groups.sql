-- Members can leave a group; the group's owner can delete the whole group.
-- Deleting a group also deletes its memberships and group posts
-- (both reference student_groups with "on delete cascade").

create or replace function public.leave_student_group(p_group_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  if exists (select 1 from public.student_groups g
             where g.id = p_group_id and g.owner_id = auth.uid()) then
    raise exception 'The group owner cannot leave. Delete the group instead.';
  end if;
  delete from public.student_group_members
    where group_id = p_group_id and user_id = auth.uid();
end;
$$;
revoke all on function public.leave_student_group(uuid) from public, anon;
grant execute on function public.leave_student_group(uuid) to authenticated;

-- Returns the group's photo path so the app can remove the image file too.
create or replace function public.delete_student_group(p_group_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_avatar text;
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  delete from public.student_groups
    where id = p_group_id and owner_id = auth.uid()
    returning avatar_path into v_avatar;
  if not found then
    raise exception 'Only the group owner can delete this group';
  end if;
  return v_avatar;
end;
$$;
revoke all on function public.delete_student_group(uuid) from public, anon;
grant execute on function public.delete_student_group(uuid) to authenticated;
