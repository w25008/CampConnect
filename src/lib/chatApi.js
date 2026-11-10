import {
  createChatIdentity, restoreChatIdentity, decryptBackupPrivateJwk, encryptDirectMessage,
  decryptDirectMessage, fingerprintPublicKey, messageKeyReferences, saveLocalChatIdentity,
  loadLocalChatIdentity, clearLocalChatIdentity,
  savePendingRecoveryCode, loadPendingRecoveryCode, clearPendingRecoveryCode,
} from './e2ee.js';
import { wrapPrivateKey, unwrapPrivateKey, PasswordBackupError } from './keyBackup.js';

export { PasswordBackupError };

// The password-backup table arrives with migration 0020, which the team runs
// manually in Supabase. Until then every query against it fails; treat that
// as "feature not available yet" and fall back to the recovery-code flow
// instead of surfacing an error.
function isMissingPasswordBackupTable(error) {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === '42P01') return true;
  return /chat_password_backups/.test(error.message || '') &&
    /does not exist|Could not find/i.test(error.message || '');
}

async function passwordBackupRow(supabase, userId) {
  const { data, error } = await supabase.from('chat_password_backups')
    .select('salt,iv,ciphertext,version,public_key_fingerprint')
    .eq('user_id', userId).maybeSingle();
  if (error) {
    if (isMissingPasswordBackupTable(error)) return { available: false, row: null };
    throw error;
  }
  return { available: true, row: data || null };
}

// 'current' = backup exists for the account's present chat key; 'stale' =
// backup exists but for a previous key (e.g. after a reset); 'none' = no
// backup yet; 'unavailable' = migration 0020 has not been applied.
export async function passwordBackupStatus(supabase, userId, fingerprint) {
  const { available, row } = await passwordBackupRow(supabase, userId);
  if (!available) return 'unavailable';
  if (!row) return 'none';
  return row.public_key_fingerprint === fingerprint ? 'current' : 'stale';
}

async function savePasswordBackup(supabase, userId, publicKey, privateJwk, password, recoveryCode = '') {
  if (!password) return false;
  try {
    const blob = await wrapPrivateKey(privateJwk, userId, publicKey, password, recoveryCode);
    const { error } = await supabase.rpc('save_chat_password_backup', {
      p_salt: blob.salt, p_iv: blob.iv, p_ciphertext: blob.ciphertext,
      p_version: blob.version, p_fingerprint: blob.public_key_fingerprint,
    });
    if (error) {
      if (isMissingPasswordBackupTable(error)) return false;
      throw error;
    }
    return true;
  } catch (error) {
    if (isMissingPasswordBackupTable(error)) return false;
    throw error;
  }
}

// Create or refresh the password backup from a just-recovered private JWK.
// Used after a recovery-code restore performed while the account password is
// known (fresh sign-in), which is also how a backup stranded by an email
// password reset becomes usable again under the new password. The code the
// user just typed is passed explicitly; without it, a still-pending code
// from identity creation on this device is tried.
export async function refreshPasswordBackupAfterRestore(supabase, userId, identity, password, recoveryCode = '') {
  if (!password || !identity?.publicKey || !identity?.encryptedPrivateKey) return false;
  try {
    const code = recoveryCode || identity.recoveryCode ||
      await loadPendingRecoveryCode(userId, identity.publicKey).catch(() => '');
    if (!code) return false;
    const privateJwk = await decryptBackupPrivateJwk(
      userId, identity.encryptedPrivateKey, code, identity.publicKey);
    return savePasswordBackup(supabase, userId, identity.publicKey, privateJwk, password, code);
  } catch { return false; }
}

// Set up (or refresh) the password backup when the user enters their
// recovery code by hand, e.g. from the "turn on password restore" prompt
// shown to an already-restored identity whose sign-in password was not
// captured this session. Verifying the code first means a mistyped code
// cannot create a backup for the wrong key.
export async function createPasswordBackupFromCode(supabase, userId, recoveryCode, password) {
  const identity = await loadChatIdentity(supabase, userId);
  if (!identity.publicKey || !identity.encryptedPrivateKey) {
    throw new Error('No chat key backup exists for this account.');
  }
  const privateJwk = await decryptBackupPrivateJwk(
    userId, identity.encryptedPrivateKey, recoveryCode, identity.publicKey);
  return savePasswordBackup(supabase, userId, identity.publicKey, privateJwk, password, recoveryCode);
}

