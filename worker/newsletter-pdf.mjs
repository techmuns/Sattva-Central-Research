// Complete, immutable A4 edition. Layout only: source facts, dates, quantities and links
// come from the same brief as the email. No browser, network font or build dependency.
import {
  BRAND,
  readableUrl,
  TAGLINES,
  briefStats,
  briefSupplementLines,
  contentStatusText,
  storyWhen,
  sourcesNote,
  formatLast,
  formatPct,
  formatChange,
  asOfLabel,
  MARKET_GROUPS,
  PRODUCTION_ORIGIN,
  calendarDayLabel,
} from "./newsletter-brief.mjs";
import { priceReasonText } from "./newsletter-price-reasons.mjs";
import { editorialEvents, referenceReason } from "./newsletter-editorial.mjs";
import {
  istDateLong,
  istLabel,
  istInstant,
} from "../public/js/data/newsletter-shared.js";
import {
  BriefPdf,
  WIDTH,
  MARGIN,
  CONTENT,
  INK,
  MUTED,
  tone,
  wrap,
} from "./newsletter-pdf-layout.mjs";

const ACCENT = "0.31 0.27 0.90",
  TINT = "0.93 0.95 1.00";
export const pdfFilename = (brief) =>
  `sattva-${brief.day}-${brief.edition}-brief.pdf`;
const signed = (value) =>
  value == null || !Number.isFinite(value)
    ? "Unavailable"
    : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const number = (value) =>
  value == null
    ? "Unavailable"
    : value.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const range = (value) =>
  `${istLabel(istInstant(value.from), { time: false })} to ${istLabel(istInstant(value.to), { time: false })}`;
const paragraphHeight = (text, size, font = "F1", gap = 6) =>
  wrap(text, CONTENT, font, size).length * size * 1.42 + gap;
const noteHeight = (text) =>
  40 + wrap(text, CONTENT - 30, "F1", 10).length * 14.2;
const sourceLinks = (story, dashboardUrl) => [...new Set([story.url, ...(story.sourceUrls || [])]
  .filter(Boolean).map(url => readableUrl(url, dashboardUrl)).filter(Boolean))];
const updateHeight = (k, note) => {
  const s = k.main;
  const metadata = `${s.topic.label} / ${s.mood.label} / ${s.source} / ${storyWhen(s)}${s.related ? " / related entity" : ""}${s.late ? " / not in the previous brief" : ""}`;
  return (
    paragraphHeight(s.headline, 13, "F3", 7) +
    (s.dek ? paragraphHeight(s.dek, 10) : 0) +
    (note
      ? noteHeight(note.summary) +
        (note.impact ? noteHeight(note.impact) : 0) +
        (note.unknowns ? noteHeight(note.unknowns) : 0)
      : 0) +
    (contentStatusText(k) ? paragraphHeight(contentStatusText(k), 9) : 0) +
    (s.kind === "move"
      ? paragraphHeight(`Why it moved: ${priceReasonText(s.why)}`, 10) +
        (s.why?.source ? 40 : 0)
      : 0) +
    paragraphHeight(metadata, 8) +
    (new Set([s.url, ...(s.sourceUrls || [])].filter(Boolean)).size * 22) +
    20 +
    k.others.reduce(
      (n, r) =>
        n +
        paragraphHeight(`Related: ${r.headline}`, 10) +
        paragraphHeight(
          `${r.source} / ${storyWhen(r)}${r.related ? " / related entity" : ""}${r.late ? " / not in the previous brief" : ""}`,
          8,
        ) +
        (r.dek ? paragraphHeight(r.dek, 10) : 0) + (r.sourceUrls?.length || 0) * 22,
      0,
    )
  );
};
const cell = (text, options = {}) => ({ text, ...options });

