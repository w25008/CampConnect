// Browser-side encryption for one-to-one chats. This is a small, versioned
// ECDH/HKDF/AES-GCM design, not Signal's ratchet or a substitute for an audit.
// The server can substitute public keys unless users compare fingerprints over
// an independent channel. Whoever serves this website can also change its JS.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const VERSION = 1;

function webCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('Private chat requires a secure browser context with Web Crypto.');
  }
  return globalThis.crypto;
}

function randomBytes(length) {
  return webCrypto().getRandomValues(new Uint8Array(length));
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid encrypted data encoding.');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function assertUserId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) {
    throw new Error('A valid account ID is required.');
  }
}

function cleanPublicKey(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
      typeof jwk.x !== 'string' || typeof jwk.y !== 'string' ||
      fromBase64Url(jwk.x).length !== 32 || fromBase64Url(jwk.y).length !== 32) {
    throw new Error('Invalid chat public key.');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

async function importPublicKey(jwk) {
  return webCrypto().subtle.importKey('jwk', cleanPublicKey(jwk),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function fingerprintPublicKey(publicKey) {
  const key = cleanPublicKey(publicKey);
  const canonical = encoder.encode(`CampConnect chat key v1|P-256|${key.x}|${key.y}`);
  const digest = await webCrypto().subtle.digest('SHA-256', canonical);
  return toBase64Url(new Uint8Array(digest));
}

function messageContext(senderId, recipientId, senderFingerprint, recipientFingerprint) {
  assertUserId(senderId);
  assertUserId(recipientId);
  if (senderId === recipientId) throw new Error('A private chat needs two accounts.');
  return `CampConnect DM v1|${senderId}|${recipientId}|${senderFingerprint}|${recipientFingerprint}`;
}

// Resolve these exact keys from append-only public-key history before decrypting.
// A key reset changes the current key but must not erase old public keys: the
// other student still needs them to read messages sent before the reset.
export function messageKeyReferences(payload, senderId, recipientId) {
  assertUserId(senderId);
  assertUserId(recipientId);
  if (payload?.version !== VERSION || senderId === recipientId) {
    throw new Error('Unsupported encrypted message.');
  }
  const senderFingerprint = payload.sender_key_fingerprint;
  const recipientFingerprint = payload.recipient_key_fingerprint;
  if (fromBase64Url(senderFingerprint).length !== 32 ||
      fromBase64Url(recipientFingerprint).length !== 32) {
    throw new Error('Invalid message key fingerprints.');
  }
  return [
    { userId: senderId, fingerprint: senderFingerprint },
    { userId: recipientId, fingerprint: recipientFingerprint },
  ];
}

async function deriveMessageKey(privateKey, otherPublicKey, salt, context) {
  const shared = await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: await importPublicKey(otherPublicKey) }, privateKey, 256);
  const material = await webCrypto().subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return webCrypto().subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(context) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function backupContext(userId, fingerprint) {
  assertUserId(userId);
  return `CampConnect chat key backup v1|${userId}|${fingerprint}`;
}

async function recoveryWrappingKey(recoveryCodeBytes, salt, context) {
  const material = await webCrypto().subtle.importKey('raw', recoveryCodeBytes, 'HKDF', false, ['deriveKey']);
  return webCrypto().subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(context) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Store publicKey in chat_public_keys and encryptedPrivateKey in the owner-only
// chat_key_backups table. Show recoveryCode once. Never upload it or the raw
// privateKey; losing both the browser key and code loses old chat access.
export async function createChatIdentity(userId) {
  assertUserId(userId);
  const pair = await webCrypto().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = cleanPublicKey(await webCrypto().subtle.exportKey('jwk', pair.publicKey));
  const privateJwk = await webCrypto().subtle.exportKey('jwk', pair.privateKey);
  const fingerprint = await fingerprintPublicKey(publicKey);
  const context = backupContext(userId, fingerprint);
  const recoveryCodeBytes = randomBytes(32);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const wrappingKey = await recoveryWrappingKey(recoveryCodeBytes, salt, context);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    wrappingKey, encoder.encode(JSON.stringify(privateJwk)));
  const privateKey = await webCrypto().subtle.importKey('jwk', privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return {
    publicKey,
    encryptedPrivateKey: {
      version: VERSION, salt: toBase64Url(salt), iv: toBase64Url(iv),
      ciphertext: toBase64Url(new Uint8Array(ciphertext)), public_key_fingerprint: fingerprint,
    },
    recoveryCode: toBase64Url(recoveryCodeBytes),
    privateKey,
  };
}

export async function restoreChatIdentity(userId, encryptedPrivateKey, recoveryCode, publicKey) {
  const fingerprint = await fingerprintPublicKey(publicKey);
  if (encryptedPrivateKey?.version !== VERSION ||
      encryptedPrivateKey.public_key_fingerprint !== fingerprint) {
    throw new Error('Chat key backup does not match this account key.');
  }
  const code = fromBase64Url(recoveryCode);
  if (code.length !== 32) throw new Error('Recovery code must be the 256-bit code issued for this account.');
  const salt = fromBase64Url(encryptedPrivateKey.salt);
  const iv = fromBase64Url(encryptedPrivateKey.iv);
  if (salt.length !== 32 || iv.length !== 12) throw new Error('Invalid chat key backup.');
  const context = backupContext(userId, fingerprint);
  const wrappingKey = await recoveryWrappingKey(code, salt, context);
  let privateJwk;
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      wrappingKey, fromBase64Url(encryptedPrivateKey.ciphertext));
    privateJwk = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Recovery failed. Check the code and account key backup.');
  }
  const expected = cleanPublicKey(publicKey);
  const actual = cleanPublicKey(privateJwk);
  if (actual.x !== expected.x || actual.y !== expected.y || typeof privateJwk.d !== 'string') {
    throw new Error('Chat key backup does not match the public key.');
  }
  return webCrypto().subtle.importKey('jwk', privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

// The result belongs in direct_messages.encrypted_payload with
// encryption_version=1 and body=NULL. Do not fall back to plaintext on error.
export async function encryptDirectMessage({ plaintext, senderId, recipientId,
  senderPrivateKey, senderPublicKey, recipientPublicKey }) {
  if (typeof plaintext !== 'string' || !plaintext.trim()) throw new Error('Message is empty.');
  const senderFingerprint = await fingerprintPublicKey(senderPublicKey);
  const recipientFingerprint = await fingerprintPublicKey(recipientPublicKey);
  const context = messageContext(senderId, recipientId, senderFingerprint, recipientFingerprint);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await deriveMessageKey(senderPrivateKey, recipientPublicKey, salt, context);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(plaintext));
  return {
    version: VERSION, salt: toBase64Url(salt), iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    sender_key_fingerprint: senderFingerprint,
    recipient_key_fingerprint: recipientFingerprint,
  };
}

export async function decryptDirectMessage({ payload, senderId, recipientId, viewerId,
  viewerPrivateKey, senderPublicKey, recipientPublicKey }) {
  if (payload?.version !== VERSION) throw new Error('Unsupported encrypted message version.');
  if (viewerId !== senderId && viewerId !== recipientId) throw new Error('Not a conversation participant.');
  const senderFingerprint = await fingerprintPublicKey(senderPublicKey);
  const recipientFingerprint = await fingerprintPublicKey(recipientPublicKey);
  if (payload.sender_key_fingerprint !== senderFingerprint ||
      payload.recipient_key_fingerprint !== recipientFingerprint) {
    throw new Error('Chat key changed. Verify your contact before reading this message.');
  }
  const context = messageContext(senderId, recipientId, senderFingerprint, recipientFingerprint);
  const salt = fromBase64Url(payload.salt);
  const iv = fromBase64Url(payload.iv);
  if (salt.length !== 32 || iv.length !== 12) throw new Error('Invalid encrypted message.');
  const otherPublicKey = viewerId === senderId ? recipientPublicKey : senderPublicKey;
  const key = await deriveMessageKey(viewerPrivateKey, otherPublicKey, salt, context);
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      key, fromBase64Url(payload.ciphertext));
    return decoder.decode(plaintext);
  } catch {
    throw new Error('Could not decrypt this message. Check both chat keys.');
  }
}