// Restore the chat identity with the account password instead of the
// recovery code. Returns null when no usable backup exists (none, stale, or
// table missing) so the caller can fall back to the code; throws
// PasswordBackupError when a backup exists but the password is wrong.
export async function recoverChatIdentityWithPassword(supabase, userId, password) {
  const identity = await loadChatIdentity(supabase, userId);
  if (identity.status === 'ready') return identity;
  if (!identity.publicKey) return null;
  const { available, row } = await passwordBackupRow(supabase, userId);
  if (!available || !row) return null;
  if (row.public_key_fingerprint !== identity.fingerprint) return null;
  const { privateKey } = await unwrapPrivateKey(row, userId, identity.publicKey, password);
  await saveLocalChatIdentity(userId, privateKey, identity.publicKey);
  return { ...identity, status: 'ready', privateKey, recoveryCode: '' };
}

// Reveal the recovery code from the Profile page. The creation panel that
// used to show the code once is gone, so the code must stay retrievable:
//   1. A v2 password backup stores the code inside its encrypted payload —
//      unwrap it with the account password and return the code.
//   2. Older v1 backups never stored the code. If this device still holds
//      the pending code from creation (IndexedDB), verify it against the
//      code-wrapped backup, upgrade the password backup to v2 with the
//      password just entered, and return the code.
//   3. Otherwise return { status: 'needs-code' } so the UI can ask for the
//      code once (createPasswordBackupFromCode then stores it in a v2
//      backup, and the typed code itself is what gets shown).
// A wrong password against an existing backup throws PasswordBackupError.
export async function revealRecoveryCode(supabase, userId, password) {
  const identity = await loadChatIdentity(supabase, userId);
  if (!identity.publicKey || !identity.encryptedPrivateKey) return { status: 'no-identity' };
  const { available, row } = await passwordBackupRow(supabase, userId);
  if (available && row && row.public_key_fingerprint === identity.fingerprint) {
    const { privateJwk, recoveryCode } = await unwrapPrivateKey(row, userId, identity.publicKey, password);
    if (recoveryCode) return { status: 'ok', recoveryCode };
    // v1 backup: fall through to the local pending code, and upgrade below.
    var v1PrivateJwk = privateJwk;
  }
  const pending = await loadPendingRecoveryCode(userId, identity.publicKey).catch(() => '');
  if (pending) {
    // Verify the local code really opens this account's code-wrapped backup
    // before showing it or baking it into a password backup.
    const privateJwk = v1PrivateJwk || await decryptBackupPrivateJwk(
      userId, identity.encryptedPrivateKey, pending, identity.publicKey);
    if (password) {
      await savePasswordBackup(supabase, userId, identity.publicKey, privateJwk, password, pending)
        .catch(() => false);
    }
    return { status: 'ok', recoveryCode: pending };
  }
  return { status: 'needs-code' };
}

// Re-wrap the existing backup after an in-app password change: unlock with
// the current password, re-wrap with the new one. Best-effort by design; the
// recovery code remains the fallback if this cannot run.
export async function rewrapPasswordBackup(supabase, userId, publicKey, currentPassword, newPassword) {
  const { available, row } = await passwordBackupRow(supabase, userId);
  if (!available || !row) return false;
  const fingerprint = await fingerprintPublicKey(publicKey);
  if (row.public_key_fingerprint !== fingerprint) return false;
  const { privateJwk, recoveryCode } = await unwrapPrivateKey(row, userId, publicKey, currentPassword);
  return savePasswordBackup(supabase, userId, publicKey, privateJwk, newPassword, recoveryCode);
}

async function keyRow(supabase, userId) {
  const { data, error } = await supabase.from('chat_public_keys')
    .select('public_key').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.public_key || null;
}

