#!/usr/bin/env node
// Read-only comparison on the actual collection network. No credentials, writes or dispatches.
//
// Two answers, in this order:
//   1. WHICH HEADER BSE'S FILTER TURNS ON TODAY — one request per variant of the current profile,
//      each with one header removed or changed. The 1 October 2026 refusal took days to explain
//      because only two whole profiles were ever compared; this names the header in one run.
//   2. Whether the previous and current profiles each read complete results (check-bse-access.mjs).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annUrl, bseRequestHeaders, chromeBrands } from '../worker/bse-ann.mjs';
import { checkBseAccess } from './check-bse-access.mjs';
import { bseIndiaDay } from './lib/bse-collection.mjs';

// The profile BSE accepted from GitHub runners on the morning of 29 September 2026 and refused
// that evening: a retired page as Referer, no Accept-Language and no client hints.
export const PREVIOUS_PROFILE = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  origin: 'https://www.bseindia.com',
  referer: 'https://www.bseindia.com/corporates/ann.html',
  'sec-fetch-site': 'same-site',
  accept: 'application/json, text/plain, */*',
};

// The filter scores how browser-like a request is as well as applying hard rules, so a header can
// matter only together with its siblings: on 1 October 2026 no single client hint was required, but
// removing all three was refused by one client and accepted by another. Groups are tried whole too.
const HEADER_GROUPS = {
  'client hints': ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'],
  'fetch metadata': ['sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'],
};
const without = (headers, names) => Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));

/**
 * The current profile, then that profile with one header or one group removed, or one value changed.
 * Node's fetch supplies its own accept, accept-language ('*'), sec-fetch-mode and user-agent ('node')
 * when they are absent, so "without" those four means Node's value rather than none.
 */
export function profileVariants(headers) {
  const variants = [['current', headers]];
  for (const name of Object.keys(headers)) variants.push([`without ${name}`, without(headers, [name])]);
  for (const [group, names] of Object.entries(HEADER_GROUPS)) variants.push([`without ${group}`, without(headers, names)]);
  // The refusal of 29 September 2026: a page BSE retired, which only scripts still name.
  variants.push(['retired Referer /corporates/ann.html', { ...headers, referer: 'https://www.bseindia.com/corporates/ann.html' }]);
  // A year of releases behind: flips to refused if the old-browser cutoff moves toward the present.
  const major = Number(String(headers['user-agent'] || '').match(/Chrome\/(\d+)/)?.[1]);
  if (Number.isSafeInteger(major)) {
    const old = major - 13;
    variants.push([`Chrome ${old}`, { ...headers,
      'user-agent': headers['user-agent'].replace(/Chrome\/\d+/, `Chrome/${old}`), 'sec-ch-ua': chromeBrands(old) }]);
  }
  return variants;
}

// Accepted means a JSON result set, not merely a 200: a redirect is never followed (it would land on
// BSE's home page and read as success), and an HTML challenge page with a 200 is still a refusal.
async function outcomeOf(response) {
  if (response.status !== 200) {
    await response.body?.cancel();
    return `HTTP ${response.status}`;
  }
  try { return Array.isArray(JSON.parse(await response.text())?.Table) ? 'accepted' : 'HTTP 200 without a result set'; }
  catch { return 'HTTP 200 that is not JSON'; }
}

export async function diagnoseBseProfile({ headers = bseRequestHeaders(), url, fetchImpl = fetch, gapMs = 1000, now = Date.now() } = {}) {
  if (!url) {
    const day = bseIndiaDay(now - 86_400_000);
    url = annUrl({ category: 'Result', from: day, to: day });
  }
  const results = {};
  for (const [label, variant] of profileVariants(headers)) {
    try {
      results[label] = await outcomeOf(await fetchImpl(url, { headers: variant, redirect: 'manual', signal: AbortSignal.timeout(20_000) }));
    } catch (error) {
      results[label] = `unreadable: ${error?.message || error}`;
    }
    if (gapMs) await new Promise((done) => setTimeout(done, gapMs));
  }
  const accepted = results.current === 'accepted';
  return {
    url, accepted,
    // Only meaningful while the current profile is accepted. When it is refused too, no single
    // header explains the refusal, and the answer lies elsewhere: cookies, network, or a new rule.
    required: accepted
      ? Object.entries(results).filter(([label, outcome]) => label.startsWith('without ') && outcome !== 'accepted').map(([label]) => label.slice('without '.length))
      : null,
    results,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const previousIdentities = JSON.parse(readFileSync(new URL('../public/data/announcement-identities.json', import.meta.url), 'utf8'));
  const now = Date.now();
  const diagnosis = await diagnoseBseProfile({ now });
  console.log(JSON.stringify({ diagnosis }, null, 2));
  if (!diagnosis.accepted) {
    console.log('The current profile is refused and no single header explains it: compare these outcomes with the 1 October 2026 rules in docs/BSE-COLLECTION.md.');
  }
  for (const [profile, headers] of [['previous', PREVIOUS_PROFILE], ['current', bseRequestHeaders(now)]]) {
    try {
      const result = await checkBseAccess({ previousIdentities, now,
        to: process.env.BSE_PROBE_TO, scripCode: process.env.BSE_PROBE_SCRIP || '522287',
        fetchImpl: (url, options) => fetch(url, { ...options, headers }),
      });
      console.log(JSON.stringify({ profile, ...result }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({ profile, ok: false, message: error.message }));
      if (profile === 'current') process.exitCode = 1;
    }
  }
}
