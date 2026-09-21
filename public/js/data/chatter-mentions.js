// Source publication time decides reading order; capture time and sentiment do not.
export function newestMentions(posts) {
  return posts.map(post => {
    const at = Date.parse(post.at);
    return { post, at: Number.isFinite(at) ? at : -Infinity };
  }).sort((a, b) => (a.at === b.at ? String(a.post.id).localeCompare(String(b.post.id)) : b.at - a.at))
    .map(({ post }) => post);
}
