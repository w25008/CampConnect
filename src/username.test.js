import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFromEmail } from './username.js';

test('uses the part of the school email before the @', () => {
  assert.equal(handleFromEmail('w25009@osfl.ac.jp'), 'w25009');
});

test('ignores case and surrounding spaces', () => {
  assert.equal(handleFromEmail('  W25009@OSFL.AC.JP '), 'w25009');
});

test('replaces characters a username cannot contain', () => {
  assert.equal(handleFromEmail('sai.moe-1@osfl.ac.jp'), 'sai_moe_1');
});

test('makes sure the username starts with a letter', () => {
  assert.equal(handleFromEmail('25009@osfl.ac.jp'), 'u_25009');
});

test('keeps the username between 3 and 34 characters', () => {
  assert.equal(handleFromEmail('ab@osfl.ac.jp'), 'ab_');
  assert.equal(handleFromEmail(`${'a'.repeat(50)}@osfl.ac.jp`).length, 34);
});

test('always matches the database username rule', () => {
  for (const email of ['w25009@osfl.ac.jp', '1@osfl.ac.jp', '', 'x.y@osfl.ac.jp', `${'9'.repeat(60)}@osfl.ac.jp`]) {
    assert.match(handleFromEmail(email), /^[a-z][a-z0-9_]{2,33}$/, email);
  }
});