export async function loadChatIdentity(supabase, userId) {
  const [publicResult, backupResult] = await Promise.all([
    supabase.from('chat_public_keys').select('public_key').eq('user_id', userId).maybeSingle(),
    supabase.from('chat_key_backups').select('encrypted_private_key').eq('user_id', userId).maybeSingle(),
  ]);
  if (publicResult.error || backupResult.error) throw publicResult.error || backupResult.error;
  const publicKey = publicResult.data?.public_key;
  const encryptedPrivateKey = backupResult.data?.encrypted_private_key;
  if (!publicKey && !encryptedPrivateKey) return { status: 'new' };
  if (!publicKey || !encryptedPrivateKey) throw new Error('Your chat key setup is incomplete. Contact the project owner before sending messages.');
  let privateKey = await loadLocalChatIdentity(userId, publicKey);
  const pendingCode = await loadPendingRecoveryCode(userId, publicKey);
  if (!privateKey && pendingCode) {
    try {
      privateKey = await restoreChatIdentity(userId, encryptedPrivateKey, pendingCode, publicKey);
      await saveLocalChatIdentity(userId, privateKey, publicKey);
    } catch { privateKey = null; }
  }
  const fingerprint = await fingerprintPublicKey(publicKey);
  return { status: privateKey ? 'ready' : 'restore', publicKey, encryptedPrivateKey,
    privateKey, fingerprint, recoveryCode: privateKey ? pendingCode : '' };
}

export async function registerChatIdentity(supabase, userId, password = '') {
  const existing = await loadChatIdentity(supabase, userId);
  if (existing.status !== 'new') return existing;
  const identity = await createChatIdentity(userId);
  // Persist both pieces before the irrevocable server registration. If a tab
  // closes after the RPC succeeds, the code is still shown on the next visit.
  await saveLocalChatIdentity(userId, identity.privateKey, identity.publicKey);
  try { await savePendingRecoveryCode(userId, identity.recoveryCode, identity.publicKey); }
  catch (error) { await clearLocalChatIdentity(userId); throw error; }
  const { error } = await supabase.rpc('register_chat_identity', {
    p_public_key: identity.publicKey,
    p_encrypted_private_key: identity.encryptedPrivateKey,
    p_fingerprint: await fingerprintPublicKey(identity.publicKey),
  });
  if (error) throw new Error(`Could not confirm chat setup: ${error.message}. Refresh before retrying.`);
  // Best-effort password backup while the private JWK is still in memory; a
  // failure here (e.g. migration 0020 not applied yet) must not fail setup.
  let passwordBackupSaved = false;
  if (password) {
    passwordBackupSaved = await savePasswordBackup(
      supabase, userId, identity.publicKey, identity.privateJwk, password,
      identity.recoveryCode).catch(() => false);
  }
  return {
    status: 'ready', publicKey: identity.publicKey,
    encryptedPrivateKey: identity.encryptedPrivateKey,
    privateKey: identity.privateKey,
    fingerprint: await fingerprintPublicKey(identity.publicKey),
    recoveryCode: identity.recoveryCode,
    passwordBackupSaved,
  };
}

export async function resetChatIdentity(supabase, userId, password = '') {
  const identity = await createChatIdentity(userId);
  await saveLocalChatIdentity(userId, identity.privateKey, identity.publicKey);
  await savePendingRecoveryCode(userId, identity.recoveryCode, identity.publicKey);
  const { error } = await supabase.rpc('reset_chat_identity', {
    p_public_key: identity.publicKey,
    p_encrypted_private_key: identity.encryptedPrivateKey,
    p_fingerprint: await fingerprintPublicKey(identity.publicKey),
  });
  if (error) throw new Error(`Could not confirm chat reset: ${error.message}. Refresh before retrying.`);
  // Refresh the password backup for the NEW key so it never points at the
  // dead one; best-effort for the same reason as in registerChatIdentity.
  let passwordBackupSaved = false;
  if (password) {
    passwordBackupSaved = await savePasswordBackup(
      supabase, userId, identity.publicKey, identity.privateJwk, password,
      identity.recoveryCode).catch(() => false);
  }
  return {
    status: 'ready', publicKey: identity.publicKey,
    encryptedPrivateKey: identity.encryptedPrivateKey,
    privateKey: identity.privateKey,
    fingerprint: await fingerprintPublicKey(identity.publicKey),
    recoveryCode: identity.recoveryCode,
    passwordBackupSaved,
  };
}