// IndexedDB persists only a nonextractable CryptoKey. Browser storage can be
// lost or cleared; the recovery code restores from the server-side ciphertext.
const LOCAL_DB = 'campconnect-chat-keys-v1';
const LOCAL_STORE = 'identity';

function openLocalKeyDb() {
  if (!globalThis.indexedDB) throw new Error('This browser does not support local chat key storage.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local chat key storage.'));
  });
}

async function localKeyOperation(mode, operation) {
  const db = await openLocalKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(LOCAL_STORE, mode);
      const request = operation(transaction.objectStore(LOCAL_STORE));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error('Local chat key storage failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Local chat key storage failed.'));
      transaction.onerror = () => reject(transaction.error || new Error('Local chat key storage failed.'));
      transaction.oncomplete = () => resolve(result);
    });
  } finally {
    db.close();
  }
}

export async function saveLocalChatIdentity(userId, privateKey, publicKey) {
  assertUserId(userId);
  if (!(privateKey instanceof CryptoKey) || privateKey.type !== 'private' || privateKey.extractable ||
      privateKey.algorithm?.name !== 'ECDH') {
    throw new Error('Only a nonextractable ECDH private key can be saved locally.');
  }
  const fingerprint = await fingerprintPublicKey(publicKey);
  if (!await privateKeyMatchesPublic(privateKey, publicKey)) throw new Error('Local chat key does not match its public key.');
  await localKeyOperation('readwrite', store => store.put({ privateKey, fingerprint }, userId));
}

