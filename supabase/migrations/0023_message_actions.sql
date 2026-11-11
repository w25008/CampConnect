-- Message actions: edit/delete for encrypted direct messages, quote-replies
-- for comments, and quote-replies for group board posts. Apply after
-- 0022_security_hardening.sql with the Supabase migration role. Existing
-- rows are preserved. Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
--
-- 1. DM edit/delete go through security-definer RPCs: direct_messages
--    grants the browser no UPDATE or DELETE at all (0008), and the sender
--    check must not be bypassable by crafting a request. edited_at is set
--    by the server, mirroring posts.edited_at (0006), so it cannot be
--    faked or cleared by the client.
-- 2. Comments gain quoted_comment_id: the app renders the quote by looking
--    the comment up in the same post's already-loaded comment list; the FK
--    clears itself when the quoted comment is deleted, and the app then
--    shows an "original unavailable" placeholder.
-- 3. Group board posts are inserted only through RPCs (client inserts are
--    revoked), so a quoted group post needs its own RPC. The quoted text
--    and author are snapshotted server-side from the quoted post itself —
--    group posts are plaintext on the server already, and a client-supplied
--    snapshot could be forged to quote words someone never wrote.
begin;

-- 1. Direct-message edit / delete ------------------------------------------
alter table public.direct_messages
  add column if not exists edited_at timestamptz;

create or replace function public.edit_direct_message(
  p_message_id uuid, p_encrypted_payload jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  if p_encrypted_payload is null or pg_catalog.jsonb_typeof(p_encrypted_payload) <> 'object'
     or pg_catalog.octet_length(p_encrypted_payload::text) > 16384 then
    raise exception 'Invalid encrypted message';
  end if;
  update public.direct_messages
     set encrypted_payload = p_encrypted_payload,
         edited_at = pg_catalog.now()
   where id = p_message_id
     and sender_id = auth.uid()
     and encryption_version = 1;
  if not found then
    raise exception 'Only the sender can edit an encrypted message';
  end if;
end;
$$;
revoke all on function public.edit_direct_message(uuid,jsonb) from public, anon;
grant execute on function public.edit_direct_message(uuid,jsonb) to authenticated;

create or replace function public.delete_direct_message(p_message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  delete from public.direct_messages
   where id = p_message_id
     and sender_id = auth.uid();
  if not found then
    raise exception 'Only the sender can delete this message';
  end if;
end;
$$;
revoke all on function public.delete_direct_message(uuid) from public, anon;
grant execute on function public.delete_direct_message(uuid) to authenticated;

-- 2. Comment quote-replies ---------------------------------------------------
alter table public.comments
  add column if not exists quoted_comment_id uuid
    references public.comments(id) on delete set null;

-- Column-level INSERT grants accumulate (see 0019): the new column needs
-- its own grant before the browser may include it in an insert. The insert
-- policy itself (comments_insert_self) is unchanged.
grant insert (quoted_comment_id) on public.comments to authenticated;

-- 3. Group board post quote-replies ------------------------------------------
alter table public.posts
  add column if not exists quoted_post_id uuid
    references public.posts(id) on delete set null,
  add column if not exists quoted_body text,
  add column if not exists quoted_author_id uuid
    references public.profiles(id) on delete set null;

alter table public.posts drop constraint if exists posts_quoted_body_check;
alter table public.posts add constraint posts_quoted_body_check
  check (quoted_body is null or char_length(quoted_body) <= 500);

create or replace function public.create_quoted_group_post(
  p_body text, p_group_id uuid, p_quoted_post_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_body text := coalesce(btrim(p_body), '');
        v_quoted_body text; v_quoted_author uuid;
begin
  if not public.is_verified_student(auth.uid()) then
    raise exception 'Verified school account required';
  end if;
  if v_body = '' or char_length(v_body) > 500 then
    raise exception 'Post needs text, with at most 500 characters';
  end if;
  if p_group_id is null or not exists (
    select 1 from public.student_group_members m
    where m.group_id = p_group_id and m.user_id = auth.uid()
  ) then
    raise exception 'Group membership required';
  end if;
  -- The quoted post must be a post in the same group; its body and author
  -- are copied from the stored row, never from the request.
  select q.body, q.author_id into v_quoted_body, v_quoted_author
    from public.posts q
   where q.id = p_quoted_post_id
     and q.audience = 'group'
     and q.group_id = p_group_id;
  if not found then
    raise exception 'The quoted post is not in this group';
  end if;
  insert into public.posts(author_id, body, audience, group_id, image_paths,
                           quoted_post_id, quoted_body, quoted_author_id)
    values (auth.uid(), v_body, 'group', p_group_id, '{}',
            p_quoted_post_id, v_quoted_body, v_quoted_author)
    returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_quoted_group_post(text,uuid,uuid) from public, anon;
grant execute on function public.create_quoted_group_post(text,uuid,uuid) to authenticated;

commit;
