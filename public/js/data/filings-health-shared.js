// Pure operational checks, shared by the Worker and the post-capture workflow gate.
// Success means no critical operational incident, not exhaustive provider coverage.
export const FILINGS_HEALTH_FILES = {
  company: 'filing-capture/index.json',
  announcements: 'corp-announcements.json',
  insider: 'insider-trades.json',
};
export const FILINGS_HEALTH_LIMITS = { runHours: 4, companyHours: 48, initialHours: 24, insiderHours: 3 };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const stamp = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function assessFilingsHealth(captures, { now = Date.now(), sources = Object.keys(FILINGS_HEALTH_FILES) } = {}) {
  const findings = [];
  const add = (source, code, severity, affected = [], count = affected.length || 1) => {
    findings.push({ source, code, severity, count, affected: affected.slice(0, 20) });
  };
  const age = (source, value, hours, code, affected = []) => {
    const time = stamp(value);
    if (!Number.isFinite(time) || time > now + 600000) add(source, 'invalid-check-time', 'critical', affected);
    else if (now - time > hours * 3600000) add(source, code, 'critical', affected);
  };
  for (const source of sources) {
    if (!Object.hasOwn(FILINGS_HEALTH_FILES, source)) throw new Error(`Unknown health source: ${source}`);
    const body = captures?.[source];
    if (!object(body)) { add(source, 'capture-unavailable', 'critical'); continue; }
    if (source === 'company') {
      if (body.version !== 1 || !Array.isArray(body.companies) || !body.companies.length || body.companies.some((c) => !object(c) || typeof c.ticker !== 'string' || !/^[A-Z0-9&._-]{1,80}$/.test(c.ticker)) || !object(body.sources)) {
        add(source, 'invalid-capture', 'critical'); continue;
      }
      age(source, body.lastRunFinishedAt, FILINGS_HEALTH_LIMITS.runHours, 'capture-job-overdue');
      if (body.portfolio?.liveRequested) {
        if (body.portfolio.status !== 'live' || body.portfolio.error) add(source, 'portfolio-sync-unavailable', 'critical');
        age(source, body.portfolio.checkedAt, FILINGS_HEALTH_LIMITS.runHours, 'portfolio-check-overdue');
      }
      if (body.registration?.liveRequested) {
        if (body.registration.error) add(source, 'company-registration-unavailable', 'critical');
        age(source, body.registration.checkedAt, FILINGS_HEALTH_LIMITS.runHours, 'company-registration-overdue');
      }
      for (const [kind, directory] of Object.entries(body.identitySources || {})) {
        if (!object(directory)) { add(source, 'invalid-capture', 'critical', [kind]); continue; }
        if (directory.error) add(source, 'identity-directory-unavailable', 'critical', [kind]);
        age(source, directory.checkedAt, 48, 'identity-directory-overdue', [kind]);
      }
      for (const kind of ['announcements', 'domestic']) {
        const name = `${source}/${kind}`, entries = body.sources[kind];
        if (!object(entries)) { add(name, 'capture-unavailable', 'critical'); continue; }
        const groups = new Map();
        const group = (code, severity, ticker) => {
          const key = `${severity}:${code}`;
          if (!groups.has(key)) groups.set(key, { code, severity, tickers: [] });
          groups.get(key).tickers.push(ticker);
        };
        let unavailableLinks = 0;
        for (const { ticker } of body.companies) {
          const entry = entries[ticker];
          if (!object(entry)) { group('company-unregistered', 'critical', ticker); continue; }
          unavailableLinks += Number(entry.unavailableLinks) || 0;
          if (entry.error) group(['no-token', 'unauthorised'].includes(entry.error.reason) ? 'authentication-failed' : 'source-read-failed', 'critical', ticker);
          else if (entry.skipped) group('partial-source-response', 'critical', ticker);
          else if (!entry.lastSuccessAt) {
            const registered = stamp(entry.registeredAt || body.createdAt);
            group('company-never-checked', Number.isFinite(registered) && registered <= now + 600000 && now - registered <= FILINGS_HEALTH_LIMITS.initialHours * 3600000 ? 'warning' : 'critical', ticker);
          } else {
            const time = stamp(kind === 'announcements' ? entry.recentCheckedAt || entry.lastSuccessAt : entry.lastSuccessAt);
            if (!Number.isFinite(time) || time > now + 600000) group('invalid-check-time', 'critical', ticker);
            else if (now - time > FILINGS_HEALTH_LIMITS.companyHours * 3600000) group('company-check-overdue', 'critical', ticker);
            if (kind === 'announcements' && !(Array.isArray(entry.ranges) && entry.ranges.some((r) => r && r.from <= body.requestedFrom && r.to >= body.requestedTo))) group('historical-backfill-pending', 'warning', ticker);
          }
        }
        for (const { code, severity, tickers } of groups.values()) add(name, code, severity, tickers);
        if (unavailableLinks) add(name, 'source-links-unavailable', 'warning', [], unavailableLinks);
      }
      if (body.stoppedForAuth && !findings.some((f) => f.code === 'authentication-failed')) add(source, 'authentication-failed', 'critical');
      if (Array.isArray(body.unresolved) && body.unresolved.length) add(source, 'company-identities-unresolved', 'warning', body.unresolved);
    } else {
      if (!object(body.byTicker)) { add(source, 'invalid-capture', 'critical'); continue; }
      const lists = Object.values(body.byTicker);
      if (!count(body.rowCount) || (!object(body.failed) && !Array.isArray(body.failed)) ||
          (Array.isArray(body.failed) && body.failed.some((failure) => typeof failure !== 'string' && !object(failure))) ||
          ['failedCount', 'fallbackCount'].some((key) => body[key] !== undefined && !count(body[key]))) add(source, 'invalid-capture', 'critical');
      if (lists.some((rows) => !Array.isArray(rows))) add(source, 'invalid-capture', 'critical');
      else if (Number.isFinite(body.rowCount) && body.rowCount !== lists.reduce((sum, rows) => sum + rows.length, 0)) add(source, 'row-count-mismatch', 'critical');
      age(source, body.capturedAt, source === 'insider' ? FILINGS_HEALTH_LIMITS.insiderHours : FILINGS_HEALTH_LIMITS.runHours, 'capture-overdue');
      const failures = object(body.failed) ? Object.keys(body.failed) : Array.isArray(body.failed) ? body.failed.map((f) => typeof f === 'string' ? f : f?.ticker || 'unknown') : [];
      if (failures.length || body.failedCount > 0) add(source, 'source-read-failed', 'critical', failures, Math.max(failures.length, body.failedCount || 0));
      if (source === 'announcements') {
        if (Array.isArray(body.shortfall) && body.shortfall.length) add(source, 'pagination-shortfall', 'critical', body.shortfall.map((s) => s?.category || 'unknown'));
        else if (body.shortfall != null && !Array.isArray(body.shortfall)) add(source, 'invalid-capture', 'critical');
        if (Object.keys(body.unknownCategories || {}).length) add(source, 'unknown-source-categories', 'critical', Object.keys(body.unknownCategories));
        if (body.coversUniverse !== true) add(source, 'exchange-coverage-unverified', 'critical');
      } else if (body.coversUniverse === true) {
        const required = new Set(['bulk', 'block', 'sast', 'insiders']);
        const sources = Array.isArray(body.sources) ? body.sources : [];
        const seen = new Set(sources.map((item) => item?.id).filter(Boolean));
        const invalid = sources.length !== required.size || sources.some((item) =>
          !object(item) || !required.has(item.id) || item.ok !== true || !count(item.rowCount) || !count(item.pagesRead) || item.pagesRead === 0 || !Number.isFinite(stamp(item.coverageFrom))
        );
        if (invalid || [...required].some((id) => !seen.has(id))) add(source, 'trade-category-coverage-unverified', 'critical');
        const categories = new Set(Array.isArray(body.categories) ? body.categories : []);
        const requiredCategories = ['Bulk deal', 'Block deal', 'SAST', 'Insider trade'];
        if (categories.size !== requiredCategories.length || requiredCategories.some((category) => !categories.has(category))) add(source, 'invalid-capture', 'critical');
        if (!object(body.fallback) || Object.keys(body.fallback).length || body.fallbackCount > 0) add(source, 'company-reads-incomplete', 'critical');
      } else {
        if (!count(body.asked) || body.asked === 0 || !count(body.covered) || body.covered > body.asked || !object(body.fallback)) add(source, 'invalid-capture', 'critical');
        const fallback = Object.keys(body.fallback || {});
        // Retained rows must not hide a failed or unfinished latest company read.
        if (fallback.length || body.fallbackCount > 0) add(source, 'company-reads-incomplete', 'critical', fallback, Math.max(fallback.length, body.fallbackCount || 0));
        if (Number.isFinite(body.asked) && (!Number.isFinite(body.covered) || body.covered < body.asked)) add(source, 'companies-uncovered', 'critical', [], Math.max(1, body.asked - (body.covered || 0)));
      }
    }
  }
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warnings = findings.length - critical;
  return { version: 1, ok: critical === 0, status: critical ? 'critical' : warnings ? 'degraded' : 'healthy',
    checkedAt: new Date(now).toISOString(), limits: FILINGS_HEALTH_LIMITS, sources, critical, warnings, findings };
}
