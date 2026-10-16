import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatIdentity, restoreChatIdentity, encryptDirectMessage,
  decryptDirectMessage, fingerprintPublicKey, messageKeyReferences,
  privateKeyMatchesPublic,
} from './e2ee.js';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const charlie = '33333333-3333-4333-8333-333333333333';

test('encrypted backup restores a nonextractable private key in a new session', async () => {
  const identity = await createChatIdentity(alice);
  assert.equal(identity.recoveryCode.length, 43);
  assert.equal(identity.privateKey.extractable, false);
  assert.equal('d' in identity.encryptedPrivateKey, false);
  const restored = await restoreChatIdentity(alice, identity.encryptedPrivateKey,
    identity.recoveryCode, identity.publicKey);
  assert.equal(restored.extractable, false);
  await assert.rejects(restoreChatIdentity(alice, identity.encryptedPrivateKey,
    'A'.repeat(43), identity.publicKey), /Recovery failed/);
  await assert.rejects(restoreChatIdentity(bob, identity.encryptedPrivateKey,
    identity.recoveryCode, identity.publicKey), /Recovery failed/);
});

test('sender and recipient decrypt, third party and altered metadata cannot', async () => {
  const a = await createChatIdentity(alice);
  const b = await createChatIdentity(bob);
  const c = await createChatIdentity(charlie);
  const plaintext = 'Private message for two people';
  const payload = await encryptDirectMessage({
    plaintext, senderId: alice, recipientId: bob,
    senderPrivateKey: a.privateKey, senderPublicKey: a.publicKey,
    recipientPublicKey: b.publicKey,
  });
  assert.equal(JSON.stringify(payload).includes(plaintext), false);
  assert.deepEqual(messageKeyReferences(payload, alice, bob), [
    { userId: alice, fingerprint: await fingerprintPublicKey(a.publicKey) },
    { userId: bob, fingerprint: await fingerprintPublicKey(b.publicKey) },
  ]);
  const common = { payload, senderId: alice, recipientId: bob,
    senderPublicKey: a.publicKey, recipientPublicKey: b.publicKey };
  assert.equal(await decryptDirectMessage({ ...common, viewerId: alice,
    viewerPrivateKey: a.privateKey }), plaintext);
  assert.equal(await decryptDirectMessage({ ...common, viewerId: bob,
    viewerPrivateKey: b.privateKey }), plaintext);
  await assert.rejects(decryptDirectMessage({ ...common, viewerId: charlie,
    viewerPrivateKey: c.privateKey }), /Not a conversation participant/);
  await assert.rejects(decryptDirectMessage({ ...common, viewerId: bob,
    viewerPrivateKey: c.privateKey }), /Could not decrypt/);
  await assert.rejects(decryptDirectMessage({ ...common, senderId: bob,
    recipientId: alice, viewerId: bob, viewerPrivateKey: b.privateKey }), /Could not decrypt/);
  await assert.rejects(decryptDirectMessage({ ...common, recipientId: charlie,
    viewerId: charlie, viewerPrivateKey: c.privateKey }), /Could not decrypt/);
  await assert.rejects(decryptDirectMessage({ ...common,
    payload: { ...payload, ciphertext: `${payload.ciphertext[0] === 'A' ? 'B' : 'A'}${payload.ciphertext.slice(1)}` },
    viewerId: bob, viewerPrivateKey: b.privateKey }), /Could not decrypt/);
  await assert.rejects(decryptDirectMessage({ ...common, recipientPublicKey: c.publicKey,
    viewerId: bob, viewerPrivateKey: b.privateKey }), /Chat key changed/);
  assert.notEqual(await fingerprintPublicKey(a.publicKey), await fingerprintPublicKey(b.publicKey));
});

test('a reset preserves the other participant’s access to old ciphertext', async () => {
  const oldAlice = await createChatIdentity(alice);
  const bobIdentity = await createChatIdentity(bob);
  const newAlice = await createChatIdentity(alice);
  assert.equal(await privateKeyMatchesPublic(oldAlice.privateKey, oldAlice.publicKey), true);
  assert.equal(await privateKeyMatchesPublic(newAlice.privateKey, oldAlice.publicKey), false);
  const payload = await encryptDirectMessage({
    plaintext: 'Before reset', senderId: alice, recipientId: bob,
    senderPrivateKey: oldAlice.privateKey, senderPublicKey: oldAlice.publicKey,
    recipientPublicKey: bobIdentity.publicKey,
  });
  const references = messageKeyReferences(payload, alice, bob);
  assert.equal(references[0].fingerprint, await fingerprintPublicKey(oldAlice.publicKey));
  assert.notEqual(references[0].fingerprint, await fingerprintPublicKey(newAlice.publicKey));
  const oldKeys = { payload, senderId: alice, recipientId: bob,
    senderPublicKey: oldAlice.publicKey, recipientPublicKey: bobIdentity.publicKey };
  assert.equal(await decryptDirectMessage({ ...oldKeys, viewerId: bob,
    viewerPrivateKey: bobIdentity.privateKey }), 'Before reset');
  await assert.rejects(decryptDirectMessage({ ...oldKeys, viewerId: alice,
    viewerPrivateKey: newAlice.privateKey }), /Could not decrypt/);
});
