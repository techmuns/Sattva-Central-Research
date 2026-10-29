import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessFilingsHealth, FILINGS_HEALTH_FILES, FILINGS_HEALTH_LIMITS } from '../public/js/data/filings-health-shared.js';
import { CAPTURE_FILES, CAPTURE_STATUS_FILE, FILINGS_HEALTH_PLAN_FILE, STATUS_BYTES, HEALTH_PLAN_BYTES, captureStatus } from '../worker/capture-status-contract.mjs';

// The assessor depends on time only through timestamp comparisons, its published
// hour limits, the four-hour recovery allowance and ten-minute future tolerance.
// Compile its exact answers at those boundaries on the runner. Readers can age a
// stopped publication indefinitely without loading records or freezing "healthy".
const OFFSETS = [...new Set([-600000, 0, ...Object.values(FILINGS_HEALTH_LIMITS).map(h => h * 3600000 + 1), 4 * 3600000 + 1])];
function deadlines(value, now, times) {
  if (typeof value === 'string') {
    const at = Date.parse(value);
    if (Number.isFinite(at)) for (const offset of OFFSETS) {
      const next = at + offset;
      if (next > now && next <= 8640000000000000) times.add(next);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      // The assessor checks record counts/flags, never dates inside these lists.
      if (!['byTicker', 'rows', 'posts'].includes(key)) deadlines(child, now, times);
    }
  }
}
export function prepareHealthPlan(captures, { now = Date.now() } = {}) {
  const sources = {}, definitions = [], dictionary = new Map();
  const encode = findings => findings.map(({ count, ...finding }) => {
    const key = JSON.stringify(finding);
    if (!dictionary.has(key)) { dictionary.set(key, definitions.length); definitions.push(finding); }
    return [dictionary.get(key), count];
  });
  for (const source of Object.keys(FILINGS_HEALTH_FILES)) {
    const times = new Set([now]);
    deadlines(captures?.[source], now, times);
    const steps = [];
    let previous;
    for (const at of [...times].sort((a, b) => a - b)) {
      const findings = assessFilingsHealth(captures, { now: at, sources: [source] }).findings;
      const signature = JSON.stringify(findings);
      if (signature !== previous) steps.push({ at, findings: encode(findings) });
      previous = signature;
    }
    sources[source] = steps;
  }
  return { sources, definitions };
}

export async function prepareCaptureStatus({ publicRoot = path.resolve('public'), now = Date.now(), sourceRevision = process.env.GITHUB_SHA || null } = {}) {
  const metadata = { version: 1, preparedAt: new Date(now).toISOString(), sourceRevision };
  const captures = {}, health = {}, files = new Map();
  // Sequential reads bound the runner's working set. Every source is assessed;
  // unavailable/invalid sources remain explicitly unavailable in both products.
  for (const file of new Set([...Object.values(CAPTURE_FILES), ...Object.values(FILINGS_HEALTH_FILES).map(file => `/data/${file}`)])) {
    let body;
    try { body = JSON.parse(await fs.readFile(path.join(publicRoot, file.slice(1)), 'utf8')); } catch { body = null; }
    files.set(file, body);
  }
  for (const [name, file] of Object.entries(CAPTURE_FILES)) {
    try { captures[name] = captureStatus(files.get(file)); }
    catch { captures[name] = { ok: false, capturedAt: null, reason: 'capture-unavailable' }; }
  }
  for (const [name, file] of Object.entries(FILINGS_HEALTH_FILES)) health[name] = files.get(`/data/${file}`);
  const products = [
    [CAPTURE_STATUS_FILE, { ...metadata, captures }, STATUS_BYTES],
    [FILINGS_HEALTH_PLAN_FILE, { ...metadata, ...prepareHealthPlan(health, { now }) }, HEALTH_PLAN_BYTES],
  ].map(([file, value, limit]) => {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > limit) throw new Error(`Prepared status exceeds its delivery budget: ${file}`);
    return [path.join(publicRoot, file.slice(1)), bytes];
  });
  // Prepare both products before replacing either. A preparation/write failure
  // fails the deploy step; no partial generation can be uploaded as successful.
  for (const [file, bytes] of products) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(`${file}.tmp`, bytes); }
  for (const [file] of products) await fs.rename(`${file}.tmp`, file);
  return products.map(([file, bytes]) => ({ file, bytes: Buffer.byteLength(bytes) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const products = await prepareCaptureStatus();
  console.log(JSON.stringify({ preparedStatus: products }));
}
