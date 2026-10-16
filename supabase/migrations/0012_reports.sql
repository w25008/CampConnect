-- Apply after 0011. Students can report a post or comment they can see.
-- Reports are write-only for students: nobody but the project owner (dashboard /
-- service role) can read them. One report per student per item.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment')),
  target_id uuid not null,
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  note text check (char_length(note) <= 300),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);
create index reports_status_idx on public.reports(status, created_at desc);
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

create or replace function public.report_content(
  p_target_type text, p_target_id uuid, p_reason text, p_note text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_post uuid;
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  if p_target_type = 'post' then v_post := p_target_id;
  elsif p_target_type = 'comment' then
    select c.post_id into v_post from public.comments c where c.id = p_target_id;
  else raise exception 'Invalid report target'; end if;
  if v_post is null or not public.can_view_post_id(v_post, auth.uid()) then
    raise exception 'Content not found';
  end if;
  insert into public.reports(reporter_id, target_type, target_id, reason, note)
    values (auth.uid(), p_target_type, p_target_id, p_reason, nullif(btrim(p_note), ''))
    on conflict (reporter_id, target_type, target_id) do nothing;
end;
$$;
revoke all on function public.report_content(text,uuid,text,text) from public, anon;
grant execute on function public.report_content(text,uuid,text,text) to authenticated;
