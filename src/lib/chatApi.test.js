import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatIdentity } from './e2ee.js';
import { wrapPrivateKey, unwrapPrivateKey } from './keyBackup.js';
import { ensureChatIdentity, registerChatIdentity } from './chatApi.js';

// e2ee.js persists the local chat key in IndexedDB, which Node does not
// have. Install a minimal in-memory stand-in before any chatApi call (the
// import above only defines functions; nothing touches IndexedDB yet).
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

// Minimal Supabase stand-in bound to one account (the RPCs key rows by
// auth.uid() server-side, so the fake does the same). Records RPC counts
// so tests can prove exactly one key registration happened.
function createFakeSupabase(userId) {
  const tables = {
    chat_public_keys: new Map(),
    chat_key_backups: new Map(),
    chat_password_backups: new Map(),
  };
  const calls = { register: 0, reset: 0, savePasswordBackup: 0 };
  function from(table) {
    let filterValue;
    const chain = {
      select() { return chain; },
      eq(_column, value) { filterValue = value; return chain; },
      async maybeSingle() {
        const row = tables[table].get(filterValue);
        return { data: row ? { ...row } : null, error: null };
      },
    };
    return chain;
  }
  async function rpc(name, args) {
    if (name === 'register_chat_identity' || name === 'reset_chat_identity') {
      calls[name === 'register_chat_identity' ? 'register' : 'reset'] += 1;
      tables.chat_public_keys.set(userId, { user_id: userId, public_key: args.p_public_key });
      tables.chat_key_backups.set(userId, { user_id: userId, encrypted_private_key: args.p_encrypted_private_key });
      return { error: null };
    }
    if (name === 'save_chat_password_backup') {
      calls.savePasswordBackup += 1;
      tables.chat_password_backups.set(userId, {
        user_id: userId, salt: args.p_salt, iv: args.p_iv, ciphertext: args.p_ciphertext,
        version: args.p_version, public_key_fingerprint: args.p_fingerprint,
      });
      return { error: null };
    }
    return { error: new Error(`Unexpected RPC: ${name}`) };
  }
  return { tables, calls, from, rpc };
}

// Put an existing key on the "server" for an account whose local device
// copy is gone, i.e. the account loads in 'restore' status.
async function seedRestorable(sb, userId, { withPasswordBackup = false } = {}) {
  const created = await createChatIdentity(userId);
  sb.tables.chat_public_keys.set(userId, { user_id: userId, public_key: created.publicKey });
  sb.tables.chat_key_backups.set(userId, { user_id: userId, encrypted_private_key: created.encryptedPrivateKey });
  if (withPasswordBackup) {
    const blob = await wrapPrivateKey(created.privateJwk, userId, created.publicKey, PASSWORD, created.recoveryCode);
    sb.tables.chat_password_backups.set(userId, { user_id: userId, ...blob });
  }
  return created;
}

const PASSWORD = 'school-password-42';

test('ensure creates and registers an identity for a brand-new account', async () => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sb = createFakeSupabase(userId);
  const identity = await ensureChatIdentity(sb, userId, PASSWORD);
  assert.equal(identity.status, 'ready');
  assert.ok(identity.privateKey);
  assert.equal(sb.calls.register, 1);
  // The public key is on the server, so classmates can encrypt to a
  // student who has never opened the Messages page.
  assert.deepEqual(sb.tables.chat_public_keys.get(userId).public_key, identity.publicKey);
  // A password sign-in also saves the v2 password backup (code included).
  assert.equal(sb.calls.savePasswordBackup, 1);
  const row = sb.tables.chat_password_backups.get(userId);
  assert.equal(row.public_key_fingerprint, identity.fingerprint);
  const { recoveryCode } = await unwrapPrivateKey(row, userId, identity.publicKey, PASSWORD);
  assert.equal(recoveryCode, identity.recoveryCode);
});

test('ensure without a password still enables chat; the backup comes later', async () => {
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sb = createFakeSupabase(userId);
  const identity = await ensureChatIdentity(sb, userId);
  assert.equal(identity.status, 'ready');
  assert.equal(sb.calls.register, 1);
  assert.equal(sb.calls.savePasswordBackup, 0);
});

test('concurrent ensures and the manual setup race into exactly one registration', async () => {
  const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const sb = createFakeSupabase(userId);
  const [a, b, manual] = await Promise.all([
    ensureChatIdentity(sb, userId, PASSWORD),
    ensureChatIdentity(sb, userId, PASSWORD),
    registerChatIdentity(sb, userId, PASSWORD),
  ]);
  assert.equal(sb.calls.register, 1);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.deepEqual(a.publicKey, manual.publicKey);
});

test('ensure is a no-op for an already-ready identity', async () => {
  const userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const sb = createFakeSupabase(userId);
  const first = await ensureChatIdentity(sb, userId, PASSWORD);
  const second = await ensureChatIdentity(sb, userId, PASSWORD);
  assert.equal(second.status, 'ready');
  assert.deepEqual(second.publicKey, first.publicKey);
  assert.equal(sb.calls.register, 1);
});

test('ensure never overwrites a restorable identity when no password is available', async () => {
  const userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const sb = createFakeSupabase(userId);
  const created = await seedRestorable(sb, userId);
  const identity = await ensureChatIdentity(sb, userId);
  assert.equal(identity.status, 'restore');
  assert.deepEqual(identity.publicKey, created.publicKey);
  assert.equal(sb.calls.register, 0);
  assert.equal(sb.calls.reset, 0);
});

test('ensure restores a locked identity with the sign-in password', async () => {
  const userId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const sb = createFakeSupabase(userId);
  const created = await seedRestorable(sb, userId, { withPasswordBackup: true });
  const identity = await ensureChatIdentity(sb, userId, PASSWORD);
  assert.equal(identity.status, 'ready');
  assert.deepEqual(identity.publicKey, created.publicKey);
  assert.equal(sb.calls.register, 0);
});

test('ensure with the wrong password leaves the restorable identity untouched', async () => {
  const userId = '12121212-1212-4212-8212-121212121212';
  const sb = createFakeSupabase(userId);
  const created = await seedRestorable(sb, userId, { withPasswordBackup: true });
  const identity = await ensureChatIdentity(sb, userId, 'not-the-password');
  assert.equal(identity.status, 'restore');
  assert.deepEqual(identity.publicKey, created.publicKey);
  assert.equal(sb.calls.register, 0);
  assert.equal(sb.calls.reset, 0);
});

test('ensure with a password but no password backup keeps the restore state', async () => {
  const userId = '34343434-3434-4343-8434-343434343434';
  const sb = createFakeSupabase(userId);
  const created = await seedRestorable(sb, userId);
  const identity = await ensureChatIdentity(sb, userId, PASSWORD);
  assert.equal(identity.status, 'restore');
  assert.deepEqual(identity.publicKey, created.publicKey);
  assert.equal(sb.calls.register, 0);
});
