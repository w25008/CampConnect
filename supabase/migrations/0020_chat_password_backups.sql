-- Password-wrapped chat key backups, so signing in can restore E2EE chats
-- without typing the recovery code (which stays as the fallback in
-- chat_key_backups from 0008). Apply after 0019.
--
-- The row holds only PBKDF2 salt + AES-GCM iv/ciphertext of the private key,
-- wrapped in the browser under a key derived from the account password. SQL
-- never receives the password or the plaintext private key. The fingerprint
-- column binds the blob to one chat key: after a key reset the stored blob no
-- longer matches the current key and the client re-creates it.

create table public.chat_password_backups (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  salt text not null,
  iv text not null,
  ciphertext text not null,
  version int not null default 1 check (version = 1),
  public_key_fingerprint text not null check (public_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_password_backups enable row level security;

revoke all on public.chat_password_backups from public, anon, authenticated;
grant select on public.chat_password_backups to authenticated;

-- Owner-only reads, mirroring chat_key_backups_owner_read from 0008: nobody
-- can read another student's wrapped private key.
create policy chat_password_backups_owner_read on public.chat_password_backups for select to authenticated
  using (user_id = (select auth.uid()) and public.is_verified_student((select auth.uid())));

-- Writes go through this function only, mirroring register_chat_identity: no
-- browser role may insert, replace, or delete a backup row directly. The
-- fingerprint must match the account's current recovery-code backup, so a
-- password backup can never point at a key the account does not hold.
create or replace function public.save_chat_password_backup(
  p_salt text, p_iv text, p_ciphertext text, p_version int, p_fingerprint text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid();
begin
  if not public.is_verified_student(v_user_id) then
    raise exception 'Verified school account required';
  end if;
  if p_salt is null or p_iv is null or p_ciphertext is null
     or p_version is distinct from 1
     or p_fingerprint is null or p_fingerprint !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid chat key password backup';
  end if;
  if not exists (
    select 1 from public.chat_key_backups
    where user_id = v_user_id
      and encrypted_private_key ->> 'public_key_fingerprint' = p_fingerprint
  ) then
    raise exception 'Password backup does not match the current chat key';
  end if;
  insert into public.chat_password_backups(
    user_id, salt, iv, ciphertext, version, public_key_fingerprint)
    values (v_user_id, p_salt, p_iv, p_ciphertext, p_version, p_fingerprint)
  on conflict (user_id) do update set
    salt = excluded.salt, iv = excluded.iv, ciphertext = excluded.ciphertext,
    version = excluded.version,
    public_key_fingerprint = excluded.public_key_fingerprint,
    updated_at = now();
end;
$$;
revoke all on function public.save_chat_password_backup(text,text,text,int,text) from public, anon;
grant execute on function public.save_chat_password_backup(text,text,text,int,text) to authenticated;