function calendar(pdf, brief, dashboardUrl) {
  const c = brief.calendar;
  if (!c) return;
  pdf.section("On the calendar", {
    fresh: true,
    subtitle: `The week ahead / ${range(c)}`,
  });
  if (!c.rows.length)
    pdf.note(
      "CALENDAR COVERAGE",
      c.screener.ok || c.moneycontrol.ok
        ? "Nothing scheduled on a portfolio company in the next seven days, as far as the calendars read go."
        : "Neither calendar could be read - the week ahead is not known, not empty.",
    );
  else
    pdf.table(
      [
        { label: "DATE / IST", width: 110 },
        { label: "COMPANY", width: 197 },
        { label: "EVENT / SOURCE", width: CONTENT - 307 },
      ],
      c.rows.map((r) => ({
        cells: [
          cell(calendarDayLabel(r.date, brief.day), {
            font: "F2",
            color: ACCENT,
          }),
          [
            cell(r.company, { font: "F2" }),
            cell(r.ticker, { size: 8, color: MUTED }),
          ],
          [
            cell(`${r.label}${r.time ? ` / ${r.time} IST` : ""}`),
            cell(r.sources.join(" / "), {
              size: 8,
              color: ACCENT,
              url: readableUrl(r.url, dashboardUrl),
            }),
            ...sourceLinks(r, dashboardUrl).filter(url => url !== readableUrl(r.url, dashboardUrl))
              .map(url => cell("Additional calendar source ->", { size: 8, color: ACCENT, url })),
          ],
        ],
      })),
    );
  if (c.more > 0)
    pdf.paragraph(`${c.more} more on the dashboard's Earnings Calendar.`, {
      size: 9,
      color: MUTED,
    });
}
function actions(pdf, brief, dashboardUrl) {
  const x = brief.actions;
  if (!x) return;
  pdf.section("Corporate actions", {
    subtitle: `Ex-dates, record dates and book closures / ${range(x)}`,
  });
  if (!x.rows.length)
    pdf.note(
      "ACTION COVERAGE",
      x.source.ok
        ? "No ex-date, record date or book closure on a portfolio company in the next seven days."
        : "The corporate-actions capture could not be read - the week ahead is not known, not empty.",
    );
  else
    pdf.table(
      [
        { label: "KEY DATES", width: 130 },
        { label: "COMPANY", width: 180 },
        { label: "ACTION / SOURCE", width: CONTENT - 310 },
      ],
      x.rows.map((r) => ({
        cells: [
          r.dates.map((d) =>
            cell(
              `${d.label} ${istLabel(istInstant(d.date), { time: false })}`,
              { size: 9, color: ACCENT },
            ),
          ),
          [
            cell(r.company, {
              font: "F2",
              url: readableUrl(r.url, dashboardUrl),
            }),
            cell(r.ticker, { size: 8, color: MUTED }),
          ],
          [
            cell(r.purpose),
            cell(r.source, {
              size: 8,
              color: ACCENT,
              url: readableUrl(r.url, dashboardUrl),
            }),
            ...sourceLinks(r, dashboardUrl).filter(url => url !== readableUrl(r.url, dashboardUrl))
              .map(url => cell("Additional action source ->", { size: 8, color: ACCENT, url })),
          ],
        ],
      })),
    );
  if (x.more > 0)
    pdf.paragraph(`${x.more} more on the dashboard's Corporate Actions view.`, {
      size: 9,
      color: MUTED,
    });
  if (x.source.debtSkipped)
    pdf.paragraph(
      `${x.source.debtSkipped} interest or redemption date(s) on an issuer's debt instruments not listed.`,
      { size: 9, color: MUTED },
    );
}
function performance(pdf, brief) {
  const p = brief.performance;
  if (!p) return;
  const title =
    brief.edition === "evening"
      ? "Portfolio today"
      : "Portfolio / previous session";
  pdf.section(title, {
    fresh: true,
    subtitle: `Session ${p.session || "unavailable"} / ${p.state === "capture" ? "closing quotes" : p.state === "daily" ? "completed daily bars" : "prices unavailable"}`,
  });
  if (p.state === "unavailable" || !p.rows.length) {
    pdf.note(
      "PRICES UNAVAILABLE",
      `Prices for this session could not be read (${p.reason || "unavailable"}${p.priceDate ? `; daily bars end ${p.priceDate}` : ""}) - the day's performance is not known, not flat.`,
    );
    return;
  }
  const s = p.summary;
  pdf.metrics([
    {
      value: `${p.quoted} / ${p.listed}`,
      label: "LISTED HOLDINGS QUOTED",
      size: 18,
    },
    { value: String(s.up), label: "UP", color: tone(1) },
    { value: String(s.down), label: "DOWN", color: tone(-1) },
    {
      value: signed(s.median),
      label: `MEDIAN / ${s.flat} FLAT`,
      color: tone(s.median),
      size: 18,
    },
  ]);
  pdf.paragraph(
    "Price performance of listed holdings / median is unweighted, not portfolio P&L.",
    { size: 9, color: MUTED, gap: 14 },
  );
  const columns = [
    { label: "HOLDING", width: CONTENT - 285 },
    { label: "SYMBOL", width: 90 },
    { label: "CLOSE / INR", width: 110, align: "right" },
    { label: "DAY / %", width: 85, align: "right" },
  ];
  pdf.table(
    columns,
    p.rows.map((r) => ({
      cells: [
        cell(r.company, { font: "F2" }),
        cell(r.ticker, { size: 8, color: MUTED }),
        cell(number(r.last)),
        cell(signed(r.pct), { font: "F2", color: tone(r.pct) }),
      ],
    })),
    { lineHeight: 12, padding: 8 },
  );
  if (p.unquoted)
    pdf.paragraph(
      `${p.unquoted} listed holdings had no quote for this session and are not listed - not flat.`,
      {
        size: 9,
        color: MUTED,
      },
    );
}
function markets(pdf, brief) {
  pdf.section("Indian and global markets", {
    fresh: true,
    subtitle:
      "Levels and daily changes / source time and verification are shown for every instrument",
  });
  for (const g of [
    ...MARKET_GROUPS.filter((g) => g.id === "india"),
    ...MARKET_GROUPS.filter((g) => g.id !== "india"),
  ]) {
    const rows = brief.markets.rows.filter((r) => r.group === g.id);
    if (!rows.length) continue;
    pdf.ensure(110);
    pdf.context = `Indian and global markets / ${g.label}`;
    pdf.paragraph(g.label, { font: "F2", size: 12, color: ACCENT, gap: 10 });
    pdf.table(
      [
        { label: "INSTRUMENT", width: 270 },
        { label: "LEVEL", width: 125, align: "right" },
        { label: "DAY / %", width: CONTENT - 395, align: "right" },
      ],
      rows.map((r) => ({
        cells: [
          cell(`${r.label}${r.unit ? ` (${r.unit})` : ""}`, { font: "F2" }),
          cell(formatLast(r) ?? "Unavailable"),
          cell(formatPct(r) ?? "Unavailable", {
            font: "F2",
            color: tone(r.changePct),
          }),
        ],
        detail: `${asOfLabel(r)}${r.change != null ? ` / change ${formatChange(r)}` : ""}`,
      })),
      { lineHeight: 12, padding: 8 },
    );
  }
}

