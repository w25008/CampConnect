import test from 'node:test';
import assert from 'node:assert/strict';
import { orderVisibleSavedPosts } from './savedPosts.js';

test('saved posts keep the user’s save order and omit posts hidden by visibility rules', () => {
  const first = { id: 'first', body: 'First saved' };
  const second = { id: 'second', body: 'Second saved' };
  assert.deepEqual(orderVisibleSavedPosts(['second', 'hidden', 'first'], [first, second]), [second, first]);
});

test('an empty saved list stays empty', () => {
  assert.deepEqual(orderVisibleSavedPosts([], [{ id: 'post' }]), []);
});
