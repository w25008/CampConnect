-- CampConnect: "Seen" receipts for direct messages.
-- Run once in the Supabase SQL editor (after 0003). Safe to re-run.
--
-- read_at is set when the recipient opens the conversation. Members cannot edit
-- messages directly; they can only call mark_messages_read(), which marks messages
-- *sent to them* by one person as read, with the database's own clock.

alter table public.direct_messages add column if not exists read_at timestamptz;

create index if not exists direct_messages_unread_idx
  on public.direct_messages (recipient_id, sender_id)
  where read_at is null;

create or replace function public.mark_messages_read(other_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.direct_messages
     set read_at = pg_catalog.now()
   where recipient_id = (select auth.uid())
     and sender_id = other_user
     and read_at is null
     and (select public.is_school_user());
$$;

revoke all on function public.mark_messages_read(uuid) from public, anon;
grant execute on function public.mark_messages_read(uuid) to authenticated;