export function renderBriefPdf(
  brief,
  { dashboardUrl = PRODUCTION_ORIGIN, productName = "Research Central" } = {},
) {
  const stats = briefStats(brief),
    edition = TAGLINES[brief.edition],
    date = istLabel(brief.at, { time: false });
  const reading=editorialEvents(brief,stats.companies);
  const pdf = new BriefPdf({
    brand: BRAND,
    edition,
    date,
    accent: ACCENT,
    tint: TINT,
  });
  pdf.rect(0, 0, WIDTH, 7, ACCENT);
  pdf.y = 48;
  pdf.paragraph(BRAND.toUpperCase(), { font: "F3", size: 34, gap: 8 });
  pdf.paragraph(`${productName} / ${edition}`, {
    font: "F2",
    size: 14,
    color: ACCENT,
    gap: 18,
  });
  pdf.paragraph(istDateLong(brief.at), { size: 12, gap: 12 });
  pdf.rule();
  pdf.y += 18;
  pdf.metrics([
    { value: String(reading.events.length), label: "DISTINCT DEVELOPMENTS" },
    {
      value: `${new Set(reading.events.map(e=>e.ticker)).size} / ${brief.book.listed}`,
      label: "COMPANIES WITH DEVELOPMENTS",
      size: 18,
    },
    { value: String(stats.stories), label: "SOURCE ITEMS RETAINED" },
    { value: String(brief.content?.pending ?? 'Unknown'), label: "PENDING SOURCE READS" },
  ]);
  pdf.paragraph(
    `Window: ${istLabel(brief.window.from)} to ${istLabel(brief.window.to)}${brief.onDemand ? " / built on request" : ""}`,
    { size: 9, color: MUTED, gap: 16 },
  );
  pdf.contents([
    "Investment briefing",
    "Your portfolio companies",
    ...(brief.calendar ? ["On the calendar"] : []),
    ...(brief.actions ? ["Corporate actions"] : []),
    ...(brief.performance
      ? [
          brief.edition === "evening"
            ? "Portfolio today"
            : "Portfolio / previous session",
        ]
      : []),
    "Indian and global markets",
    "Sources & reading notes",
  ]);
  pdf.note(
    "READING THIS BRIEF",
    "Every company update retains its original evidence and links. Market and portfolio figures keep their source dates, verification limits and unavailable states. Use the contents above or the PDF bookmarks to move between sections.",
  );
  pdf.section("Investment briefing", {fresh:true,subtitle:"Distinct developments first / full source register follows"});
  pdf.paragraph(`${reading.events.length} development${reading.events.length===1?'':'s'} / ${reading.reference.length} reference or calendar groups / ${reading.repeated.length} previously covered groups. Source history and all links are retained in the following register.`,{size:9,color:MUTED});
  if(brief.content?.pending)pdf.note("READING COVERAGE",`${brief.content.pending} source items remain unread. Unread headlines are reported leads, not verified document summaries. Full source checks and failures are disclosed in Sources & reading notes.`);
  for(const event of reading.events) {
    pdf.ensure(100);
    pdf.paragraph(`${event.company} / ${event.lead.kind==='filing'?'Corporate announcement':'Development'}`,{font:'F2',size:11,gap:4});
    const summary=event.summary || event.sourceSummary || event.description || event.lead.headline;
    pdf.paragraph(summary,{size:10});
    if(event.summary&&event.note?.impact)pdf.paragraph(`Potential impact / AI: ${event.note.impact}`,{size:9,color:MUTED});
    if(event.summary&&event.note?.unknowns)pdf.paragraph(`Watch next: ${event.note.unknowns}`,{size:9,color:MUTED});
    pdf.paragraph(`${event.evidence} / ${event.read} of ${event.total} source items read / ${storyWhen(event.lead)}`,{size:8,color:MUTED});
    pdf.paragraph('Primary / lead source ->',{size:8,color:ACCENT,url:readableUrl(event.lead.content?.sourceUrl||event.lead.url,dashboardUrl),gap:12});
  }
  pdf.section("Your portfolio companies", {
    fresh: true,
    subtitle:
      "Complete source register / includes reference records and unverified matches",
  });
  if (!stats.stories)
    pdf.note(
      "SOURCE COVERAGE",
      "No updates in the available source readings. See source coverage below for missing or unavailable feeds.",
    );
  for (const c of stats.companies) {
    pdf.context = "";
    pdf.ensure(
      Math.min(
        500,
        85 + updateHeight(c.clusters[0], brief.ai?.items?.[c.clusters[0].id]),
      ),
    );
    pdf.context = c.company;
    pdf.paragraph(c.company, { font: "F3", size: 19, gap: 3 });
    pdf.paragraph(
      `${c.ticker} / ${c.clusters.length} updates${c.stories.length > c.clusters.length ? ` from ${c.stories.length} source items` : ""}`,
      { size: 9, color: MUTED },
    );
    pdf.paragraph("On the dashboard ->", {
      font: "F2",
      size: 9,
      color: ACCENT,
      url: `${dashboardUrl}/#/research/daily-alerts?scope=portfolio&company=${encodeURIComponent(c.ticker)}`,
      gap: 10,
    });
    pdf.rule();
    pdf.y += 10;
    for (const k of c.clusters) {
      const s = k.main,
        note = brief.ai?.items?.[k.id];
      const needed = updateHeight(k, note);
      const startPage = pdf.pages.length;
      if (k !== c.clusters[0]) pdf.ensure(Math.min(650, needed) + 23);

      pdf.paragraph(s.headline, {
        font: "F3",
        size: 13,
        url: readableUrl(s.url, dashboardUrl),
        gap: 7,
      });
      if(referenceReason(s))pdf.paragraph(`Reference only: ${referenceReason(s)}`,{font:'F2',size:9,color:MUTED});
      if (s.dek) pdf.paragraph(s.dek, { size: 10, color: MUTED });
      if (note) {
        pdf.note("AI SUMMARY", note.summary);
        if (note.impact) pdf.note("POTENTIAL IMPACT / AI", note.impact);
        if (note.unknowns) pdf.note("STILL UNKNOWN", note.unknowns);
      }
      if (contentStatusText(k))
        pdf.paragraph(contentStatusText(k), { size: 9, color: MUTED });
      if (s.kind === "move") {
        pdf.paragraph(`Why it moved: ${priceReasonText(s.why)}`, { size: 10 });
        if (s.why?.source)
          pdf.paragraph(
            `Source: ${s.why.source.publisher} / ${storyWhen(s.why.source)}`,
            {
              size: 9,
              color: ACCENT,
              url: s.why.source.url,
            },
          );
      }
      pdf.paragraph(
        `${s.topic.label} / ${s.mood.label} / ${s.source} / ${storyWhen(s)}${s.related ? " / related entity" : ""}${s.late ? " / not in the previous brief" : ""}`,
        { size: 8, color: MUTED },
      );
      for (const [i, url] of sourceLinks(s, dashboardUrl).entries())
        pdf.paragraph(i === 0 ? "Read original source ->" : `Read additional original source ${i + 1} ->`, {
          font: "F2",
          size: 9,
          color: ACCENT,
          url,
        });
      // Pair saved facts with that version's own linked heading. Copies remain
      // linked below without printing an identical document's extraction again.
      const factSources=new Set((k.documents || [{main:s},...k.others.map(main=>({main}))]).map(d=>d.main));
      const savedFacts=item=>{
        if(!factSources.has(item)||!item.content?.facts?.length)return;
        pdf.paragraph(`Saved source facts / ${item.content.state}`,{font:'F2',size:9,color:MUTED});
        for(const fact of item.content.facts)pdf.paragraph(`${fact.name || fact.field}: ${fact.value}`,{size:8,color:MUTED});
      };
      savedFacts(s);
      for (const r of k.others) {
        pdf.paragraph(`Related: ${r.headline}`, {
          size: 10,
          url: readableUrl(r.url, dashboardUrl),
        });
        pdf.paragraph(
          `${r.source} / ${storyWhen(r)}${r.related ? " / related entity" : ""}${r.late ? " / not in the previous brief" : ""}`,
          { size: 8, color: MUTED },
        );
        if (r.dek) pdf.paragraph(r.dek, { size: 10, color: MUTED });
        savedFacts(r);
        for (const url of sourceLinks(r, dashboardUrl).filter(url => url !== readableUrl(r.url, dashboardUrl)))
          pdf.paragraph("Read additional related source ->", { font: "F2", size: 9, color: ACCENT, url });
      }
      pdf.y += 4;
      pdf.rule();
      pdf.y += 12;
    }
  }

  const more =
    brief.announcements.more +
    brief.news.more +
    (brief.trades?.more || 0) +
    (brief.moves?.more || 0);
  if (more)
    pdf.paragraph(`${more} more items in this window on the dashboard.`, {
      color: ACCENT,
      url: `${dashboardUrl}/#/research/daily-alerts?scope=portfolio`,
    });
  // Preserve the existing routine-notice disclosure; structured supplements are laid out below.
  const routine = briefSupplementLines(brief).find((line) =>
    /routine filing/.test(line),
  );
  if (routine) pdf.paragraph(routine, { size: 9, color: MUTED });
  calendar(pdf, brief, dashboardUrl);
  actions(pdf, brief, dashboardUrl);
  performance(pdf, brief);
  markets(pdf, brief);
  pdf.section("Sources & reading notes", {
    fresh: true,
    subtitle: "Actual checks, capture limits and interpretation notes",
  });
  sourcesNote(brief)
    .split(" · ")
    .forEach((part, i) => {
      pdf.ensure(48);
      pdf.paragraph(`${String(i + 1).padStart(2, "0")} / ${part}`, {
        size: 9,
        color: MUTED,
        gap: 10,
      });
      pdf.rule();
      pdf.y += 9;
    });
  pdf.note(
    "HOW TO READ THE ANALYSIS",
    "AI summaries use extracted source-document or article facts. Each update states whether its sources were read or remain pending. Possible impacts are interpretations, not established outcomes. Mood follows stated filing, trade and price-move rules; publisher reports remain neutral. Listed-holding price moves and their unweighted median do not represent portfolio P&L. This brief is informational, not investment advice.",
  );
  pdf.paragraph(
    `Built ${istLabel(brief.builtAt, { year: true })}. Automated by Munshot.`,
    {
      font: "F2",
      size: 9,
      color: ACCENT,
    },
  );
  return pdf.bytes(`${BRAND} / ${edition} / ${brief.day}`);
}
