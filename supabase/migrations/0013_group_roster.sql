-- Apply after 0012_reports.sql with the Supabase migration role.
-- The definer must own/bypass RLS on student_group_members so this lookup
-- cannot recursively invoke the roster policy it supports.
begin;

create or replace function public.is_student_group_member(p_group_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = (select auth.uid())
    and public.is_verified_student(p_user_id)
    and exists (
      select 1 from public.student_group_members m
      where m.group_id = p_group_id and m.user_id = p_user_id
    );
$$;
revoke all on function public.is_student_group_member(uuid,uuid) from public, anon, authenticated;
grant execute on function public.is_student_group_member(uuid,uuid) to authenticated;

-- Every current verified member can read their group's complete roster.
-- Removed members and outsiders cannot read any of its membership rows.
drop policy group_members_read on public.student_group_members;
create policy group_members_read on public.student_group_members
  for select to authenticated
  using (public.is_student_group_member(group_id, (select auth.uid())));

commit;
