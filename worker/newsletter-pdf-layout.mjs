// A4 vector layout shared by the newsletter exports. Worker-safe; no fonts or browser fetches.
export const WIDTH = 595.28,
  HEIGHT = 841.89,
  MARGIN = 44,
  CONTENT = WIDTH - MARGIN * 2,
  BOTTOM = 777;
export const INK = '0.10 0.14 0.19',
  MUTED = '0.37 0.42 0.47',
  RULE = '0.87 0.89 0.90';
export const PAPER = '0.975 0.978 0.980',
  UP = '0.12 0.40 0.29',
  DOWN = '0.66 0.20 0.22';
export const tone = (value) => (value == null || value === 0 ? MUTED : value > 0 ? UP : DOWN);
// PDF base-font metrics, in thousandths of an em, for ASCII 32..126 (Adobe AFM).
const METRICS = {
  F1: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584,
  ],
  F2: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
    556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
    280, 389, 584,
  ],
  F3: [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500,
    500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944,
    722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556,
    444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394,
    220, 394, 520,
  ],
};
// Currency/direction remain explicit in readers without Unicode base fonts. Retain uncommon
// characters visibly as their code point instead of silently deleting source text.
export const printable = (value) =>
  String(value ?? '')
    .replace(/₹/g, 'INR ')
    .replace(/→/g, ' -> ')
    .replace(/[−–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[·•]/g, ' / ')
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/gu, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase()}]`)
    .trim();
const literal = (value) => `(${String(value).replace(/[\\()]/g, '\\$&')})`;
export const measure = (text, font, size) =>
  ([...text].reduce((sum, c) => sum + (METRICS[font][c.charCodeAt(0) - 32] || 600), 0) * size) / 1000;
const safeLink = (url) => {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
};

export function wrap(text, width, font, size) {
  const lines = [];
  let line = '';
  for (const word of printable(text).split(' ')) {
    if (line && measure(`${line} ${word}`, font, size) > width) {
      lines.push(line);
      line = '';
    }
    let rest = word;
    while (measure(rest, font, size) > width) {
      let i = 1;
      while (i < rest.length && measure(rest.slice(0, i + 1), font, size) <= width) i++;
      lines.push(rest.slice(0, i));
      rest = rest.slice(i);
    }
    line = line ? `${line} ${rest}` : rest;
  }
  if (line) lines.push(line);
  return lines;
}

export class BriefPdf {
  constructor({ brand, edition, date, accent, tint }) {
    Object.assign(this, { brand, edition, date, accent, tint });
    this.pages = [];
    this.bookmarks = [];
    this.sectionTitle = '';
    this.context = '';
    this.page();
  }
  page(continued = true) {
    this.current = { commands: [], links: [] };
    this.pages.push(this.current);
    this.y = 74;
    if (this.pages.length === 1) return;
    this.text(this.brand.toUpperCase(), MARGIN, 28, { font: 'F2', size: 9, color: this.accent });
    this.text(`${this.edition} / ${this.date}`, WIDTH - MARGIN, 29, { size: 8, color: MUTED, align: 'right' });
    this.rule(49);
    const title = this.context || this.sectionTitle;
    if (title && continued) {
      for (const line of wrap(`${title} / continued`, CONTENT, 'F2', 9)) {
        this.text(line, MARGIN, this.y, { font: 'F2', size: 9, color: MUTED });
        this.y += 13;
      }
      this.y += 8;
    }
  }
  ensure(height) {
    if (this.y + height > BOTTOM) this.page();
  }
  rect(x, y, w, h, color) {
    this.current.commands.push(`${color} rg ${x} ${HEIGHT - y - h} ${w} ${h} re f`);
  }
  rule(y = this.y, color = RULE, x = MARGIN, width = CONTENT) {
    this.current.commands.push(`${color} RG 0.5 w ${x} ${HEIGHT - y} m ${x + width} ${HEIGHT - y} l S`);
  }
  text(value, x, y, { font = 'F1', size = 10, color = INK, url = null, align = 'left' } = {}) {
    const text = printable(value),
      width = measure(text, font, size);
    if (align === 'right') x -= width;
    this.current.commands.push(
      `BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${HEIGHT - y - size} Tm ${literal(text)} Tj ET`,
    );
    const href = safeLink(url);
    if (href) this.current.links.push({ x, y, w: width, h: size + 3, url: href });
  }
  paragraph(
    value,
    { font = 'F1', size = 10, color = INK, indent = 0, width = CONTENT - indent, gap = 7, url = null } = {},
  ) {
    const lines = wrap(value, width, font, size),
      lineHeight = size * 1.42;
    for (const line of lines) {
      this.ensure(lineHeight);
      this.text(line, MARGIN + indent, this.y, { font, size, color, url });
      this.y += lineHeight;
    }
    this.y += gap;
  }
  note(label, value) {
    if (!value) return;
    const lines = wrap(value, CONTENT - 30, 'F1', 10);
    let offset = 0;
    while (offset < lines.length) {
      this.ensure(66);
      const count = Math.min(lines.length - offset, Math.floor((BOTTOM - this.y - 36) / 14.2));
      const h = 32 + count * 14.2;
      this.rect(MARGIN, this.y, CONTENT, h, this.tint);
      this.rect(MARGIN, this.y, 2, h, this.accent);
      this.text(`${label}${offset ? ' / continued' : ''}`, MARGIN + 15, this.y + 9, {
        font: 'F2',
        size: 8,
        color: this.accent,
      });
      let y = this.y + 25;
      for (const line of lines.slice(offset, offset + count)) {
        this.text(line, MARGIN + 15, y);
        y += 14.2;
      }
      this.y += h + 8;
      offset += count;
    }
  }
  section(label, { fresh = false, subtitle = '' } = {}) {
    this.context = '';
    this.sectionTitle = label;
    if (fresh && this.y > 110) this.page(false);
    else this.ensure(105);
    const y = this.y;
    this.bookmarks.push({ label, page: this.pages.length - 1, y });
    this.paragraph(`${String(this.bookmarks.length).padStart(2, '0')} / ${label.toUpperCase()}`, {
      font: 'F2',
      size: 9,
      color: this.accent,
      gap: 7,
    });
    this.paragraph(label, { font: 'F3', size: 23, gap: 7 });
    if (subtitle) this.paragraph(subtitle, { size: 9, color: MUTED, gap: 9 });
    this.rule();
    this.y += 14;
  }
  metrics(items) {
    const width = CONTENT / items.length;
    this.ensure(66);
    items.forEach((item, i) => {
      const x = MARGIN + i * width;
      this.rect(x, this.y, width - 4, 59, this.tint);
      this.text(item.value, x + 12, this.y + 9, { font: 'F2', size: item.size || 21, color: item.color || INK });
      this.text(item.label, x + 12, this.y + 38, { size: 8, color: MUTED });
    });
    this.y += 73;
  }
  table(columns, rows, { lineHeight = 13, padding = 14 } = {}) {
    const total = columns.reduce((n, c) => n + c.width, 0);
    if (Math.abs(total - CONTENT) > 0.01) throw new Error('PDF table widths must fill the content area');
    const header = () => {
      this.rect(MARGIN, this.y, CONTENT, 28, this.tint);
      let x = MARGIN;
      columns.forEach((c) => {
        this.text(c.label, c.align === 'right' ? x + c.width - 9 : x + 9, this.y + 9, {
          font: 'F2',
          size: 8,
          color: this.accent,
          align: c.align,
        });
        x += c.width;
      });
      this.y += 28;
    };
    this.ensure(76);
    header();
    rows.forEach((row, index) => {
      const cells = row.cells.map((cell, i) => {
        const blocks = typeof cell === 'string' ? [{ text: cell }] : Array.isArray(cell) ? cell : [cell];
        return blocks.flatMap((b) =>
          wrap(b.text, columns[i].width - 18, b.font || 'F1', b.size || 9).map((text) => ({ ...b, text })),
        );
      });
      const detail = row.detail ? wrap(row.detail, CONTENT - 18, 'F1', 8) : [];
      const maxLines = Math.max(1, ...cells.map((c) => c.length));
      const height = maxLines * lineHeight + detail.length * 11 + padding;
      // Keep ordinary rows whole. A pathological cell is split, with the full text retained.
      if (this.y + Math.min(height, 560) > BOTTOM) {
        this.page();
        header();
      }
      let offset = 0;
      while (offset < maxLines) {
        if (this.y + 40 > BOTTOM) {
          this.page();
          header();
        }
        const count = Math.min(maxLines - offset, Math.floor((BOTTOM - this.y - padding) / lineHeight));
        const h = count * lineHeight + padding;
        if (index % 2 === 0) this.rect(MARGIN, this.y, CONTENT, h, PAPER);
        let x = MARGIN;
        cells.forEach((lines, i) => {
          lines
            .slice(offset, offset + count)
            .forEach((line, j) =>
              this.text(
                line.text,
                columns[i].align === 'right' ? x + columns[i].width - 9 : x + 9,
                this.y + padding / 2 + j * lineHeight,
                {
                  font: line.font || 'F1',
                  size: line.size || 9,
                  color: line.color || INK,
                  url: line.url,
                  align: columns[i].align,
                },
              ),
            );
          x += columns[i].width;
        });
        this.y += h;
        offset += count;
      }
      for (const line of detail) {
        if (this.y + 13 > BOTTOM) {
          this.page();
          header();
        }
        this.text(line, MARGIN + 9, this.y, { size: 8, color: MUTED, url: row.detailUrl });
        this.y += 11;
      }
      this.rule();
    });
    this.y += 12;
  }
  contents(labels) {
    this.paragraph('IN THIS EDITION', { font: 'F2', size: 9, color: this.accent, gap: 10 });
    this.contentsPosition = { page: this.current, y: this.y, labels };
    this.y += labels.length * 25 + 12;
  }
  bytes(title) {
    const objects = ['', ''];
    const add = (body) => {
      objects.push(body);
      return objects.length;
    };
    const fonts = ['Helvetica', 'Helvetica-Bold', 'Times-Bold'].map((name) =>
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
    );
    const pages = [];
    if (this.contentsPosition) {
      this.current = this.contentsPosition.page;
      this.contentsPosition.labels.forEach((label, i) => {
        const bookmark = this.bookmarks.find((b) => b.label === label);
        if (!bookmark) return;
        const y = this.contentsPosition.y + i * 25;
        this.text(label, MARGIN, y, { size: 10 });
        this.text(String(bookmark.page + 1), WIDTH - MARGIN, y, {
          font: 'F2',
          size: 10,
          color: this.accent,
          align: 'right',
        });
        this.rule(y + 19);
        this.current.links.push({ x: MARGIN, y, w: CONTENT, h: 19, target: bookmark });
      });
    }
    // Reserve page IDs before writing content so internal links and bookmarks can target them.
    this.pages.forEach(() => pages.push(add('')));
    this.pages.forEach((p, i) => {
      this.current = p;
      this.rule(796);
      this.text(`${this.brand.toUpperCase()} / Automated by Munshot`, MARGIN, 807, { size: 8, color: MUTED });
      this.text(`${i + 1} / ${this.pages.length}`, WIDTH - MARGIN, 807, { size: 8, color: MUTED, align: 'right' });
      const stream = p.commands.join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const annots = p.links.map((l) =>
        add(
          `<< /Type /Annot /Subtype /Link /Rect [${l.x} ${HEIGHT - l.y - l.h} ${l.x + l.w} ${HEIGHT - l.y}] /Border [0 0 0] ${l.target ? `/Dest [${pages[l.target.page]} 0 R /XYZ null ${HEIGHT - l.target.y} null]` : `/A << /S /URI /URI ${literal(l.url)} >>`} >>`,
        ),
      );
      objects[pages[i] - 1] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << ${fonts.map((id, n) => `/F${n + 1} ${id} 0 R`).join(' ')} >> >> /Contents ${content} 0 R /Annots [${annots.map((id) => `${id} 0 R`).join(' ')}] >>`;
    });
    const outlineRoot = add(''),
      outlines = this.bookmarks.map(() => add(''));
    this.bookmarks.forEach((b, i) => {
      objects[outlines[i] - 1] =
        `<< /Title ${literal(printable(b.label))} /Parent ${outlineRoot} 0 R ${i ? `/Prev ${outlines[i - 1]} 0 R` : ''} ${i + 1 < outlines.length ? `/Next ${outlines[i + 1]} 0 R` : ''} /Dest [${pages[b.page]} 0 R /XYZ null ${HEIGHT - b.y} null] >>`;
    });
    objects[outlineRoot - 1] =
      `<< /Type /Outlines /First ${outlines[0]} 0 R /Last ${outlines.at(-1)} 0 R /Count ${outlines.length} >>`;
    objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRoot} 0 R >>`;
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] >>`;
    const info = add(
      `<< /Title ${literal(printable(title))} /Author ${literal(printable(this.brand))} /Creator (Automated by Munshot) >>`,
    );
    let output = '%PDF-1.4\n',
      offsets = [0];
    objects.forEach((body, i) => {
      offsets.push(output.length);
      output += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = output.length;
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(output);
  }
}
