// worker/github-actions.mjs — the authenticated client that lets the Refresh button start a scrape.
//
//   dispatchWorkflow(fetchImpl, cfg)   POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches
//   latestRun(fetchImpl, cfg, file)    GET  /repos/{owner}/{repo}/actions/workflows/{file}/runs
//
// PURE AND DEPENDENCY-FREE, `fetch` a parameter — same arrangement as worker/mc.mjs and
// worker/finology.mjs, so the Worker, a Node script and a test can all use it and none of them can
// disagree about shape.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL, AND WHY IT IS THE ONLY WAY.
//
// `www.moneycontrol.com` refuses automated readers by TLS fingerprint: curl with a browser
// user-agent gets 200 and 598 KB, node's fetch gets 403 on every header set tried, and a
// Cloudflare Worker gets 403 as well. So neither the browser nor this Worker can read the page,
// and "refresh the news" cannot mean "go and fetch it". The only reader that works is a normal
// GitHub runner with curl — which means the honest implementation of that button is to ASK THE
// RUNNER TO RUN, then watch it. That is what this module does.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SPLIT THAT MATTERS: ONE CALL COSTS SOMEBODY ELSE WORK, THE OTHERS DO NOT.
//
// This is the Deep Dive rule (see CLAUDE.md, *Triggering someone else's pipeline*) applied to a
// pipeline that happens to be ours. `dispatchWorkflow` starts a real run on a real runner and
// makes a real request to Moneycontrol. `latestRun` is a plain read. So:
//
//   • DISPATCH IS ALWAYS EXPLICIT AND POST-ONLY. A button or the capture watchdog may call it only
//     after comparing the committed capture timestamp with that source's freshness window.
//   • A DISPATCH ASKS FIRST WHETHER A RUN IS ALREADY GOING. Their concurrency group would queue a
//     second one harmlessly, but not asking at all is the version that cannot start a run through
//     a bug of ours.
//   • THE WATCHING IS FREE, so it may poll — and it reports GITHUB'S OWN vocabulary
//     (queued / in_progress / completed + conclusion) rather than words of ours. Inventing a
//     progress model for someone else's pipeline drifts the moment they change it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE TOKEN NEVER LEAVES THE WORKER. `env.GH_DISPATCH_TOKEN`, injected here, exactly as
// `env.MUNS_TOKEN` is injected into worker/finology.mjs. A token shipped to the client is a token
// published; there is no obfuscated version of this that is not that. The repository, the owner
// and the workflow file are FIXED SERVER-SIDE and are not readable from the request, so this route
// cannot be pointed at another workflow or another repository by anyone who finds the URL.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// A 404 HERE IS AMBIGUOUS AND MUST SAY SO. This is the same trap as the chatter API's 404 (see
// CLAUDE.md, *An upstream you CANNOT proxy*): GitHub answers **404, not 403**, when a token simply
// cannot see a private repository — identical to the answer for a workflow file that does not
// exist. Two very different fixes behind one status. So `not-found` carries both readings and the
// URL that was asked for, because a failure state that cannot be diagnosed from its own artefact
// is half a failure state.

// `base` exists so a verification run — or a GitHub Enterprise deployment — can point somewhere
// else, exactly as `env.MUNS_BASE` redirects the Finology client. A suite that dispatched against
// the real API would be starting real runs on every push.
export const API = 'https://api.github.com';
export const NEWS_WORKFLOW = 'market-news-refresh.yml';
export const COMPANY_NEWS_WORKFLOW = 'company-news-refresh.yml';
export const INSIDER_WORKFLOW = 'insider-trades-refresh.yml';
export const ANNOUNCEMENTS_WORKFLOW = 'announcements-refresh.yml';
export const DATA_WORKFLOW = 'technicals-refresh.yml';
export const DEPLOY_WORKFLOW = 'deploy.yml';

// Six seconds is generous for api.github.com, which answers in well under one when healthy. Two
// attempts under an absolute deadline, exactly as finology.mjs does: the deadline is the promise
// this module makes, so a slow first attempt shortens the second rather than being added to it.
export const REQ_TIMEOUT_MS = 6000;
export const ATTEMPTS = 2;
export const DEADLINE_MS = 13000;
const BACKOFF_MS = 400;

const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * `owner/repo` -> `{ owner, repo }`, or a named failure.
 *
 * Validated rather than trusted: a misconfigured `GH_REPO` would otherwise reach GitHub as a
 * malformed path and come back as the same 404 a missing workflow gives, which is the one answer
 * that must not have a third meaning.
 */
export function parseRepo(value) {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(String(value || '').trim());
  if (!m) throw fail('No repository is configured for the news refresh.', 'no-repo', { configured: value || null });
  return { owner: m[1], repo: m[2] };
}

