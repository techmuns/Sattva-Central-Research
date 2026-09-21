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
export function restoreChatterAlert(event) {
  if (event.feed !== 'chatter' || event.chatterReadingVersion === 1) return event;
  return { ...event, direction: 'neutral', headline: 'Public chatter (30-day snapshot)',
    signalReason: 'Saved snapshot sentiment has not been verified. Open the mentions for context.' };
}
