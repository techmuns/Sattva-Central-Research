import {marketWindow} from '../../public/js/data/breakout-live-shared.js';

// GitHub's scheduled starts can arrive hours late. Keep one successor queued
// from 06:00 IST, preparing identities before the exchange opens. This extends
// runner ownership only; provider sampling retains the exchange collection window.
export function quoteRunnerActive(now = Date.now()) {
  const window = marketWindow(now);
  if (window.collect) return true;
  const minutes = new Date(now + 19800000).getUTCHours() * 60 + new Date(now + 19800000).getUTCMinutes();
  return minutes >= 360 && minutes < 555 && marketWindow(Date.parse(`${window.day}T12:00:00+05:30`)).collect;
}