export async function privateKeyMatchesPublic(privateKey, publicKey) {
  const ephemeral = await webCrypto().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const registered = await importPublicKey(publicKey);
  const left = new Uint8Array(await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: ephemeral.publicKey }, privateKey, 256));
  const right = new Uint8Array(await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: registered }, ephemeral.privateKey, 256));
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

export async function loadLocalChatIdentity(userId, publicKey) {
  assertUserId(userId);
  const record = await localKeyOperation('readonly', store => store.get(userId));
  if (!record) return null;
  const fingerprint = await fingerprintPublicKey(publicKey);
  if (record.fingerprint !== fingerprint) return null;
  const key = record.privateKey;
  if (!(key instanceof CryptoKey) || key.type !== 'private' || key.extractable ||
      key.algorithm?.name !== 'ECDH') throw new Error('Invalid local chat key.');
  if (!await privateKeyMatchesPublic(key, publicKey)) return null;
  return key;
}

export async function clearLocalChatIdentity(userId) {
  assertUserId(userId);
  await localKeyOperation('readwrite', store => store.delete(userId));
}

// Keep a newly issued code locally until the student confirms saving it. This
// closes the crash window between the server registration and the one-time UI.
function pendingRecoveryId(userId) {
  assertUserId(userId);
  return `${userId}:pending-recovery-code`;
}

export async function savePendingRecoveryCode(userId, code, publicKey) {
  if (fromBase64Url(code).length !== 32) throw new Error('Invalid recovery code.');
  const fingerprint = await fingerprintPublicKey(publicKey);
  await localKeyOperation('readwrite', store => store.put({ code, fingerprint }, pendingRecoveryId(userId)));
}

export async function loadPendingRecoveryCode(userId, publicKey) {
  const pending = await localKeyOperation('readonly', store => store.get(pendingRecoveryId(userId)));
  if (!pending || pending.fingerprint !== await fingerprintPublicKey(publicKey)) return '';
  return typeof pending.code === 'string' ? pending.code : '';
}

export async function clearPendingRecoveryCode(userId) {
  await localKeyOperation('readwrite', store => store.delete(pendingRecoveryId(userId)));
}
