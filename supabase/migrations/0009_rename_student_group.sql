-- Apply after 0008. Lets a verified group owner rename their group.
create or replace function public.rename_student_group(p_group_id uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) or
     not exists (select 1 from public.student_groups g
                 where g.id = p_group_id and g.owner_id = auth.uid()) then
    raise exception 'Only a verified group owner can edit the group';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Group name must contain 1 to 80 characters';
  end if;
  update public.student_groups set name = btrim(p_name) where id = p_group_id;
end;
$$;
revoke all on function public.rename_student_group(uuid,text) from public, anon;
grant execute on function public.rename_student_group(uuid,text) to authenticated;
