// Public Telegram message parsing. Only a matching embed proves a message exists.
export const CHANNEL_RE = /^[A-Za-z0-9_]{5,32}$/;
export const positiveId = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0;
export function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? all;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}
function attrs(tag) {
  const result = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3]);
  return result;
}
export function metaOf(html, property) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.property === property) return a.content ?? null;
  }
  return null;
}
function classContent(html, wanted) {
  const tags = /<([a-z][\w-]*)\b[^>]*>/gi;
  let found;
  while ((found = tags.exec(html))) {
    if (!(attrs(found[0]).class || '').split(/\s+/).includes(wanted)) continue;
    const start = tags.lastIndex;
    const balanced = new RegExp(`<(/?)${found[1]}\\b[^>]*>`, 'gi');
    balanced.lastIndex = start;
    let depth = 1, end;
    while ((end = balanced.exec(html))) {
      depth += end[1] ? -1 : 1;
      if (!depth) return html.slice(start, end.index);
    }
    return null;
  }
  return null;
}
function plain(html) {
  if (html === null) return null;
  return decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|blockquote)>/gi, '\n').replace(/<[^>]*>/g, '')).trim() || null;
}
export function parseEmbed(html, channel, id) {
  const posts = [...html.matchAll(/\bdata-post\s*=\s*["']([^"']+)["']/g)].map((m) => decodeEntities(m[1]));
  if (!posts.includes(`${channel}/${id}`)) {
    const error = plain(classContent(html, 'tgme_widget_message_error'));
    return { state: error === 'Post not found' ? 'missing' : 'error', reason: error || 'Unrecognised Telegram embed' };
  }
  // Ignore other widgets/footer dates. The requested data-post must precede this time element.
  const identity = new RegExp(`data-post\\s*=\\s*["']${channel}/${id}["']`).exec(html);
  const body = html.slice(identity.index + identity[0].length).split(/\bdata-post\s*=/)[0];
  const timeTag = body.match(/<time\b[^>]*>/i)?.[0];
  const timestamp = timeTag ? attrs(timeTag).datetime : null;
  const publishedAt = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
  if (!publishedAt) return { state: 'error', reason: 'Matching embed has no valid publication time' };
  const text = plain(classContent(body, 'tgme_widget_message_text'));
  const filename = plain(classContent(body, 'tgme_widget_message_document_title'));
  const attachment = filename ? { type: 'document', name: filename, size: plain(classContent(body, 'tgme_widget_message_document_extra')) } : null;
  const mediaType = attachment ? 'document' : /class=["'][^"']*tgme_widget_message_photo_wrap\b/.test(body) ? 'photo'
    : /class=["'][^"']*tgme_widget_message_video_player\b/.test(body) ? 'video' : null;
  return { state: 'post', post: { id, url: `https://t.me/${channel}/${id}`, text, publishedAt,
    contentStatus: text || attachment || mediaType ? 'available' : 'telegram-only',
    mediaType, attachments: attachment ? [attachment] : [] } };
}
export function permalinkText(html, signature) {
  const title = metaOf(html, 'og:title');
  const desc = metaOf(html, 'og:description');
  return desc && desc !== title && desc !== signature?.title && desc !== signature?.desc ? desc : null;
}
