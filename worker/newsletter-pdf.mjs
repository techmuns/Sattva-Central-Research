// Dependency-free PDF export for Workers. The PDF standard's built-in fonts need no
// network font service, browser, or deployment build. All dimensions are PDF points.
import { BRAND, TAGLINES, briefStats, detailLine, readableUrl, sourcesNote, formatLast, formatPct, formatChange, asOfLabel, MARKET_GROUPS, PRODUCTION_ORIGIN } from './newsletter-brief.mjs';
import { istDateLong, istLabel } from '../public/js/data/newsletter-shared.js';

const INK = '0.059 0.09 0.165', MUTED = '0.31 0.37 0.46', ACCENT = '0.31 0.275 0.898';
const RULE = '0.87 0.89 0.93', TINT = '0.933 0.949 1';
const WIDTH = 595.28, HEIGHT = 841.89, MARGIN = 46, CONTENT = WIDTH - MARGIN * 2, BOTTOM = 778;
// PDF base-font metrics, in thousandths of an em, for ASCII 32..126 (Adobe AFM).
const METRICS = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
  F3: [250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520],
};
// Currency/direction remain explicit in readers without Unicode base fonts. Retain uncommon
// characters visibly as their code point instead of silently deleting source text.
const printable = value => String(value ?? '').replace(/₹/g, 'INR ').replace(/→/g, ' -> ').replace(/[−–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[·•]/g, ' / ').replace(/\s+/g, ' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/gu, c => `[U+${c.codePointAt(0).toString(16).toUpperCase()}]`).trim();
const literal = value => `(${String(value).replace(/[\\()]/g, '\\$&')})`;
const measure = (text, font, size) => [...text].reduce((sum, c) => sum + (METRICS[font][c.charCodeAt(0) - 32] || 600), 0) * size / 1000;
const safeLink = url => { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; } };

function wrap(text, width, font, size) {
  const lines = []; let line = '';
  for (const word of printable(text).split(' ')) {
    if (line && measure(`${line} ${word}`, font, size) > width) { lines.push(line); line = ''; }
    let rest = word;
    while (measure(rest, font, size) > width) {
      let i = 1;
      while (i < rest.length && measure(rest.slice(0, i + 1), font, size) <= width) i++;
      lines.push(rest.slice(0, i)); rest = rest.slice(i);
    }
    line = line ? `${line} ${rest}` : rest;
  }
  if (line) lines.push(line);
  return lines;
}

class BriefPdf {
  constructor(edition, date) { this.pages = []; this.edition = edition; this.date = date; this.page(); }
  page() {
    this.current = { commands: [], links: [] }; this.pages.push(this.current); this.y = 75;
    if (this.pages.length > 1) {
      this.text('SATTVA VENTURES', MARGIN, 38, { font: 'F2', size: 9, color: INK });
      this.text(`${this.edition} / ${this.date}`, MARGIN, 53, { size: 8, color: MUTED });
      this.rule(62);
    }
  }
  ensure(height) { if (this.y + height > BOTTOM) this.page(); }
  rect(x, y, w, h, color) { this.current.commands.push(`${color} rg ${x} ${HEIGHT - y - h} ${w} ${h} re f`); }
  rule(y = this.y, color = RULE) { this.current.commands.push(`${color} RG 0.6 w ${MARGIN} ${HEIGHT-y} m ${WIDTH-MARGIN} ${HEIGHT-y} l S`); }
  text(value, x, y, { font = 'F1', size = 10, color = INK, url = null } = {}) {
    const text = printable(value);
    this.current.commands.push(`BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${HEIGHT-y-size} Tm ${literal(text)} Tj ET`);
    if (safeLink(url)) this.current.links.push({ x, y, w: measure(text, font, size), h: size + 3, url });
  }
  paragraph(value, { font = 'F1', size = 10, color = INK, indent = 0, width = CONTENT - indent, gap = 6, url = null } = {}) {
    const lines = wrap(value, width, font, size), lineHeight = size * 1.45;
    for (const line of lines) { this.ensure(lineHeight); this.text(line, MARGIN + indent, this.y, { font, size, color, url }); this.y += lineHeight; }
    this.y += gap;
  }
  note(label, value) {
    const lines = wrap(value, CONTENT - 28, 'F1', 10), h = 28 + lines.length * 14.5;
    this.ensure(h + 4); this.rect(MARGIN, this.y, CONTENT, h, TINT); this.rect(MARGIN, this.y, 3, h, ACCENT);
    this.text(label, MARGIN + 14, this.y + 9, { font: 'F2', size: 8, color: ACCENT });
    this.y += 24;
    for (const line of lines) { this.text(line, MARGIN + 14, this.y, { size: 10 }); this.y += 14.5; }
    this.y += 8;
  }
  section(label) { this.ensure(75); this.y += 13; this.paragraph(label.toUpperCase(), { font: 'F2', size: 10, color: ACCENT, gap: 8 }); this.rule(); this.y += 12; }
  bytes(title) {
    const objects = ['', ''];
    const add = body => { objects.push(body); return objects.length; };
    const fonts = ['Helvetica', 'Helvetica-Bold', 'Times-Bold'].map(name => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
    const pages = [];
    this.pages.forEach((p, i) => {
      this.current = p;
      this.rule(796);
      this.text('SATTVA VENTURES  /  Automated by Munshot', MARGIN, 807, { size: 8, color: MUTED });
      this.text(`${i+1} / ${this.pages.length}`, WIDTH - MARGIN - 38, 807, { size: 8, color: MUTED });
      const stream = p.commands.join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const annots = p.links.map(l => add(`<< /Type /Annot /Subtype /Link /Rect [${l.x} ${HEIGHT-l.y-l.h} ${l.x+l.w} ${HEIGHT-l.y}] /Border [0 0 0] /A << /S /URI /URI ${literal(new URL(l.url).href)} >> >>`));
      pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << ${fonts.map((id, n) => `/F${n+1} ${id} 0 R`).join(' ')} >> >> /Contents ${content} 0 R /Annots [${annots.map(id => `${id} 0 R`).join(' ')}] >>`));
    });
    objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(id => `${id} 0 R`).join(' ')}] >>`;
    const info = add(`<< /Title ${literal(printable(title))} /Author (Sattva Ventures) /Creator (Automated by Munshot) >>`);
    let output = '%PDF-1.4\n', offsets = [0];
    objects.forEach((body, i) => { offsets.push(output.length); output += `${i+1} 0 obj\n${body}\nendobj\n`; });
    const xref = output.length;
    output += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(output);
  }
}

export const pdfFilename = brief => `sattva-${brief.day}-${brief.edition}-brief.pdf`;

const paragraphHeight = (text, size, font = 'F1', gap = 6) => wrap(text, CONTENT, font, size).length * size * 1.45 + gap;
const noteHeight = text => 32 + wrap(text, CONTENT - 28, 'F1', 10).length * 14.5;
const updateHeight = (k, note) => {
  const s = k.main;
  return paragraphHeight(s.headline, 13, 'F3', 7) + (s.dek ? paragraphHeight(s.dek, 10) : 0)
    + (note ? noteHeight(note.summary) + noteHeight(note.impact) : 0)
    + (detailLine(s) ? paragraphHeight(detailLine(s), 10) : 0)
    + 60 + k.others.reduce((n, r) => n + paragraphHeight(`Related: ${r.headline}`, 10) + 35 + (r.dek ? paragraphHeight(r.dek, 10) : 0), 0);
};

export function renderBriefPdf(brief, { dashboardUrl = PRODUCTION_ORIGIN, productName = 'Research Central' } = {}) {
  const stats = briefStats(brief), edition = TAGLINES[brief.edition], date = istLabel(brief.at, { time: false });
  const pdf = new BriefPdf(edition, date);
  pdf.rect(0, 0, WIDTH, 8, ACCENT); pdf.y = 42;
  pdf.paragraph(BRAND.toUpperCase(), { font: 'F3', size: 28, gap: 3 });
  pdf.paragraph(`${productName} / ${edition}`, { size: 10, color: ACCENT, gap: 10 });
  pdf.rule(); pdf.y += 12;
  pdf.paragraph(istDateLong(brief.at), { font: 'F2', size: 10 });
  pdf.paragraph(`${stats.updates} updates / ${stats.companies.length} of ${brief.book.listed} portfolio companies / ${stats.good} good / ${stats.watch} watch-outs`, { size: 10 });
  pdf.paragraph(`Window: ${istLabel(brief.window.from)} to ${istLabel(brief.window.to)}${brief.onDemand ? ' / built on request' : ''}`, { size: 9, color: MUTED });
  pdf.section('Your portfolio companies');
  if (!stats.stories) pdf.paragraph('No updates in the available source readings. See source coverage below for missing or unavailable feeds.');
  for (const c of stats.companies) {
    pdf.ensure(Math.min(680, 85 + updateHeight(c.clusters[0], brief.ai?.items?.[c.clusters[0].id])));
    pdf.paragraph(c.company, { font: 'F3', size: 20, gap: 3 });
    pdf.paragraph(`${c.ticker} / ${c.clusters.length} updates${c.stories.length > c.clusters.length ? ` from ${c.stories.length} source items` : ''}`, { size: 9, color: MUTED });
    pdf.paragraph('On the dashboard ->', { font: 'F2', size: 9, color: ACCENT, url: `${dashboardUrl}/#/research/daily-alerts?scope=portfolio&company=${encodeURIComponent(c.ticker)}`, gap: 10 });
    pdf.rule(); pdf.y += 10;
    for (const k of c.clusters) {
      const s = k.main, note = brief.ai?.items?.[k.id];
      const needed = updateHeight(k, note);
      const startPage = pdf.pages.length;
      pdf.ensure(Math.min(650, needed) + 23);
      if (pdf.pages.length !== startPage) pdf.paragraph(`${c.company} / continued`, { font: 'F2', size: 9, color: ACCENT });
      pdf.paragraph(s.headline, { font: 'F3', size: 13, url: readableUrl(s.url, dashboardUrl), gap: 7 });
      if (s.dek) pdf.paragraph(s.dek, { size: 10, color: MUTED });
      if (note) { pdf.ensure(noteHeight(note.summary) + noteHeight(note.impact)); pdf.note('AI SUMMARY', note.summary); pdf.note('POTENTIAL IMPACT / AI', note.impact); }
      const details = detailLine(s);
      if (details) pdf.paragraph(details, { size: 10 });
      pdf.paragraph(`${s.topic.label} / ${s.mood.label} / ${s.source} / ${istLabel(s.at)}${s.related ? ' / related entity' : ''}${s.late ? ' / not in the previous brief' : ''}`, { size: 8, color: MUTED });
      if (s.url) pdf.paragraph('Read original source ->', { font: 'F2', size: 9, color: ACCENT, url: readableUrl(s.url, dashboardUrl) });
      for (const r of k.others) {
        pdf.paragraph(`Related: ${r.headline}`, { size: 10, url: readableUrl(r.url, dashboardUrl) });
        pdf.paragraph(`${r.source} / ${istLabel(r.at)}${r.related ? ' / related entity' : ''}${r.late ? ' / not in the previous brief' : ''}`, { size: 8, color: MUTED });
        if (r.dek) pdf.paragraph(r.dek, { size: 10, color: MUTED });
      }
      pdf.y += 4; pdf.rule(); pdf.y += 12;
    }
  }
  const more = brief.announcements.more + brief.news.more + (brief.moves?.more || 0);
  if (more) pdf.paragraph(`${more} more items in this window on the dashboard.`, { color: ACCENT, url: `${dashboardUrl}/#/research/daily-alerts?scope=portfolio` });
  pdf.section('Global market scan');
  for (const g of MARKET_GROUPS) {
    const rows = brief.markets.rows.filter(r => r.group === g.id);
    if (!rows.length) continue;
    pdf.ensure(65); pdf.paragraph(g.label.toUpperCase(), { font: 'F2', size: 9, color: ACCENT, gap: 9 });
    for (const r of rows) {
      const provenance = `${asOfLabel(r)}${r.change != null ? ` / change ${formatChange(r)}` : ''}`;
      pdf.ensure(27 + paragraphHeight(provenance, 8, 'F1', 4));
      pdf.text(`${r.label}${r.unit ? ` (${r.unit})` : ''}`, MARGIN, pdf.y, { font: 'F2', size: 10 });
      pdf.text(formatLast(r) ?? 'Unavailable', MARGIN + 270, pdf.y, { size: 10 });
      pdf.text(formatPct(r) ?? '-', MARGIN + 390, pdf.y, { font: 'F2', size: 10 });
      pdf.y += 15;
      pdf.paragraph(provenance, { size: 8, color: MUTED, gap: 4 });
      pdf.rule(); pdf.y += 8;
    }
    pdf.y += 6;
  }
  pdf.section('Sources & reading notes');
  const coverage = sourcesNote(brief);
  // Each source begins a readable paragraph instead of one dense block of fine print.
  for (const part of coverage.split(' · ')) pdf.paragraph(part, { size: 9, color: MUTED, gap: 5 });
  pdf.y += 8;
  pdf.paragraph('AI notes use supplied headlines and summaries, not full documents. Possible impacts are not established facts. Mood follows stated filing and price-move rules; publisher reports remain neutral. This brief is informational, not investment advice.', { size: 9, color: MUTED });
  pdf.paragraph(`Built ${istLabel(brief.builtAt, { year: true })}. Automated by Munshot.`, { font: 'F2', size: 9, color: ACCENT });
  return pdf.bytes(`${BRAND} / ${edition} / ${brief.day}`);
}
