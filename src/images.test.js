import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let removeResult = { data: [], error: null };
let uploadResult = { data: [], error: null };
let rejection;
const requests = [];
mock.module('./lib/supabase.js', {
  namedExports: {
    supabase: {
      storage: {
        from(bucket) {
          return {
            async upload(path, file, options) {
              requests.push({ bucket, path, file, options });
              if (rejection) throw rejection;
              return uploadResult;
            },
            async remove(paths) {
              requests.push({ bucket, paths });
              if (rejection) throw rejection;
              return removeResult;
            },
          };
        },
      },
    },
  },
});
const { removeImage, removeImages, uploadGif } = await import('./images.js');

test.beforeEach(() => {
  requests.length = 0;
  removeResult = { data: [], error: null };
  uploadResult = { data: [], error: null };
  rejection = undefined;
});

test('uploads GIF comments without converting away animation', async () => {
  const file = { type: 'image/gif', size: 1024 };
  const path = await uploadGif('post-images', 'student-id', file);
  assert.match(path, /^student-id\/\d+-[a-z0-9]+\.gif$/);
  assert.deepEqual(requests, [{
    bucket: 'post-images',
    path,
    file,
    options: { contentType: 'image/gif', cacheControl: '31536000' },
  }]);
});

test('removes only the supplied images and skips empty cleanup', async () => {
  await removeImages('post-images', []);
  await removeImages('post-images', undefined);
  await removeImage('avatars', null);
  assert.equal(requests.length, 0);
  await removeImages('post-images', ['owner/obsolete.jpg', 'owner/failed-upload.jpg']);
  await removeImage('avatars', 'owner/old-avatar.jpg');
  assert.deepEqual(requests, [
    { bucket: 'post-images', paths: ['owner/obsolete.jpg', 'owner/failed-upload.jpg'] },
    { bucket: 'avatars', paths: ['owner/old-avatar.jpg'] },
  ]);
});

test('surfaces Storage error results instead of silently succeeding', async () => {
  const error = new Error('Storage deletion denied');
  removeResult = { data: null, error };
  await assert.rejects(removeImages('post-images', ['owner/old.jpg']), failure => failure === error);
  await assert.rejects(removeImage('avatars', 'owner/old.jpg'), failure => failure === error);
});

test('preserves rejected network failures for the cleanup caller', async () => {
  rejection = new Error('Network unavailable');
  await assert.rejects(removeImage('avatars', 'owner/old.jpg'), failure => failure === rejection);
});
