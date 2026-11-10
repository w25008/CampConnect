import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContactKey, acceptContactKey, verifyContactKey } from './contactKeys.js';

// Minimal stand-in for localStorage.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: name => (data.has(name) ? data.get(name) : null),
    setItem: (name, value) => { data.set(name, String(value)); },
    data,
  };
}

const ME = 'me-id';
const FRIEND = 'friend-id';

test('first conversation needs no comparing: the key is remembered and nothing is flagged', () => {
  const storage = fakeStorage();
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-A'), { verified: false, changed: false });
  assert.equal(storage.getItem(`campconnect:seen-key:${ME}:${FRIEND}`), 'key-A');
});

test('opening the same conversation again stays quiet', () => {
  const storage = fakeStorage();
  checkContactKey(storage, ME, FRIEND, 'key-A');
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-A'), { verified: false, changed: false });
});

test('a different key later is flagged as changed, and keeps being flagged until accepted', () => {
  const storage = fakeStorage();
  checkContactKey(storage, ME, FRIEND, 'key-A');
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-B'), { verified: false, changed: true });
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-B'), { verified: false, changed: true });
});

test('accepting the new key clears the notice', () => {
  const storage = fakeStorage();
  checkContactKey(storage, ME, FRIEND, 'key-A');
  acceptContactKey(storage, ME, FRIEND, 'key-B');
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-B'), { verified: false, changed: false });
});

test('comparing by hand marks the key verified', () => {
  const storage = fakeStorage();
  checkContactKey(storage, ME, FRIEND, 'key-A');
  verifyContactKey(storage, ME, FRIEND, 'key-A');
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-A'), { verified: true, changed: false });
});

test('a verified contact whose key changes loses the verified mark and is flagged', () => {
  const storage = fakeStorage();
  verifyContactKey(storage, ME, FRIEND, 'key-A');
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-B'), { verified: false, changed: true });
});

test('keys verified before this feature existed count as already seen', () => {
  const storage = fakeStorage({ [`campconnect:verified-key:${ME}:${FRIEND}`]: 'key-A' });
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-A'), { verified: true, changed: false });
  assert.deepEqual(checkContactKey(storage, ME, FRIEND, 'key-B'), { verified: false, changed: true });
});

test('contacts and accounts are tracked separately', () => {
  const storage = fakeStorage();
  checkContactKey(storage, ME, FRIEND, 'key-A');
  assert.deepEqual(checkContactKey(storage, ME, 'someone-else', 'key-Z'), { verified: false, changed: false });
  assert.deepEqual(checkContactKey(storage, 'other-account', FRIEND, 'key-Q'), { verified: false, changed: false });
});
