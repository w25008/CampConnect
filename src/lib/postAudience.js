export function buildAudienceEditPayload(post, uploadedPaths = []) {
  return {
    p_post_id: post.id,
    p_body: post.body.trim(),
    p_audience: post.audience,
    p_user_ids: post.audience === 'selected' ? post.recipients.map(person => person.id) : null,
    p_group_id: post.audience === 'group' ? post.groupId : null,
    p_image_paths: post.audience === 'school' ? [...post.keep, ...uploadedPaths] : [],
  };
}
