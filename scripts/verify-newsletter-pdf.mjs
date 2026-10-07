// Offline PDF contract: complete content, real columns, repeat headers, navigable sections,
// and safe pagination for long source/AI text. Imported by the existing newsletter CI suite.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { renderBriefPdf } from "../worker/newsletter-pdf.mjs";
import { briefStats } from "../worker/newsletter-brief.mjs";

export function pdfFixture() {
  const at = Date.parse("2026-10-07T10:30:00Z");
  const rows = Array.from({ length: 200 }, (_, i) => ({
    company: `PDF Holding ${String(i).padStart(3, "0")} END`,
    ticker: `PDF${i}`,
    last: 1234.56 + i,
    pct: i % 3 === 0 ? 1.25 : i % 3 === 1 ? -0.75 : 0,
    change: i % 9 === 0 ? null : i % 2 ? -123450 : 234560,
  }));
  const brief = {
    edition: "evening",
    day: "2026-10-07",
    at,
    builtAt: at,
    onDemand: false,
    book: { listed: 200 },
    window: { from: at - 8 * 3600000, to: at },
    announcements: {
      more: 0,
      routineHidden: 7,
      groups: [
        {
          ticker: "PDF0",
          company: "PDF Holdings Limited",
          items: [
            {
              at: at - 1000,
              headline:
                "Customer contract approved subject to final conditions",
              subject: "Detailed order terms retained in the original filing.",
              exchanges: ["NSE"],
              direction: "positive",
              keywords: ["order"],
              url: "https://example.test/filing/terms.pdf",
              content: {
                state: "ready",
                facts: [
                  {
                    field: "status",
                    value: "Approved subject to conditions",
                    quote: "Approved subject to conditions",
                    location: "page 1",
                  },
                ],
              },
            },
          ],
        },
      ],
      nse: { ok: true, readAt: at },
      nseHistory: { ok: false },
      bse: { ok: false },
    },
    news: {
      more: 0,
      groups: [],
      source: { ok: false },
      tradingview: { ok: false },
    },
    trades: { more: 0, groups: [], source: { ok: false } },
    moves: {
      more: 0,
      groups: [],
      state: "unavailable",
      reason: "fixture-source-failed",
    },
    markets: {
      readAt: at,
      rows: [
        {
          id: "nifty",
          group: "india",
          label: "Nifty 50",
          last: 24500.5,
          changePct: -0.5,
          change: -123.12,
          kind: "index",
          state: "close",
          origin: "nse",
          asOf: at,
          verification: "single-source",
        },
        {
          id: "unavailable",
          group: "india",
          label: "India VIX",
          last: null,
          changePct: null,
          kind: "index",
          state: "unavailable",
          reason: "source-failed",
        },
        {
          id: "nasdaq",
          group: "us",
          label: "Nasdaq Composite",
          last: 23000.25,
          changePct: 1.5,
          change: 340,
          kind: "index",
          state: "delayed",
          delayMinutes: 15,
          origin: "yahoo",
          asOf: at - 3600000,
          verification: "single-source",
        },
      ],
    },
    calendar: {
      from: "2026-10-07",
      to: "2026-10-14",
      rows: [
        {
          date: "2026-10-08",
          company: "PDF Holdings Limited",
          ticker: "PDF0",
          label: "Earnings call",
          time: "16:30",
          sources: ["Screener", "Moneycontrol"],
          url: "https://example.test/calendar/call",
        },
      ],
      more: 0,
      screener: { ok: false, reason: "unavailable" },
      moneycontrol: { ok: true, capturedAt: new Date(at).toISOString() },
    },
    actions: {
      from: "2026-10-07",
      to: "2026-10-14",
      rows: [
        {
          company: "PDF Holdings Limited",
          ticker: "PDF0",
          dates: [
            { label: "Ex-date", date: "2026-10-09" },
            { label: "Record date", date: "2026-10-10" },
          ],
          purpose:
            "Dividend of INR 5 per share, subject to shareholder approval",
          source: "NSE",
          url: "https://example.test/actions/dividend",
        },
      ],
      more: 0,
      source: {
        ok: true,
        capturedAt: new Date(at).toISOString(),
        debtSkipped: 2,
      },
    },
    performance: {
      state: "capture",
      session: "2026-10-07",
      rows,
      quoted: 200,
      listed: 203,
      unquoted: 3,
      book: {
        ok: true,
        priced: 177,
        unpriced: 23,
        statementFrom: "2026-03-31",
        statementTo: "2026-08-13",
      },
      summary: {
        up: 67,
        down: 67,
        flat: 66,
        median: 0,
        change: -8055000,
        changePct: -0.4,
      },
    },
  };
  const id = briefStats(brief).companies[0].clusters[0].id;
  brief.ai = {
    ok: true,
    model: "fixture",
    requested: 1,
    answered: 1,
    readAt: at,
    items: {
      [id]: {
        summary:
          "The order was approved, subject to the disclosed final conditions.",
        impact:
          "The order may add revenue if the remaining conditions are met.",
        unknowns: "Final implementation timing was not disclosed.",
      },
    },
  };
  return brief;
}
const pdfText = (data) =>
  [...new TextDecoder().decode(data).matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => m[1].replace(/\\([\\()])/g, "$1"))
    .join(" ");
