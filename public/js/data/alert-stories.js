import { readEntry, writeEntry } from '../core/store.js';
import { boundedJson } from './family-book-contract.js';
import { STORY_VERSION, STORY_BATCH, STORY_BYTES, STORY_HISTORY_DAYS, STORY_FEEDS, storyBytes, storyRecord, storyKey, storyDigest,
  exactStoryCopy, sameDevelopmentSafe, genericStory, validateStoryGroups } from './alert-stories-shared.js';

const CACHE = 'ai-alerts:story-decisions:v1';
const order = (a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || storyKey(a).localeCompare(storyKey(b));

/** The only persistent inputs are public source text and its checked membership, never a card/book. */
export function createStoryGrouping({ read = readEntry, write = writeEntry, fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const decisions = new Map(), listeners = new Set(), failures = new Map();
  let loading, running, waiting, revision = 0, sequence = 0, checking = false, attempted = false;
  let historyRevision = -1, histories = new Map();
  const emit = () => { revision++; for (const fn of listeners) { try { fn(); } catch { /* A view cannot break saved readings. */ } } };
  const cutoff = () => new Date(now() - STORY_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  async function load() {
    if (!loading) loading = (async () => {
      try {
        const saved = (await read(CACHE))?.value;
        if (saved?.version === STORY_VERSION && Array.isArray(saved.entries)) for (const entry of saved.entries) {
          if ((entry?.first?.day || entry?.record?.day) >= cutoff() && /^s:[a-f0-9]{64}$/.test(entry.story || '') && /^d:[a-f0-9]{64}$/.test(entry.development || '') &&
              typeof entry.record.headline === 'string' && typeof entry.record.text === 'string') {
            decisions.set(storyKey(entry.record), entry);
            if (Number.isSafeInteger(entry.sequence) && entry.sequence > sequence) sequence = entry.sequence;
          }
        }
      } catch { /* Sources remain usable when the optional reading cache is unavailable. */ }
      emit();
    })();
    return loading;
  }
  function decision(record) { return decisions.get(storyKey(record)); }
  function records(events) {
    return [...new Map(events.map(storyRecord).filter(Boolean).map(r => [storyKey(r), r])).values()];
  }
  function status(events) {
    const rows = records(events), reviewed = rows.filter(r => decision(r)).length;
    const unchecked = events.filter(e => STORY_FEEDS.has(e.feed) && !e.private && !e.portfolioOnly && !storyRecord(e)).length;
    return { total: rows.length + unchecked, reviewed, checking, partial: reviewed < rows.length + unchecked, historyDays: STORY_HISTORY_DAYS };
  }
  async function save() {
    for (const [key, entry] of decisions) if ((entry.first?.day || entry.record.day) < cutoff()) decisions.delete(key);
    await write(CACHE, { value: { version: STORY_VERSION, entries: [...decisions.values()] } });
  }
  async function accept(groups, reports) {
    const byId = new Map(reports.map(r => [r.id, r]));
    for (const story of groups) {
      const all = story.developments.flatMap(d => d.reports.map(id => byId.get(id))).sort(order);
      const storyId = all.find(r => r.known)?.known.story || `s:${await storyDigest(storyKey(all[0]))}`;
      for (const dev of story.developments) {
        const members = dev.reports.map(id => byId.get(id)).sort(order);
        const existing = members.map(r => decision(r)).find(Boolean);
        const development = existing?.development || `d:${await storyDigest(storyKey(members[0]))}`;
        const developmentSequence = existing ? (existing.sequence || 0) : ++sequence;
        const change = existing?.change || (story.developments.length > 1 || all.some(r => r.known) ? dev.change : 'new');
        // A development keeps its first source publication, independent of when copies arrive.
        const first = existing?.first || { day: members[0].day, time: members[0].time };
        const lead = existing?.lead || (() => { const { id, known, ...record } = members[0]; return record; })();
        for (const report of members) {
          const { id, known, ...record } = report;
          decisions.set(storyKey(record), { record, story: storyId, development, sequence: developmentSequence, change, first, lead });
        }
      }
    }
    await save(); emit();
  }
  async function check(events, isCurrent) {
    await load();
    const byCompany = new Map();
    for (const r of records(events)) {
      const key = JSON.stringify([r.company, r.relation]);
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(r);
    }
    for (const [company, rows] of byCompany) {
      if (!isCurrent()) return;
      let unknown = rows.filter(r => !decision(r)).sort(order);
      if (!unknown.length || (failures.get(company) || 0) > now()) continue;
      const history = [...decisions.values()].filter(d => JSON.stringify([d.record.company, d.record.relation]) === company && (d.first?.day || d.record.day) >= cutoff());
      // Avoid a paid request for a byte-equivalent copy; still attach its distinct source link.
      for (const r of unknown) {
        const previous = history.find(d => exactStoryCopy(r, d.record));
        if (previous) decisions.set(storyKey(r), { ...previous, record: r });
      }
      unknown = unknown.filter(r => !decision(r));
      if (!unknown.length) { await save(); emit(); continue; }
      while (unknown.length && isCurrent()) {
        // One representative per checked development leaves room for every outlet reporting it.
        // 100 outlets are paged through the same development, not truncated to the first batch.
        const anchorsByDevelopment = new Map();
        for (const entry of [...decisions.values()].filter(d => JSON.stringify([d.record.company, d.record.relation]) === company &&
          (d.first?.day || d.record.day) >= cutoff()).sort((a, b) => order(a.record, b.record))) {
          if (!anchorsByDevelopment.has(entry.development)) anchorsByDevelopment.set(entry.development, entry);
        }
        const anchors = [...anchorsByDevelopment.values()];
        if (anchors.length + unknown.length < 2 || anchors.length >= STORY_BATCH) break;
        const batch = anchors.map(d => ({ ...d.record, known: { story: d.story, development: d.development } }));
        let taken = 0;
        while (taken < unknown.length && batch.length < STORY_BATCH) {
          const next = { ...unknown[taken] };
          if (storyBytes({ version: STORY_VERSION, reports: [...batch, next].map((r, i) => ({ ...r, id: `r${i}` })) }) > STORY_BYTES) break;
          batch.push(next); taken++;
        }
        if (!taken || batch.length < 2) break;
        const reports = batch.map((r, i) => ({ ...r, id: `r${i}` }));
        try {
          attempted = true;
          const response = await fetcher('api/alert-stories', { method: 'POST', cache: 'no-store', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: STORY_VERSION, reports }), signal: AbortSignal.timeout(45000) });
          const body = await boundedJson(new Response(response.body), 100000);
          const groups = response.ok && body?.ok && validateStoryGroups(body.stories, reports);
          if (!groups) {
            failures.set(company, now() + Math.max(90000, Math.min(86400000, Number(body?.retryAfterMs) || 300000)));
            break;
          }
          // Verify every added copy against ALL retained members, not just the prompt's anchor.
          let safe = true;
          for (const story of groups) for (const dev of story.developments) {
            const members = dev.reports.map(id => reports.find(r => r.id === id));
            const known = members.find(r => r.known)?.known.development;
            if (known) for (const held of decisions.values()) if (held.development === known && members.some(r => !sameDevelopmentSafe(held.record, r))) safe = false;
          }
          if (!safe) { failures.set(company, now() + 300000); break; }
          await accept(groups, reports);
          unknown = unknown.slice(taken);
        } catch { failures.set(company, now() + 300000); break; }
      }
    }
  }
  function review(events, { isCurrent = () => true } = {}) {
    waiting = { events, isCurrent };
    if (!running) running = (async () => {
      checking = true; attempted = false; const before = revision;
      try {
        while (waiting) { const job = waiting; waiting = null; await check(job.events, job.isCurrent); }
      } finally { checking = false; running = null; if (attempted || revision !== before) emit(); }
    })();
    return running;
  }
  function project(events) {
    if (historyRevision !== revision) {
      histories = new Map();
      for (const entry of decisions.values()) {
        if (!histories.has(entry.story)) histories.set(entry.story, new Map());
        const history = histories.get(entry.story);
        if (!history.has(entry.development)) history.set(entry.development, []);
        history.get(entry.development).push(entry.record);
      }
      historyRevision = revision;
    }
    const groups = new Map(), untouched = [];
    for (const event of events) {
      const record = storyRecord(event);
      if (!record) { untouched.push(event); continue; }
      const entry = decision(record);
      // Exact copies can be collapsed offline. Different summaries and same-URL corrections stay.
      const key = entry?.development || JSON.stringify([record.company, record.relation, record.day,
        record.headline.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(), record.text, record.direction, genericStory(record) ? record.url : null]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ event, record, entry });
    }
    for (const group of groups.values()) {
      group.sort((a, b) => order(a.record, b.record));
      const entry = group[0].entry;
      const selected = group.find(item => entry?.lead && storyKey(item.record) === storyKey(entry.lead)) || group[0];
      const event = selected.event;
      const sources = group.map(item => item.event);
      const first = entry?.first || { day: event.day, time: event.time };
      untouched.push({ ...event,
        ...(entry?.lead ? { feed: entry.lead.feed, headline: entry.lead.headline, storyText: entry.lead.text, url: entry.lead.url, direction: entry.lead.direction,
          ...(['announcements', 'nse-filings'].includes(entry.lead.feed) ? { filingSubject: entry.lead.headline, filingDescription: entry.lead.text } : {}) } : {}),
        day: first.day, time: first.time || null,
        storyReports: sources, storyId: entry?.story || null, developmentId: entry?.development || null,
        storySequence: entry?.sequence || 0,
        storyChange: entry?.change || 'new', storyReviewed: !!entry,
        storyHistory: entry ? [...(histories.get(entry.story) || [])].filter(([id]) => id !== entry.development)
          .map(([developmentId, records]) => ({ developmentId, reports: records.sort(order) })) : [],
        importance: sources.some(r => r.importance === 'high') ? 'high' : event.importance });
    }
    return untouched;
  }
  return { load, review, project, status, revision: () => revision, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
}
export const storyGrouping = createStoryGrouping();
