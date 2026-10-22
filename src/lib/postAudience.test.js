import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudienceEditPayload } from './postAudience.js';

const post = {
  id: 'post-1',
  body: '  Updated post  ',
  keep: ['student/image-1.png'],
  groupId: 'group-1',
  recipients: [{ id: 'student-1' }, { id: 'student-2' }],
};

test('school audience keeps existing images and appends newly uploaded images', () => {
  assert.deepEqual(buildAudienceEditPayload({ ...post, audience: 'school' }, ['student/image-2.png']), {
    p_post_id: 'post-1',
    p_body: 'Updated post',
    p_audience: 'school',
    p_user_ids: null,
    p_group_id: null,
    p_image_paths: ['student/image-1.png', 'student/image-2.png'],
  });
});

test('selected audience sends only selected student ids and no images or group', () => {
  assert.deepEqual(buildAudienceEditPayload({ ...post, audience: 'selected' }), {
    p_post_id: 'post-1',
    p_body: 'Updated post',
    p_audience: 'selected',
    p_user_ids: ['student-1', 'student-2'],
    p_group_id: null,
    p_image_paths: [],
  });
});

test('group audience sends the group id and no selected students or images', () => {
  assert.deepEqual(buildAudienceEditPayload({ ...post, audience: 'group' }), {
    p_post_id: 'post-1',
    p_body: 'Updated post',
    p_audience: 'group',
    p_user_ids: null,
    p_group_id: 'group-1',
    p_image_paths: [],
  });
});