const compact = (text) => text.replace(/\s+/g, "");
export function verifyNewsletterPdf() {
  const brief = pdfFixture(),
    before = JSON.stringify(brief),
    data = renderBriefPdf(brief),
    raw = new TextDecoder().decode(data),
    text = pdfText(data);
  assert.equal(
    JSON.stringify(brief),
    before,
    "layout never mutates the source brief",
  );
  assert.ok(
    data.byteLength < 1500000,
    "complete edition remains within the saved PDF budget",
  );
  for (const r of brief.performance.rows)
    assert.equal(
      compact(text).split(compact(r.company)).length - 1,
      1,
      `${r.company} appears once in the complete table`,
    );
  assert.ok(
    (text.match(/HOLDING SYMBOL CLOSE \/ INR DAY \/ %/g) || []).length >= 5,
    "holdings column headings repeat across page breaks",
  );
  assert.ok(
    !/statement quantities|rupee day change|CHANGE \/ DERIVED/i.test(text),
    "Sattva keeps price-only reporting even if foreign quantity fields are supplied",
  );
  assert.ok(text.includes("median is unweighted, not portfolio P&L"));
  for (const value of [
    "3 listed holdings had no quote",
    "single source",
    "15-minute feed delay",
    "NSE history unavailable",
    "Dividend of INR 5 per share",
    "Record date",
    "16:30 IST",
    "Final implementation timing was not disclosed.",
  ])
    assert.ok(text.includes(value), `PDF retains ${value}`);
  assert.ok(
    raw.includes("/Type /Outlines") && raw.includes("/Dest ["),
    "section bookmarks and contents links have destinations",
  );
  for (const url of [
    "https://example.test/filing/terms.pdf",
    "https://example.test/calendar/call",
    "https://example.test/actions/dividend",
  ])
    assert.ok(raw.includes(url), "original evidence URL remains clickable");
  // A note larger than a page must continue safely and retain its last words, not paint over footers.
  const long = structuredClone(brief);
  long.performance.rows[0].company =
    "Unusually long company name ".repeat(35) + "LONGCOMPANYEND";
  const id = Object.keys(long.ai.items)[0];
  long.ai.items[id].summary =
    "A disclosed source fact remains conditional. ".repeat(240) +
    "LONGSUMMARYEND";
  long.actions.rows[0].purpose =
    "The detailed corporate action remains subject to stated conditions. ".repeat(
      110,
    ) + "LONGACTIONEND";
  const longData = renderBriefPdf(long),
    longText = pdfText(longData);
  for (const end of ["LONGSUMMARYEND", "LONGCOMPANYEND", "LONGACTIONEND"])
    assert.ok(
      longText.includes(end),
      "pagination retains the entire source cell/note",
    );
  assert.ok(
    longText.includes("AI SUMMARY / continued"),
    "long AI notes carry a continued label",
  );
  // PDF text coordinates are a layout oracle independent of the wrapping loop: nothing may
  // paint outside the printable body or into the fixed footer/header region.
  for (const stream of new TextDecoder()
    .decode(longData)
    .matchAll(/stream\n([^]*?)\nendstream/g)) {
    for (const m of stream[1].matchAll(
      /BT \/F\d ([\d.]+) Tf [^]*? 1 0 0 1 ([\d.]+) ([\d.]+) Tm \(((?:\\.|[^\\)])*)\) Tj ET/g,
    )) {
      const size = Number(m[1]),
        x = Number(m[2]),
        y = 841.89 - Number(m[3]) - size;
      assert.ok(x >= 43.9 && x <= 551.4, `text x ${x} stays within margins`);
      assert.ok(
        y >= 27.9 && y + size <= 816,
        `text at ${y} stays above the footer baseline`,
      );
      if (y > 65 && y < 800)
        assert.ok(
          y + size <= 777.1,
          "body text cannot overlap the page footer",
        );
    }
  }
  const missing = structuredClone(brief);
  missing.performance.state = "unavailable";
  missing.performance.rows = [];
  missing.performance.reason = "capture-unavailable";
  assert.ok(
    pdfText(renderBriefPdf(missing)).includes(
      "the day's performance is not known, not flat",
    ),
  );
  const noBook = structuredClone(brief);
  noBook.performance.book = { ok: false };
  const noBookText = pdfText(renderBriefPdf(noBook));
  assert.ok(noBookText.includes("median is unweighted, not portfolio P&L"));
  assert.ok(
    !noBookText.includes("CHANGE / DERIVED"),
    "Sattva never renders a quantity-derived rupee column",
  );
  if (process.env.NEWSLETTER_PDF_PREVIEW_DIR) {
    mkdirSync(process.env.NEWSLETTER_PDF_PREVIEW_DIR, { recursive: true });
    for (const [name, bytes] of [
      ["design", data],
      ["long", longData],
      ["unavailable", renderBriefPdf(missing)],
    ])
      writeFileSync(
        `${process.env.NEWSLETTER_PDF_PREVIEW_DIR}/${name}.pdf`,
        bytes,
      );
    writeFileSync(
      `${process.env.NEWSLETTER_PDF_PREVIEW_DIR}/design.json`,
      JSON.stringify(brief),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file://").href
) {
  verifyNewsletterPdf();
  console.log(
    "PASS newsletter PDF: content conservation, columns, pagination, source states and navigation",
  );
}
