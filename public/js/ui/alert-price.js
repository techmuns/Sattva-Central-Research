import { escapeHtml } from '../core/dom.js';
import { formatRupee } from '../core/format.js';
import * as live from '../data/breakout-live.js';
import * as technicals from '../data/technicals.js';
import { reconcileMarkup } from './reconcile-markup.js';

// Read the shared snapshot once per view, never once per card or directly from a broker.
export function alertPriceHtml(ticker) {
  const company = technicals.byTicker(ticker)?.company || { ticker };
  const info = live.priceInfo(company);
  const available = Number.isFinite(info.price) && info.price > 0;
  const change = available && Number.isFinite(info.change) ? info.change : null;
  const direction = change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral';
  const date = info.at ? live.stamp(info.at) : company.price_date || company.bar_date || '';
  const status = !available ? 'Price unavailable' : info.source === 'Daily close'
    ? `Close · ${date || 'date unavailable'}` : `${info.stale ? 'Saved · ' : ''}${date}`;
  return `<div class="ai-card-price" data-ai-price data-price-ticker="${escapeHtml(ticker || '')}" data-price-stale="${info.stale}" title="${escapeHtml(live.priceCaption(info))}">
    <div class="ai-card-price-value"><span class="ai-card-price-label">CMP</span> <span data-ai-cmp>${available ? escapeHtml(formatRupee(info.price, { decimals: 2 })) : '—'}</span></div>
    <div class="ai-card-price-change" data-direction="${direction}" data-ai-price-change>${change == null ? 'Daily change —' : `${change > 0 ? '+' : ''}${change.toFixed(2)}% daily`}</div>
    <div class="ai-card-price-status" data-ai-price-status>${escapeHtml(status)}</div>
  </div>`;
}

export function watchAlertPrices(root) {
  const update = () => {
    for (const node of root.querySelectorAll('[data-ai-price]')) {
      // Patch only the quote: evidence, focus, ranking and timeline scroll keep their nodes.
      const template = document.createElement('template');
      template.innerHTML = alertPriceHtml(node.dataset.priceTicker);
      const next = template.content.firstElementChild;
      node.title = next.title;
      node.dataset.priceStale = next.dataset.priceStale;
      reconcileMarkup(node, next.innerHTML);
    }
  };
  const offDaily = technicals.onChange(update);
  const offLive = live.watch(update);
  return () => { offDaily(); offLive(); };
}
