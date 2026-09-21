// A description of the source's tags, never a new interpretation of a headline.
// Keep SentimentDash's original score/label separately for provenance. Its net
// score can be negative even when most mentions are neutral or newer ones bullish.
export function chatterSentiment(counts, total) {
  const keys = ['bullish', 'bearish', 'neutral'];
  const valid = Number.isSafeInteger(total) && total > 0 && keys.every(key =>
    Number.isSafeInteger(counts?.[key]) && counts[key] >= 0) &&
    keys.reduce((sum, key) => sum + counts[key], 0) === total;
  if (!valid) return { label: 'unconfirmed', labelText: 'Unconfirmed', direction: 'neutral',
    reason: 'A complete sentiment split is not available; no direction is inferred.' };
  const { bullish, bearish, neutral } = counts;
  // Opposing tags are mixed regardless of the provider's net-score threshold.
  // A one-sided minority cannot overrule the neutral majority (or a tie).
  const label = bullish && bearish ? 'mixed' : bullish > total / 2 ? 'bullish'
    : bearish > total / 2 ? 'bearish' : 'neutral';
  const labelText = { mixed: 'Mixed', bullish: 'Bullish', bearish: 'Bearish', neutral: 'Neutral' }[label];
  return { label, labelText, direction: label === 'bullish' ? 'positive' : label === 'bearish' ? 'negative' : 'neutral',
    reason: `${bullish} bullish, ${bearish} bearish, ${neutral} neutral source tags.` +
      (label === 'mixed' ? ' Both bullish and bearish mentions are present.' : '') +
      (neutral > total / 2 ? ' Most mentions are tagged neutral.' : '') };
}

export function mentionSentiment(posts, { complete = false, total = posts.length } = {}) {
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const post of posts) if (Object.hasOwn(counts, post.sentiment)) counts[post.sentiment]++;
  return chatterSentiment(counts, complete && posts.length === total ? total : null);
}

// Old materialized alerts omitted source records, so their broad directional
// headline cannot be verified offline. Retain the observation, not its verdict.
export function chatterTopic(event) {
  const topic = event.chatterTopic || event.sourceRecord?.slug ||
    (event.feed === 'chatter' ? /^chatter:([^:]+):/.exec(event.id || '')?.[1] :
      event.feed === 'chatter-posts' ? /:([^:]+)$/.exec(event.id || '')?.[1] : null);
  return typeof topic === 'string' && /^[a-z0-9][a-z0-9._-]{0,160}$/i.test(topic) ? topic.toLowerCase() : null;
}

export function restoreChatterAlert(event) {
  if (event.feed !== 'chatter' || event.chatterReadingVersion === 1) return event;
  // All Alerts retained full source records, unlike the bounded AI cache. A
  // complete saved split is still evidence during an outage; only freshness is
  // unconfirmed. Recompute its reading without advancing any date/check time.
  const reading = chatterSentiment(event.sourceRecord?.sentiment, event.sourceRecord?.mentions);
  if (reading.label !== 'unconfirmed') {
    const reason = `Saved 30-day snapshot: ${reading.reason} Keyword-based source tags, not the latest mention's direction or an investment assessment.`;
    return { ...event, chatterTopic: chatterTopic(event), chatterReadingVersion: 1,
      direction: reading.direction, severity: reading.direction === 'negative' ? 'alert' : 'update',
      headline: `${reading.labelText} public chatter (30d snapshot)`,
      detail: `${reading.reason}${event.detail ? ` ${event.detail}` : ''}`, signalReason: reason, reason };
  }
  const reason = 'Saved snapshot sentiment has not been verified. Open the mentions for context.';
  return { ...event, chatterTopic: chatterTopic(event), direction: 'neutral', severity: 'update',
    headline: 'Public chatter (30-day snapshot)', signalReason: reason, reason };
}
