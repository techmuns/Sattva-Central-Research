// One source-selection implementation for the server compatibility reader and browser.
import {quoteFreshAt,marketWindow,PRIMARY_MAX_AGE,MINUTE_RETENTION_DAYS} from './breakout-live-shared.js';

export function mergePrimary(fallback, primary, now=Date.now()) {
  if (!primary) return fallback;
  const targets=[...new Set([...(fallback.targets || []),...primary.targets])];
  const old=new Map((fallback.rows || []).map(r=>[r.ticker,r]));
  const current=new Map(primary.rows.map(r=>[r.ticker,r]));
  const primaryFailures=new Map(primary.failures.map(r=>[r.ticker,r.reason]));
  const fallbackFailures=new Map((fallback.failures || []).map(r=>[r.ticker,r.reason]));
  const rows=[], failures=[];
  let primaryUsed=0, fallbackUsed=0;
  const fresh=quoteFreshAt(now),open=marketWindow(now).open;
  for (const ticker of targets) {
    let p=current.get(ticker), f=old.get(ticker);
    const timely=p && (!open || now-Date.parse(p.checkedAt)<=PRIMARY_MAX_AGE);
    const goodPrimary=timely && !primaryFailures.has(ticker) && fresh(p);
    const goodFallback=f && !fallbackFailures.has(ticker) && fresh(f);
    // Daily history may finish after the minute's quote, without changing its price/source time.
    if (p && !p.base && f?.base && f.sessionDate===p.sessionDate && f.exchange===p.exchange) p={...p,base:f.base};
    if (p && !p.volumeBase && f?.volumeBase && f.sessionDate===p.sessionDate && f.exchange===p.exchange) p={...p,volumeBase:f.volumeBase};
    const row=goodPrimary?p:goodFallback?f:!p?f:!f?p:Date.parse(p.quoteAt)>=Date.parse(f.quoteAt)?p:f;
    if (row) rows.push(row);
    if (goodPrimary) primaryUsed++;
    else if (goodFallback) fallbackUsed++;
    else failures.push({ticker,reason:primaryFailures.get(ticker) || fallbackFailures.get(ticker) || 'stale'});
  }
  const recent=now-primary.completedAt<=PRIMARY_MAX_AGE;
  return {...fallback,targets,rows,failures,
    state:recent?'complete':fallback.state,
    completedAt:recent?new Date(primary.completedAt).toISOString():fallback.completedAt,
    discoveryFailed:primary.discoveryFailed || fallback.discoveryFailed===true,
    primary:{at:primary.at,captureStartedAt:new Date(primary.firstAt || primary.at).toISOString(),checkedAt:new Date(primary.completedAt).toISOString(),primaryUsed,fallbackUsed,
      failures:primary.failures,instrumentFailures:primary.instrumentFailures,gaps:primary.gaps || [],intervalMs:60000,minuteRetentionDays:MINUTE_RETENTION_DAYS},
    captureStartedAt:fallback.captureStartedAt || new Date(primary.firstAt || primary.at).toISOString(),
    retention:'Detailed minute snapshots are retained for four calendar days in the retained capture archive; detected breakout changes and existing fallback history are retained separately. The dashboard loads current prices only. Minute snapshots are not a trade-by-trade archive. Missed intervals use available 15-minute recovery candles; finer gaps remain unrecoverable.'};
}

export function selectPreparedBreakouts(head,fallback,primary,pathname,{now=Date.now(),delivery='static-assets'}={}) {
  const selected=pathname==='/api/breakouts/fallback'?fallback:mergePrimary(fallback,primary,now),at=now,active=marketWindow(at).collect;
  const schedule={...head.schedule,overdue:head.schedule?.overdue===true||active&&at-(head.schedule?.lastAttemptAt||0)>30*60000};
  const primarySchedule={...head.primarySchedule,overdue:head.primarySchedule?.overdue===true||active&&at-(head.primarySchedule?.lastAttemptAt||0)>PRIMARY_MAX_AGE};
  return {...selected,schedule,primarySchedule,runtime:'github-actions',delivery};
}
