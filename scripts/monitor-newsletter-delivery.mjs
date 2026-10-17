import fs from 'node:fs';
import {monitorNewsletters} from './lib/newsletter-delivery-audit.mjs';

// This program only reads the dashboards. The workflow separately retains its
// aggregate report, with no newsletter/mail/model credentials in this process.
const report=await monitorNewsletters();
const dir='.cache/newsletter-monitor';fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2)+'\n');
const lines=[`# Monday Sattva and Glow email monitor`,
  `Target: **19 October 2026, 08:00 IST**. Checked: ${report.checkedAt}.`,
  `Status: **${report.state}**.`,
  '| Product | State | Planned recipients | Verified recipients | Accepted / expected parts | Extra attempts |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...report.results.map(r=>`| ${r.name} | ${r.state} | ${r.plannedRecipients??'unknown'} | ${r.verifiedRecipients??0} | ${r.acceptedParts??0} / ${r.expectedParts??'unknown'} | ${r.extraAttempts??0} |`),
  '',...report.results.filter(r=>r.issues.length).map(r=>`${r.name}: ${r.issues.join(', ')}.`),
  '',report.evidence,'',report.limitation,
  '', 'This read-only monitor never sends/resends mail or starts/retries the production sender. GitHub schedules may run late. The local Codex chat can read this retained report when Codex reconnects; there is no offline chat callback.',
];
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`terminal=${report.terminal}\nactionable=${report.actionable}\n`);
console.log(JSON.stringify(report));
