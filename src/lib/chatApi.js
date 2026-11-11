import {
  createChatIdentity, restoreChatIdentity, decryptBackupPrivateJwk, encryptDirectMessage,
  decryptDirectMessage, decodeMessageContent, fingerprintPublicKey, messageKeyReferences, saveLocalChatIdentity,
  loadLocalChatIdentity, clearLocalChatIdentity,
  savePendingRecoveryCode, loadPendingRecoveryCode, clearPendingRecoveryCode,
} from './e2ee.js';
import { wrapPrivateKey, unwrapPrivateKey, PasswordBackupError } from './keyBackup.js';

export { PasswordBackupError };

// Chat-identity mutations are serialized per account through a promise
// chain. The sign-in bootstrap (ensureChatIdentity), the Messages-page
// setup button (registerChatIdentity) and a key reset can all fire around
// the same moment — sign-in while effects remount, or a click while the
// bootstrap is still running — and without this, two flows could both see
// "no identity yet" and race to register different keys for one account.
const identityFlights = new Map();

function withIdentityLock(userId, task) {
  const previous = identityFlights.get(userId) || Promise.resolve();
  const current = previous.then(task, task);
  identityFlights.set(userId, current);
  const cleanup = () => {
    if (identityFlights.get(userId) === current) identityFlights.delete(userId);
  };
  current.then(cleanup, cleanup);
  return current;
}

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

async function registerChatIdentityImpl(supabase, userId, password = '') {
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

export function registerChatIdentity(supabase, userId, password = '') {
  return withIdentityLock(userId, () => registerChatIdentityImpl(supabase, userId, password));
}

async function resetChatIdentityImpl(supabase, userId, password = '') {
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

export function resetChatIdentity(supabase, userId, password = '') {
  return withIdentityLock(userId, () => resetChatIdentityImpl(supabase, userId, password));
}

// Sign-in bootstrap: make sure this account has a usable chat identity
// without the student ever opening the Messages page, so classmates can
// message them from their very first sign-in. Runs silently in the
// background; the caller treats any failure as "leave chat as it was".
//   ready   — nothing to do.
//   restore — a key exists but is locked on this device. Only a password
//             that is transiently available (fresh password sign-in) may
//             unlock it via the password backup. On any failure the
//             restorable identity is returned untouched: a fresh key is
//             NEVER created over one that could still be restored, or old
//             messages would become unreadable.
//   new     — no key anywhere: create one silently, register the public
//             key, and (when a password is available) save the password
//             backup, exactly like the manual setup did.
export function ensureChatIdentity(supabase, userId, password = '') {
  return withIdentityLock(userId, async () => {
    const identity = await loadChatIdentity(supabase, userId);
    if (identity.status === 'ready') return identity;
    if (identity.status === 'restore') {
      if (password) {
        try {
          const restored = await recoverChatIdentityWithPassword(supabase, userId, password);
          if (restored) return restored;
        } catch { /* wrong password or unusable backup: keep the restore state */ }
      }
      return identity;
    }
    return registerChatIdentityImpl(supabase, userId, password);
  });
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

// edited_at arrives with migration 0023. Until the team applies it, the
// column does not exist and a select naming it fails the whole query —
// detect that one failure and retry without the column, so conversations
// keep loading exactly as before (messages just show no "edited" label).
function isMissingEditedAtColumn(error) {
  if (!error) return false;
  return /edited_at/.test(error.message || '') &&
    /does not exist|Could not find/i.test(error.message || '');
}

function conversationQuery(supabase, userId, recipientId, withEditedAt) {
  return supabase.from('direct_messages')
    .select(`id,sender_id,recipient_id,body,encryption_version,encrypted_payload,created_at,read_at${withEditedAt ? ',edited_at' : ''}`)
    .or(`and(sender_id.eq.${userId},recipient_id.eq.${recipientId}),and(sender_id.eq.${recipientId},recipient_id.eq.${userId})`)
    .order('created_at', { ascending: false }).limit(200);
}

export async function loadEncryptedConversation(supabase, userId, recipientId, identity) {
  if (!identity?.privateKey || !identity.publicKey) throw new Error('Set up or restore your private chat key first.');
  const [recipientKey, firstResult] = await Promise.all([
    keyRow(supabase, recipientId),
    conversationQuery(supabase, userId, recipientId, true),
  ]);
  let messageResult = firstResult;
  if (messageResult.error && isMissingEditedAtColumn(messageResult.error)) {
    messageResult = await conversationQuery(supabase, userId, recipientId, false);
  }
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
    if (row.encryption_version === 0) {
      const content = decodeMessageContent(row.body);
      return { ...row, text: content.text, replyTo: content.replyTo, forwarded: content.forwarded, legacy: true };
    }
    try {
      const [senderRef, recipientRef] = messageKeyReferences(row.encrypted_payload, row.sender_id, row.recipient_id);
      const viewerRef = row.sender_id === userId ? senderRef : recipientRef;
      if (viewerRef.fingerprint !== identity.fingerprint) {
        return { ...row, text: 'Earlier message is locked because your chat key was reset.', replyTo: null, forwarded: false, failed: true };
      }
      const senderPublicKey = history.get(`${senderRef.userId}:${senderRef.fingerprint}`);
      const recipientPublicKey = history.get(`${recipientRef.userId}:${recipientRef.fingerprint}`);
      if (!senderPublicKey || !recipientPublicKey) throw new Error('A historical chat key is unavailable.');
      const raw = await decryptDirectMessage({
        payload: row.encrypted_payload, senderId: row.sender_id, recipientId: row.recipient_id,
        viewerId: userId, viewerPrivateKey: identity.privateKey,
        senderPublicKey, recipientPublicKey,
      });
      // v2-envelope messages carry reply/forward metadata inside the
      // ciphertext; everything older decodes as plain text.
      const content = decodeMessageContent(raw);
      return { ...row, text: content.text, replyTo: content.replyTo, forwarded: content.forwarded };
    } catch (error) {
      return { ...row, text: error.message || 'Could not decrypt this message.', replyTo: null, forwarded: false, failed: true };
    }
  }));
  return { messages, recipientKey, recipientFingerprint: recipientKey ? await fingerprintPublicKey(recipientKey) : '' };
}

