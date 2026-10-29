// The AI Alerts layout a browser suite runs against. Compact is the product default (ported from
// Glow, 29 October 2026); the suites written for the Detailed cards opt into Detailed here,
// explicitly, instead of the default being bent for tests. An init script runs before every
// document's own scripts, so the choice holds across reloads and navigations inside each context.
export const AI_ALERTS_LAYOUT_KEY = 'sattva:ai-alerts:layout:v1';

const script = (layout) => `try { localStorage.setItem(${JSON.stringify(AI_ALERTS_LAYOUT_KEY)}, ${JSON.stringify(layout)}); } catch {}`;

/** Make every page and context this browser opens start in `layout` ('detailed' or 'compact'). */
export function useAiAlertsLayout(browser, layout = 'detailed') {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript({ content: script(layout) });
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await page.addInitScript({ content: script(layout) });
    return page;
  };
  return browser;
}
