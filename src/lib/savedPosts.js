export function orderVisibleSavedPosts(savedPostIds, visiblePosts) {
  const postsById = new Map(visiblePosts.map(post => [post.id, post]));
  return savedPostIds.flatMap(id => {
    const post = postsById.get(id);
    return post ? [post] : [];
  });
}
