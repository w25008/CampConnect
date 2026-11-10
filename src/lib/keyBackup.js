// Password-based backup for the E2EE chat private key (Messenger-style
// restore). The recovery-code backup in e2ee.js remains the fallback; this
// module wraps the SAME private JWK under a key derived from the account
// password, so signing in can restore chats without typing the code.
//
// The blob lives in public.chat_password_backups (migration 0020). The server
// only ever sees salt/iv/ciphertext: the password and the plaintext private
// key never leave the browser. PBKDF2 (SHA-256, 310k iterations) slows
// offline guessing if the ciphertext ever leaks, but it is not a substitute
// for a strong account password.
//
// Email password reset changes the password WITHOUT unwrapping this backup,
// so after a reset the backup can no longer be opened with the new password.
// That is expected: the recovery code still works, and the next successful
// code restore (or password sign-in after one) re-wraps the backup under the
// current password. See chatApi.refreshPasswordBackupAfterRestore.

import { fingerprintPublicKey, toBase64Url, fromBase64Url } from './e2ee.js';

const VERSION = 1;
const PBKDF2_ITERATIONS = 310000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// Typed error so the UI can show a localized "wrong password" message instead
// of a raw WebCrypto failure. AES-GCM authentication failing is the signal.
export class PasswordBackupError extends Error {
  constructor(message = 'Password could not unlock the chat key backup.') {
    super(message);
    this.name = 'PasswordBackupError';
  }
}

function webCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('Private chat requires a secure browser context with Web Crypto.');
  }
  return globalThis.crypto;
}

function randomBytes(length) {
  return webCrypto().getRandomValues(new Uint8Array(length));
}

function passwordBackupContext(userId, fingerprint) {
  return `CampConnect chat key password backup v1|${userId}|${fingerprint}`;
}

export async function deriveWrappingKey(password, salt) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new PasswordBackupError('A password is required to unlock the chat key backup.');
  }
  const material = await webCrypto().subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return webCrypto().subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Payload shapes inside the ciphertext (the DB row version stays 1 — the
// migration checks it — so payload versioning lives in the plaintext):
//   v1 (legacy): the bare private JWK, e.g. { kty, crv, x, y, d }.
//   v2: { payloadVersion: 2, privateJwk, recoveryCode } — also carries the
//   recovery-code TEXT so the Profile page can show it later after a password
//   check. Without this the code could never be re-derived once the creation
//   panel is gone. unwrapPrivateKey reads both shapes.
const PAYLOAD_VERSION = 2;

// Wrap the private JWK. When recoveryCode is given it is stored inside the
// encrypted payload (v2 shape). Returns the row shape stored in
// chat_password_backups: { version, salt, iv, ciphertext,
// public_key_fingerprint } (base64url text).
export async function wrapPrivateKey(privateJwk, userId, publicKey, password, recoveryCode = '') {
  const fingerprint = await fingerprintPublicKey(publicKey);
  if (!privateJwk || privateJwk.x !== publicKey.x || privateJwk.y !== publicKey.y ||
      typeof privateJwk.d !== 'string') {
    throw new Error('Chat key does not match the public key.');
  }
  const payload = recoveryCode
    ? { payloadVersion: PAYLOAD_VERSION, privateJwk, recoveryCode }
    : privateJwk;
  const context = passwordBackupContext(userId, fingerprint);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const wrappingKey = await deriveWrappingKey(password, salt);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    wrappingKey, encoder.encode(JSON.stringify(payload)));
  return {
    version: VERSION,
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    public_key_fingerprint: fingerprint,
  };
}

// Unwrap a blob produced by wrapPrivateKey. Returns { privateKey, privateJwk,
// recoveryCode } where privateKey is the usual nonextractable ECDH CryptoKey
// and recoveryCode is '' for legacy v1 payloads (the code was never stored).
// A wrong password (or a blob for another account/key) throws
// PasswordBackupError.
export async function unwrapPrivateKey(blob, userId, publicKey, password) {
  const fingerprint = await fingerprintPublicKey(publicKey);
  if (!blob || blob.version !== VERSION || blob.public_key_fingerprint !== fingerprint) {
    throw new Error('Chat key password backup does not match this account key.');
  }
  const salt = fromBase64Url(blob.salt);
  const iv = fromBase64Url(blob.iv);
  if (salt.length !== 32 || iv.length !== 12) throw new Error('Invalid chat key password backup.');
  const context = passwordBackupContext(userId, fingerprint);
  const wrappingKey = await deriveWrappingKey(password, salt);
  let parsed;
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      wrappingKey, fromBase64Url(blob.ciphertext));
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new PasswordBackupError();
  }
  const isV2 = parsed?.payloadVersion === PAYLOAD_VERSION && parsed.privateJwk;
  const privateJwk = isV2 ? parsed.privateJwk : parsed;
  const recoveryCode = isV2 && typeof parsed.recoveryCode === 'string' ? parsed.recoveryCode : '';
  if (!privateJwk || privateJwk.x !== publicKey.x || privateJwk.y !== publicKey.y ||
      typeof privateJwk.d !== 'string') {
    throw new Error('Chat key password backup does not match the public key.');
  }
  const privateKey = await webCrypto().subtle.importKey('jwk', privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey, privateJwk, recoveryCode };
}
