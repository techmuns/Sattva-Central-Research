const HIGHLIGHT_MS = 20_000;
const compactCount = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const clock = (at) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const arrivalsHtml = `<section class="alert-arrivals" data-alert-arrivals aria-label="Live arrivals in Till Today">
  <div class="alert-arrivals-identity"><span class="alert-arrivals-orbit" aria-hidden="true"><span></span></span><div><strong>Live arrivals</strong><span data-arrivals-status>Loading history…</span><span class="alert-arrivals-compact" data-arrivals-compact>Watching</span></div></div>
  <div class="alert-arrivals-story"><strong data-arrivals-headline>New alerts appear here automatically</strong><span data-arrivals-detail>Checks every 90 seconds while visible · source timing varies</span></div>
  <button type="button" class="alert-arrivals-coverage" data-arrivals-sources>Source status ↗</button>
  <span class="sr-only" data-arrivals-announcement role="status" aria-live="polite" aria-atomic="true"></span>
</section>`;

// Decorate mounted rows only. The table's reusable markup remains free of expiring badges,
// so scrolling back to an old virtual row cannot restart its arrival highlight.
export function createArrivalsUI(tracker) {
  let root = null, observer = null, timer = null, compactMedia = null, layout = null;
  let recent = [], state = {}, announced = new Set(), announcementIds = [];
  const text = (selector, value) => {
    const node = root?.querySelector(selector);
    if (node && node.textContent !== value) node.textContent = value;
  };
  function decorate() {
    if (!root?.querySelector('[data-alert-arrivals]')) return;
    for (const row of root.querySelectorAll('tr[data-row-key]')) {
      const at = tracker.time(row.dataset.rowKey), age = Date.now() - at;
      const fresh = at > 0 && age < HIGHLIGHT_MS;
      row.classList.toggle('alert-just-arrived', fresh);
      if (fresh) {
        // A virtual row entering later joins the same fade, instead of starting it again.
        if (!row.querySelector('[data-arrival-badge]')) {
          row.style.setProperty('--arrival-age', `-${Math.max(0, age)}ms`);
          const badge = document.createElement('span');
          badge.dataset.arrivalBadge = '';
          badge.className = 'alert-arrival-badge';
          badge.textContent = 'NEW';
          badge.title = `Received in this view at ${clock(at)} IST. The date above is the source date.`;
          row.querySelector('[data-event-day]')?.append(badge);
        }
      } else {
        row.querySelector('[data-arrival-badge]')?.remove();
        row.style.removeProperty('--arrival-age');
      }
    }
  }
  function paint() {
    const strip = root?.querySelector('[data-alert-arrivals]');
    if (!strip) return;
    // Screen-reader announcements carry the same privacy/filter boundary as visible headlines.
    const currentIds = new Set(recent.map(row => row.id));
    if (announcementIds.some(id => !currentIds.has(id) || !tracker.time(id))) {
      text('[data-arrivals-announcement]', '');
      announcementIds = [];
    }
    let latest = null;
    for (const row of recent) if (!latest || tracker.time(row.id) > tracker.time(latest.id)) latest = row;
    const offline = navigator.onLine === false;
    const checking = !offline && state.checking && !document.hidden;
    strip.dataset.checking = String(!!checking);
    strip.dataset.hasArrivals = String(!!latest);
    text('[data-arrivals-status]', offline ? 'Offline · saved alerts' : document.hidden ? 'Paused while away' : checking ? 'Checking for arrivals…' : 'Watching for new alerts');
    text('[data-arrivals-headline]', latest ? `${latest.company || latest.ticker || latest.feedLabel} · ${latest.headline}` : 'New alerts appear here automatically');
    const at = latest && tracker.time(latest.id);
    text('[data-arrivals-compact]', offline ? 'Offline' : recent.length ? `${compactCount.format(recent.length)} new` : checking ? 'Checking' : 'Watching');
    text('[data-arrivals-detail]', latest
      ? `${recent.length.toLocaleString('en-IN')} received this visit in your filters · ${latest.feedLabel || 'Source'} · received ${clock(at)} IST`
      : 'Checks every 90 seconds while visible · source timing varies');
    const headline = strip.querySelector('[data-arrivals-headline]');
    headline.title = latest ? `${latest.headline}\nReceived ${clock(at)} IST; source publication: ${latest.day || 'date not supplied'}${latest.time ? ` ${latest.time} IST` : ''}. Records keep their source-date order.` : '';
    strip.title = `${headline.title || 'New alerts appear automatically.'} Checks every 90 seconds while visible; source timing varies. ${state.coverage?.title || ''}`;
    const button = strip.querySelector('[data-arrivals-sources]');
    button.textContent = `${state.coverage?.label || 'Source status'} ↗`;
    button.title = state.coverage?.title || 'View source check times and coverage';
    button.dataset.coverage = state.coverage?.status || 'loading';
    const fresh = recent.filter(row => !announced.has(row.id) && Date.now() - tracker.time(row.id) < HIGHLIGHT_MS);
    if (fresh.length && !document.hidden) {
      text('[data-arrivals-announcement]', `${fresh.length} newly received alert${fresh.length === 1 ? '' : 's'} in Till Today. ${fresh[0].company || ''}: ${fresh[0].headline}`);
      fresh.forEach(row => announced.add(row.id));
      announcementIds = fresh.map(row => row.id);
    }
    decorate();
  }
  function detach() {
    observer?.disconnect(); observer = null;
    clearInterval(timer); timer = null;
    compactMedia?.removeEventListener('change', layout); compactMedia = null; layout = null;
    root = null;
  }
  return {
    setRows(next) { recent = next.filter(row => tracker.time(row.id)); paint(); },
    setState(next) { state = next; paint(); },
    reset() { recent = []; announced.clear(); paint(); },
    attach(nextRoot) {
      detach(); root = nextRoot;
      const strip = root.querySelector('[data-alert-arrivals]');
      if (!strip) return;
      // Short desktop frames need the table's reading space. Keep the same live indicator
      // alongside the horizon controls, with full arrival/source detail in its tooltip.
      compactMedia = matchMedia('(min-width: 768px) and (max-height: 780px)');
      layout = () => {
        strip.classList.toggle('is-compact', compactMedia.matches);
        if (compactMedia.matches) root.querySelector('[data-alerts-controls]').insertBefore(strip, root.querySelector('.alerts-view-controls'));
        else root.querySelector('[data-alerts-workspace]').insertBefore(strip, root.querySelector('[data-score-table]'));
      };
      compactMedia.addEventListener('change', layout);
      layout();
      strip.querySelector('[data-arrivals-sources]').onclick = () => {
        const picker = root.querySelector('[data-alerts-sources]');
        if (picker) picker.open = true;
        root.querySelector('[data-sources-summary]')?.focus({ preventScroll: true });
      };
      observer = new MutationObserver(changes => {
        if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === 1 && (node.matches('tr[data-row-key]') || node.querySelector('tr[data-row-key]'))))) decorate();
      });
      observer.observe(root.querySelector('[data-table-body]'), { childList: true, subtree: true });
      timer = setInterval(paint, 1000);
      paint();
    },
    detach,
  };
}
