import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatIdentity, privateKeyMatchesPublic } from './e2ee.js';
import { deriveWrappingKey, wrapPrivateKey, unwrapPrivateKey, PasswordBackupError } from './keyBackup.js';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'school-password-42';

test('password backup round-trip restores the same private key', async () => {
  const identity = await createChatIdentity(alice);
  const blob = await wrapPrivateKey(identity.privateJwk, alice, identity.publicKey, PASSWORD);
  assert.equal(blob.version, 1);
  assert.equal(blob.public_key_fingerprint.length, 43);
  // The stored blob must never contain the private scalar or the password.
  assert.equal('d' in blob, false);
  assert.equal(JSON.stringify(blob).includes(identity.privateJwk.d), false);
  assert.equal(JSON.stringify(blob).includes(PASSWORD), false);
  const { privateKey, privateJwk } = await unwrapPrivateKey(blob, alice, identity.publicKey, PASSWORD);
  assert.equal(privateKey.extractable, false);
  assert.equal(privateJwk.d, identity.privateJwk.d);
  assert.equal(await privateKeyMatchesPublic(privateKey, identity.publicKey), true);
});

test('wrong password fails with PasswordBackupError and damages nothing', async () => {
  const identity = await createChatIdentity(alice);
  const blob = await wrapPrivateKey(identity.privateJwk, alice, identity.publicKey, PASSWORD);
  await assert.rejects(
    unwrapPrivateKey(blob, alice, identity.publicKey, 'not-the-password'),
    err => err instanceof PasswordBackupError && err.name === 'PasswordBackupError');
  // The blob is untouched by the failed attempt: the right password still works.
  const { privateKey } = await unwrapPrivateKey(blob, alice, identity.publicKey, PASSWORD);
  assert.equal(await privateKeyMatchesPublic(privateKey, identity.publicKey), true);
});

test('backup is bound to the account and to the chat key', async () => {
  const a = await createChatIdentity(alice);
  const b = await createChatIdentity(bob);
  const blob = await wrapPrivateKey(a.privateJwk, alice, a.publicKey, PASSWORD);
  // Another account cannot open it even with the right password.
  await assert.rejects(unwrapPrivateKey(blob, bob, a.publicKey, PASSWORD), PasswordBackupError);
  // A backup made for one key does not match a different (reset) key.
  await assert.rejects(unwrapPrivateKey(blob, alice, b.publicKey, PASSWORD),
    /does not match/);
});

test('v2 payload stores the recovery code inside the encrypted backup', async () => {
  const identity = await createChatIdentity(alice);
  const blob = await wrapPrivateKey(identity.privateJwk, alice, identity.publicKey, PASSWORD, identity.recoveryCode);
  // Row version stays 1 (the DB check constraint requires it); the code must
  // not appear anywhere in the stored row in plaintext.
  assert.equal(blob.version, 1);
  assert.equal(JSON.stringify(blob).includes(identity.recoveryCode), false);
  const { privateKey, privateJwk, recoveryCode } = await unwrapPrivateKey(blob, alice, identity.publicKey, PASSWORD);
  assert.equal(recoveryCode, identity.recoveryCode);
  assert.equal(privateJwk.d, identity.privateJwk.d);
  assert.equal(await privateKeyMatchesPublic(privateKey, identity.publicKey), true);
  // A wrong password cannot reach the code either.
  await assert.rejects(
    unwrapPrivateKey(blob, alice, identity.publicKey, 'not-the-password'),
    PasswordBackupError);
});

test('legacy v1 payload (bare JWK) still unwraps, with an empty recovery code', async () => {
  const identity = await createChatIdentity(alice);
  // wrapPrivateKey without a recovery code produces the legacy bare-JWK shape.
  const blob = await wrapPrivateKey(identity.privateJwk, alice, identity.publicKey, PASSWORD);
  const { privateKey, privateJwk, recoveryCode } = await unwrapPrivateKey(blob, alice, identity.publicKey, PASSWORD);
  assert.equal(recoveryCode, '');
  assert.equal(privateJwk.d, identity.privateJwk.d);
  assert.equal(await privateKeyMatchesPublic(privateKey, identity.publicKey), true);
});

test('deriveWrappingKey is salted and password-sensitive', async () => {
  const saltA = new Uint8Array(32).fill(7);
  const saltB = new Uint8Array(32).fill(9);
  const keyA = await deriveWrappingKey(PASSWORD, saltA);
  const keyB = await deriveWrappingKey(PASSWORD, saltB);
  assert.equal(keyA.algorithm.name, 'AES-GCM');
  assert.notEqual(keyA, keyB);
  await assert.rejects(deriveWrappingKey('', saltA), PasswordBackupError);
});
