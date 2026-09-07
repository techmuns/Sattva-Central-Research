// Existing open documents need an explicit version check too. This checks only sw.js;
// activation/reload remains owned by app.js so a paid research stream is never interrupted.
export function watchWorkerChanges(container, onUpgrade) {
  let hadController = !!container.controller, upgrading = false;
  const changed = () => {
    if (!container.controller || upgrading) return;
    // A first install already controls fresh modules. Remember its claim so a
    // subsequent deployment in this same, long-lived document does upgrade.
    if (!hadController) { hadController = true; return; }
    upgrading = true;
    onUpgrade();
  };
  container.addEventListener('controllerchange', changed);
  return () => container.removeEventListener('controllerchange', changed);
}

export function watchAppUpdates(registration, {
  doc = document, win = window, now = Date.now, intervalMs = 5 * 60 * 1000,
  schedule = setInterval, cancel = clearInterval,
} = {}) {
  let last = now(), pending = false, stopped = false;
  const check = async () => {
    if (stopped || pending || doc.visibilityState === 'hidden' || now() - last < intervalMs) return;
    pending = true; last = now();
    try { await registration.update(); } catch { /* Offline keeps the active, last-good app. */ }
    finally { pending = false; }
  };
  const timer = schedule(check, intervalMs);
  doc.addEventListener('visibilitychange', check);
  win.addEventListener('focus', check);
  win.addEventListener('online', check);
  const stop = () => {
    stopped = true; cancel(timer);
    doc.removeEventListener('visibilitychange', check);
    win.removeEventListener('focus', check);
    win.removeEventListener('online', check);
    win.removeEventListener('pagehide', pageHide);
  };
  const pageHide = event => { if (!event.persisted) stop(); };
  win.addEventListener('pagehide', pageHide);
  return stop;
}
