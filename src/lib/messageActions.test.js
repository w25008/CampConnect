import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerChatIdentity, loadEncryptedConversation, sendEncryptedMessage,
  editEncryptedMessage, deleteEncryptedMessage, getRecipientChatKey,
  MessageActionsSetupError,
} from './chatApi.js';

// Same minimal IndexedDB stand-in as chatApi.test.js (Node has none).
function installFakeIndexedDB() {
  const databases = new Map();
  class FakeRequest {
    constructor() {
      this.result = undefined; this.error = null;
      this.onsuccess = null; this.onerror = null; this.onupgradeneeded = null;
    }
    succeed(result) {
      this.result = result;
      queueMicrotask(() => { if (this.onsuccess) this.onsuccess(); });
    }
  }
  class FakeObjectStore {
    constructor(transaction, map) { this.transaction = transaction; this.map = map; }
    put(value, key) {
      const request = new FakeRequest();
      this.transaction.enqueue(() => { this.map.set(key, value); request.succeed(key); });
      return request;
    }
    get(key) {
      const request = new FakeRequest();
      this.transaction.enqueue(() => request.succeed(this.map.get(key)));
      return request;
    }
    delete(key) {
      const request = new FakeRequest();
      this.transaction.enqueue(() => { this.map.delete(key); request.succeed(undefined); });
      return request;
    }
  }
  class FakeTransaction {
    constructor(map) {
      this.map = map; this.pending = 0; this.error = null;
      this.oncomplete = null; this.onerror = null; this.onabort = null;
    }
    objectStore() { return new FakeObjectStore(this, this.map); }
    enqueue(work) {
      this.pending += 1;
      queueMicrotask(() => {
        work();
        this.pending -= 1;
        if (this.pending === 0) queueMicrotask(() => { if (this.oncomplete) this.oncomplete(); });
      });
    }
  }
  class FakeDatabase {
    constructor() { this.stores = new Map(); }
    createObjectStore(name) { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
    transaction(name) {
      if (!this.stores.has(name)) this.stores.set(name, new Map());
      return new FakeTransaction(this.stores.get(name));
    }
    close() {}
  }
  globalThis.indexedDB = {
    open(name) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (isNew) { db = new FakeDatabase(); databases.set(name, db); }
        request.result = db;
        if (isNew && request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}
installFakeIndexedDB();

// One shared fake "server" (tables + RPC behaviour mirroring migrations
// 0008/0023) with per-user clients, because the RPCs key their checks by
// auth.uid(). Only the conversation between the two test users exists, so
// the conversation query returns the whole messages table newest-first.
function makeServer() {
  return {
    keys: new Map(), backups: new Map(), history: [], messages: [],
    rpcCalls: [], clock: 0,
  };
}

function makeClient(server, uid) {
  function from(table) {
    const filters = [];
    const chain = {
      select() { return chain; },
      eq(column, value) { filters.push(row => row[column] === value); return chain; },
      in(column, values) { filters.push(row => values.includes(row[column])); return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      insert(row) {
        server.clock += 1;
        server.messages.push({
          id: `msg-${server.clock}`, body: null, read_at: null, edited_at: null,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, server.clock)).toISOString(),
          ...row,
        });
        return Promise.resolve({ error: null });
      },
      async maybeSingle() {
        const tableMap = table === 'chat_public_keys' ? server.keys : server.backups;
        const wanted = filters.length ? [...tableMap.values()].filter(row => filters.every(f => f(row))) : [];
        return { data: wanted[0] ? { ...wanted[0] } : null, error: null };
      },
      then(resolve) {
        let rows = [];
        if (table === 'chat_key_history') rows = server.history.filter(row => filters.every(f => f(row)));
        if (table === 'direct_messages') rows = [...server.messages].reverse();
        resolve({ data: rows.map(row => ({ ...row })), error: null });
      },
    };
    return chain;
  }
  async function rpc(name, args) {
    server.rpcCalls.push(name);
    if (name === 'register_chat_identity' || name === 'reset_chat_identity') {
      server.keys.set(uid, { user_id: uid, public_key: args.p_public_key });
      server.backups.set(uid, { user_id: uid, encrypted_private_key: args.p_encrypted_private_key });
      server.history.push({ user_id: uid, fingerprint: args.p_fingerprint, public_key: args.p_public_key });
      return { error: null };
    }
    if (name === 'edit_direct_message') {
      const row = server.messages.find(m => m.id === args.p_message_id);
      if (!row || row.sender_id !== uid || row.encryption_version !== 1) {
        return { error: { message: 'Only the sender can edit an encrypted message' } };
      }
      row.encrypted_payload = args.p_encrypted_payload;
      row.edited_at = '2026-01-02T00:00:00.000Z';
      return { error: null };
    }
    if (name === 'delete_direct_message') {
      const index = server.messages.findIndex(m => m.id === args.p_message_id);
      if (index < 0 || server.messages[index].sender_id !== uid) {
        return { error: { message: 'Only the sender can delete this message' } };
      }
      server.messages.splice(index, 1);
      return { error: null };
    }
    return { error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
  }
  return { from, rpc };
}

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function setupPair() {
  const server = makeServer();
  const aliceSb = makeClient(server, ALICE);
  const bobSb = makeClient(server, BOB);
  const aliceIdentity = await registerChatIdentity(aliceSb, ALICE);
  const bobIdentity = await registerChatIdentity(bobSb, BOB);
  const aliceKey = await getRecipientChatKey(aliceSb, BOB);
  const bobKey = await getRecipientChatKey(bobSb, ALICE);
  return { server, aliceSb, bobSb, aliceIdentity, bobIdentity, aliceKey, bobKey };
}

test('reply, forward, edit and delete across a conversation', async () => {
  const { server, aliceSb, bobSb, aliceIdentity, bobIdentity, aliceKey, bobKey } = await setupPair();

  // Plain send: no envelope fields surface.
  await sendEncryptedMessage(aliceSb, ALICE, BOB, 'first message', aliceIdentity, aliceKey.fingerprint);
  let view = await loadEncryptedConversation(bobSb, BOB, ALICE, bobIdentity);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].text, 'first message');
  assert.equal(view.messages[0].replyTo, null);
  assert.equal(view.messages[0].forwarded, false);
  const original = view.messages[0];

  // Reply: the quote metadata travels inside Bob's ciphertext.
  await sendEncryptedMessage(bobSb, BOB, ALICE, 'replying to first', bobIdentity, bobKey.fingerprint, {
    replyTo: { id: original.id, senderId: ALICE, snippet: original.text },
  });
  view = await loadEncryptedConversation(aliceSb, ALICE, BOB, aliceIdentity);
  const reply = view.messages.find(m => m.text === 'replying to first');
  assert.ok(reply);
  assert.equal(reply.replyTo.id, original.id);
  assert.equal(reply.replyTo.senderId, ALICE);
  assert.equal(reply.replyTo.snippet, 'first message');

  // Forward: Bob forwards Alice's text back, marked forwarded, no quote.
  await sendEncryptedMessage(bobSb, BOB, ALICE, original.text, bobIdentity, bobKey.fingerprint, { forwarded: true });
  view = await loadEncryptedConversation(aliceSb, ALICE, BOB, aliceIdentity);
  const forwarded = view.messages.filter(m => m.forwarded);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].text, 'first message');
  assert.equal(forwarded[0].replyTo, null);
  // No plaintext ever reached the "server".
  assert.equal(JSON.stringify(server.messages).includes('first message'), false);

  // Edit: Alice rewrites her own message; Bob sees the new text + edited_at,
  // and the reply Bob sent still points at the same message id.
  const aliceView = await loadEncryptedConversation(aliceSb, ALICE, BOB, aliceIdentity);
  const mine = aliceView.messages.find(m => m.id === original.id);
  await editEncryptedMessage(aliceSb, ALICE, mine, 'first message (edited)', aliceIdentity);
  assert.ok(server.rpcCalls.includes('edit_direct_message'));
  view = await loadEncryptedConversation(bobSb, BOB, ALICE, bobIdentity);
  const edited = view.messages.find(m => m.id === original.id);
  assert.equal(edited.text, 'first message (edited)');
  assert.equal(edited.edited_at, '2026-01-02T00:00:00.000Z');

  // Bob cannot edit Alice's message.
  await assert.rejects(
    editEncryptedMessage(bobSb, BOB, { ...edited, recipient_id: ALICE }, 'hijack', bobIdentity),
    /can only edit your own/);

  // Delete for everyone: Alice removes the message; Bob's history loses it,
  // while his reply survives and keeps its embedded quote snippet.
  await deleteEncryptedMessage(aliceSb, original.id);
  assert.ok(server.rpcCalls.includes('delete_direct_message'));
  view = await loadEncryptedConversation(bobSb, BOB, ALICE, bobIdentity);
  assert.equal(view.messages.some(m => m.id === original.id), false);
  const survivingReply = view.messages.find(m => m.text === 'replying to first');
  assert.ok(survivingReply);
  assert.equal(survivingReply.replyTo.snippet, 'first message');
});

