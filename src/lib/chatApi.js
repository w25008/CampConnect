import {
  createChatIdentity, restoreChatIdentity, encryptDirectMessage,
  decryptDirectMessage, fingerprintPublicKey, messageKeyReferences, saveLocalChatIdentity,
  loadLocalChatIdentity, clearLocalChatIdentity,
  savePendingRecoveryCode, loadPendingRecoveryCode, clearPendingRecoveryCode,
} from './e2ee.js';

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

export async function registerChatIdentity(supabase, userId) {
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
  return {
    status: 'ready', publicKey: identity.publicKey,
    encryptedPrivateKey: identity.encryptedPrivateKey,
    privateKey: identity.privateKey,
    fingerprint: await fingerprintPublicKey(identity.publicKey),
    recoveryCode: identity.recoveryCode,
  };
}

export async function resetChatIdentity(supabase, userId) {
  const identity = await createChatIdentity(userId);
  await saveLocalChatIdentity(userId, identity.privateKey, identity.publicKey);
  await savePendingRecoveryCode(userId, identity.recoveryCode, identity.publicKey);
  const { error } = await supabase.rpc('reset_chat_identity', {
    p_public_key: identity.publicKey,
    p_encrypted_private_key: identity.encryptedPrivateKey,
    p_fingerprint: await fingerprintPublicKey(identity.publicKey),
  });
  if (error) throw new Error(`Could not confirm chat reset: ${error.message}. Refresh before retrying.`);
  return {
    status: 'ready', publicKey: identity.publicKey,
    encryptedPrivateKey: identity.encryptedPrivateKey,
    privateKey: identity.privateKey,
    fingerprint: await fingerprintPublicKey(identity.publicKey),
    recoveryCode: identity.recoveryCode,
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
      .select('id,sender_id,recipient_id,body,encryption_version,encrypted_payload,created_at')
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
  if (fingerprint !== expectedRecipientFingerprint) throw new Error('This student’s chat key changed. Refresh and verify the new key before sending.');
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