/** One authenticated request. Returns `{ status, body }`; throws only for a named failure. */
async function call(fetchImpl, { token, url, method = 'GET', body = null, deadlineAt, now = Date.now }) {
  if (!token) throw fail('No GitHub token is configured on the Worker.', 'no-token');

  let last = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const left = deadlineAt - now();
    if (left <= 0) break;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${token}`,
          // GitHub rejects a request with no user-agent outright. Naming the caller is also what
          // makes this identifiable in their audit log if it ever misbehaves.
          'user-agent': 'sattva-central-research-worker',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(Math.min(REQ_TIMEOUT_MS, left)),
      });

      if (res.status === 401) throw fail('GitHub rejected the token.', 'unauthorised', { url });
      if (res.status === 403) {
        // 403 here is a permissions or rate-limit answer, and the two have different fixes.
        const remaining = res.headers.get('x-ratelimit-remaining');
        if (remaining === '0') throw fail('GitHub rate limit reached for this token.', 'rate-limited', { url });
        throw fail('The token is not allowed to do this.', 'forbidden', { url });
      }
      if (res.status === 404) {
        throw fail(
          'GitHub answered 404. That means EITHER the workflow file does not exist on that branch, ' +
            'OR the token cannot see this repository — GitHub returns 404 rather than 403 for a ' +
            'private repository a token has no access to, so both readings fit the same answer.',
          'not-found',
          { url },
        );
      }
      if (res.status === 422) {
        // Workflow disabled, or the ref does not exist. Their message is the useful part.
        const detail = await res.text().catch(() => '');
        throw fail(`GitHub refused the request: ${detail.slice(0, 300)}`, 'refused', { url });
      }
      if (TRANSIENT_STATUS.has(res.status)) {
        last = fail(`GitHub answered ${res.status}.`, 'upstream', { url, status: res.status });
        await sleep(BACKOFF_MS);
        continue;
      }
      if (!res.ok) throw fail(`GitHub answered ${res.status}.`, 'upstream', { url, status: res.status });

      // 204 (a dispatch) has no body at all, which is success and must not be parsed.
      if (res.status === 204) return { status: 204, body: null };
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (err.code && err.code !== 'upstream') throw err; // an answer, not a blip
      last = err.name === 'TimeoutError' || err.name === 'AbortError' ? fail('GitHub did not answer in time.', 'timeout', { url }) : err.code ? err : fail(String(err?.message || err), 'unreachable', { url });
      if (attempt < ATTEMPTS - 1) await sleep(BACKOFF_MS);
    }
  }
  throw last || fail('GitHub could not be reached.', 'unreachable');
}

/** Runs of one workflow, newest first. A free read — this is the half that may be polled. */
export async function latestRun(fetchImpl, { token, owner, repo, base = API, now = Date.now }, workflow, { perPage = 3 } = {}) {
  const url = `${base}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`;
  const { body } = await call(fetchImpl, { token, url, deadlineAt: now() + DEADLINE_MS, now });
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  return runs.map(shapeRun);
}

/**
 * Their own fields, renamed to nothing.
 *
 * `status` and `conclusion` are GitHub's vocabulary and are passed through untouched, so the panel
 * can reproduce their words rather than translating them into ours — the StockScans rule, applied
 * to a progress model instead of a score.
 */
function shapeRun(r) {
  return {
    id: r?.id ?? null,
    status: r?.status ?? null, // queued | in_progress | completed
    // The workflow's own run name, which carries what drove it (cron / button / github-cron).
    title: typeof r?.display_title === 'string' ? r.display_title : null,
    conclusion: r?.conclusion ?? null, // success | failure | cancelled | skipped | …
    event: r?.event ?? null,
    createdAt: r?.created_at ?? null,
    updatedAt: r?.updated_at ?? null,
    url: typeof r?.html_url === 'string' && /^https:\/\//.test(r.html_url) ? r.html_url : null,
  };
}

export const isInFlight = (run) => !!run && (run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'requested' || run.status === 'pending');

/**
 * Start a run. THE ONE CALL IN THIS FILE THAT COSTS ANYBODY ANYTHING.
 *
 * Returns `{ dispatched: true }`, or `{ dispatched: false, run }` when one was already going —
 * which is not a failure and must not be reported as one.
 */
export async function dispatchWorkflow(fetchImpl, cfg, workflow, ref, inputs = null) {
  const { token, owner, repo, base = API, now = Date.now } = cfg;

  // ASK BEFORE STARTING. Their concurrency group would queue a duplicate harmlessly, so this is
  // not about correctness upstream — it is about this dashboard never being the thing that started
  // a run nobody needed.
  const existing = await latestRun(fetchImpl, cfg, workflow, { perPage: 1 }).catch(() => null);
  if (existing && isInFlight(existing[0])) return { dispatched: false, run: existing[0] };

  const url = `${base}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  // `inputs` carries who asked — the workflow puts it in its own run name, so the runs list says
  // whether the cadence is holding on its own or whether every refresh was somebody pressing a
  // button. That question was answered wrongly twice for want of exactly this.
  const body = inputs ? { ref, inputs } : { ref };
  await call(fetchImpl, { token, url, method: 'POST', body, deadlineAt: now() + DEADLINE_MS, now });
  return { dispatched: true, run: null };
}