export async function recoverChatIdentity(supabase, userId, recoveryCode) {
  const identity = await loadChatIdentity(supabase, userId);
  if (!identity.publicKey || !identity.encryptedPrivateKey) throw new Error('No chat key backup exists for this account.');
  const privateKey = await restoreChatIdentity(userId, identity.encryptedPrivateKey, recoveryCode, identity.publicKey);
  await saveLocalChatIdentity(userId, privateKey, identity.publicKey);
  return { ...identity, status: 'ready', privateKey };
}

export async function acknowledgeRecoveryCode(userId) {
  await clearPendingRecoveryCode(userId);
}

export async function loadEncryptedConversation(supabase, userId, recipientId, identity) {
  if (!identity?.privateKey || !identity.publicKey) throw new Error('Set up or restore your private chat key first.');
  const [recipientKey, messageResult] = await Promise.all([
    keyRow(supabase, recipientId),
    supabase.from('direct_messages')
      .select('id,sender_id,recipient_id,body,encryption_version,encrypted_payload,created_at,read_at')
      .or(`and(sender_id.eq.${userId},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${userId})`)
      .order('created_at', { ascending: false }).limit(200),
  ]);
  if (messageResult.error) throw messageResult.error;
  const rows = (messageResult.data || []).reverse();
  const references = rows.filter(row => row.encryption_version === 1).flatMap(row => {
    try { return messageKeyReferences(row.encrypted_payload, row.sender_id, row.recipient_id); }
    catch { return []; }
  });
  const fingerprints = [...new Set(references.map(ref => ref.fingerprint))];
  let historicalKeys = [];
  if (fingerprints.length) {
    const { data, error } = await supabase.from('chat_key_history')
      .select('user_id,fingerprint,public_key')
      .in('user_id', [userId, recipientId]).in('fingerprint', fingerprints);
    if (error) throw error;
    historicalKeys = data || [];
  }
  const history = new Map(historicalKeys.map(row => [`${row.user_id}:${row.fingerprint}`, row.public_key]));
  const messages = await Promise.all(rows.map(async row => {
    if (row.encryption_version === 0) return { ...row, text: row.body, legacy: true };
    try {
      const [senderRef, recipientRef] = messageKeyReferences(row.encrypted_payload, row.sender_id, row.recipient_id);
      const viewerRef = row.sender_id === userId ? senderRef : recipientRef;
      if (viewerRef.fingerprint !== identity.fingerprint) {
        return { ...row, text: 'Earlier message is locked because your chat key was reset.', failed: true };
      }
      const senderPublicKey = history.get(`${senderRef.userId}:${senderRef.fingerprint}`);
      const recipientPublicKey = history.get(`${recipientRef.userId}:${recipientRef.fingerprint}`);
      if (!senderPublicKey || !recipientPublicKey) throw new Error('A historical chat key is unavailable.');
      const text = await decryptDirectMessage({
        payload: row.encrypted_payload, senderId: row.sender_id, recipientId: row.recipient_id,
        viewerId: userId, viewerPrivateKey: identity.privateKey,
        senderPublicKey, recipientPublicKey,
      });
      return { ...row, text };
    } catch (error) {
      return { ...row, text: error.message || 'Could not decrypt this message.', failed: true };
    }
  }));
  return { messages, recipientKey, recipientFingerprint: recipientKey ? await fingerprintPublicKey(recipientKey) : '' };
}

export async function sendEncryptedMessage(supabase, userId, recipientId, plaintext, identity, expectedRecipientFingerprint) {
  if (!identity?.privateKey || !identity.publicKey) throw new Error('Set up or restore your private chat key first.');
  const recipientKey = await keyRow(supabase, recipientId);
  if (!recipientKey) throw new Error('This student has not enabled encrypted chat yet.');
  const fingerprint = await fingerprintPublicKey(recipientKey);
  if (fingerprint !== expectedRecipientFingerprint) throw new Error('This student’s chat key just changed. Refresh the conversation and send again.');
  const encryptedPayload = await encryptDirectMessage({
    plaintext, senderId: userId, recipientId,
    senderPrivateKey: identity.privateKey,
    senderPublicKey: identity.publicKey,
    recipientPublicKey: recipientKey,
  });
  const { error } = await supabase.from('direct_messages').insert({
    sender_id: userId, recipient_id: recipientId,
    encryption_version: 1, encrypted_payload: encryptedPayload,
  });
  if (error) throw error;
}