export async function sendEncryptedMessage(supabase, userId, recipientId, plaintext, identity, expectedRecipientFingerprint, meta = null) {
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
    meta,
  });
  const { error } = await supabase.from('direct_messages').insert({
    sender_id: userId, recipient_id: recipientId,
    encryption_version: 1, encrypted_payload: encryptedPayload,
  });
  if (error) throw error;
}

// A contact's current chat key + fingerprint, or null when they have not
// enabled encrypted chat. Used by the forward picker, which sends to
// students other than the open conversation's recipient.
export async function getRecipientChatKey(supabase, recipientId) {
  const publicKey = await keyRow(supabase, recipientId);
  if (!publicKey) return null;
  return { publicKey, fingerprint: await fingerprintPublicKey(publicKey) };
}

// Edit/delete run through security-definer RPCs from migration 0023:
// direct_messages grants the browser no UPDATE or DELETE at all. Until the
// team applies 0023 the RPCs do not exist; callers translate this marker
// into the localized setup message.
export class MessageActionsSetupError extends Error {
  constructor() {
    super('Message actions need a database update (migration 0023).');
    this.name = 'MessageActionsSetupError';
  }
}

function throwIfMissingMessageActions(error) {
  if (!error) return;
  if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
    throw new MessageActionsSetupError();
  }
  throw error;
}

// Replace one of the sender's own encrypted messages with a re-encryption
// of the new text. The original reply/forward metadata is preserved (the
// caller passes the message's decoded content back as meta); the edited
// marker is the server-set edited_at column, never client data. Encrypted
// exactly like a fresh send to the same recipient, so the payload's key
// references stay resolvable from chat_key_history.
export async function editEncryptedMessage(supabase, userId, message, newText, identity) {
  if (!identity?.privateKey || !identity.publicKey) throw new Error('Set up or restore your private chat key first.');
  if (message.sender_id !== userId) throw new Error('You can only edit your own messages.');
  if (message.encryption_version !== 1) throw new Error('Earlier messages cannot be edited.');
  const recipientKey = await keyRow(supabase, message.recipient_id);
  if (!recipientKey) throw new Error('This student has not enabled encrypted chat yet.');
  const meta = (message.replyTo || message.forwarded)
    ? { replyTo: message.replyTo || null, forwarded: Boolean(message.forwarded) }
    : null;
  const encryptedPayload = await encryptDirectMessage({
    plaintext: newText, senderId: userId, recipientId: message.recipient_id,
    senderPrivateKey: identity.privateKey,
    senderPublicKey: identity.publicKey,
    recipientPublicKey: recipientKey,
    meta,
  });
  const { error } = await supabase.rpc('edit_direct_message', {
    p_message_id: message.id, p_encrypted_payload: encryptedPayload,
  });
  throwIfMissingMessageActions(error);
}

// Delete one of the sender's own messages for everyone: the row is removed
// server-side, so it disappears from both participants' histories on their
// next load. Quotes of it keep rendering from their embedded snippet.
export async function deleteEncryptedMessage(supabase, messageId) {
  const { error } = await supabase.rpc('delete_direct_message', { p_message_id: messageId });
  throwIfMissingMessageActions(error);
}
