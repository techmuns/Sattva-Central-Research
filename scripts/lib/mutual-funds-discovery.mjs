import {monthKey} from '../../worker/mutual-funds-model.mjs';
export const STATUTORY_PAGES={abakkus:'https://www.abakkusmf.com/statutory-disclosures.html','old-bridge':'https://oldbridgemf.com/statutory-disclosures.html'};
// These pages changed their rendered sections in September 2026. Read only
// published file links and labels; never execute scripts embedded in a source page.
export function statutoryLinks(slug,html,month) {
  const page=STATUTORY_PAGES[slug];if(!page)return [];
  const links=new Set(),text=html.replace(/\\"/g,'"');
  if(slug==='abakkus')for(const m of text.matchAll(/"title":"([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})"[^}]{0,600}"downloadMedia":\{[\s\S]{0,2000}?"url":"(\/uploads\/[^"<>]+\.xlsx?)"/g)) {
    if(+m[2]>=28 && monthKey(`${m[1].slice(0,3)}-${m[3]}`)===month)links.add(new URL(m[4],page).href);
  }
  if(slug==='old-bridge')for(const m of text.matchAll(/<h[234][^>]*>([^<]+)<\/h[234]>\s*<a[^>]*href="(\/uploads\/[^"<>]+\.xlsx?)"/g)) {
    const date=/-\s*([A-Za-z]+)\s+(20\d{2})\s*$/.exec(m[1]);
    if(date && /fund/i.test(m[1]) && monthKey(`${date[1].slice(0,3)}-${date[2]}`)===month)links.add(new URL(m[2],page).href);
  }
  return [...links].map(url=>({url,text:month}));
}