test('edit preserves the original reply metadata', async () => {
  const { aliceSb, bobSb, aliceIdentity, bobIdentity, aliceKey, bobKey } = await setupPair();
  await sendEncryptedMessage(aliceSb, ALICE, BOB, 'base', aliceIdentity, aliceKey.fingerprint);
  let view = await loadEncryptedConversation(bobSb, BOB, ALICE, bobIdentity);
  const base = view.messages[0];
  await sendEncryptedMessage(bobSb, BOB, ALICE, 'quoted reply', bobIdentity, bobKey.fingerprint, {
    replyTo: { id: base.id, senderId: ALICE, snippet: 'base' },
  });
  const bobView = await loadEncryptedConversation(bobSb, BOB, ALICE, bobIdentity);
  const own = bobView.messages.find(m => m.text === 'quoted reply');
  await editEncryptedMessage(bobSb, BOB, own, 'quoted reply (fixed)', bobIdentity);
  view = await loadEncryptedConversation(aliceSb, ALICE, BOB, aliceIdentity);
  const after = view.messages.find(m => m.text === 'quoted reply (fixed)');
  assert.ok(after);
  assert.equal(after.replyTo.id, base.id);
  assert.equal(after.edited_at, '2026-01-02T00:00:00.000Z');
});

test('missing 0023 RPCs surface as MessageActionsSetupError', async () => {
  const server = makeServer();
  const aliceSb = makeClient(server, ALICE);
  // A client whose rpc() reports every function as missing (pre-0023 DB).
  const staleSb = { from: aliceSb.from, rpc: async name => ({ error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }) };
  await assert.rejects(deleteEncryptedMessage(staleSb, 'msg-1'), MessageActionsSetupError);
});
