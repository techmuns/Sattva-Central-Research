// Reusable evaluation cases. Passing a verified positions reply orders every
// holding from largest to smallest, including small funds and unknown tickers.
// No quantities, values, weights or account identifiers enter the output.
export const PORTFOLIO_QUESTIONS = [
  'What needs my attention across my portfolio today?',
  'What changed in my portfolio companies in the last 24 hours?',
  'What were the most important developments this week?',
  'Brief me on my top 5 holdings, largest first.',
  'What changed in my smallest 5 holdings?',
  'Which smaller holdings have material news I may have missed?',
  'Which holdings have no recent source coverage?',
  'Where do earnings, technicals and public chatter agree or conflict?',
  'Which announcements have the biggest implications for my holdings?',
  'Which of my companies have upcoming earnings or calls?',
  'Which holdings face debt, refinancing or credit-rating concerns?',
  'Which companies reported an order win, capacity expansion or acquisition?',
  'Which holdings have governance, auditor or regulatory concerns?',
  'Where did promoters or insiders disclose activity?',
  'Which companies gained or lost disclosed institutional ownership?',
  'What technical breakouts are supported by recent business developments?',
  'Are there dividends, splits, bonuses, buybacks or demergers to track?',
  'How could changes in steel demand affect my portfolio companies?',
  'What developments could affect multiple holdings? Separate evidence from inference.',
  'Which are my AI related stocks and how are they performing after Sterlite news?',
  'Which other stocks in my portfolio have comparable businesses and could benefit after Sterlite news?',
  'Which portfolio holdings supply data-centre infrastructure? Separate product peers from adjacent businesses.',
  'Which renewable energy holdings share business drivers? Distinguish potential benefit from measured returns.',
  'If crude oil prices fall, which portfolio businesses could benefit and which could lose?',
  'How would lower interest rates affect lenders and leveraged businesses in my portfolio?',
  'Which portfolio companies are sensitive to a weaker rupee, positively and negatively?',
  'Where do my portfolio businesses depend on the same customers or input costs?',
  'Which holdings could benefit if a competitor has a supply disruption? Distinguish fact from hypothesis.',
  'What second-order risks could a slowdown in construction create across my holdings?',
  'Which smaller holdings have a relevant business exposure that the largest holdings do not?',
  'Which companies have improving earnings but contrary evidence in Telegram or public chatter?',
  'If a major portfolio supplier raises prices, which other holdings could face margin pressure?',
  'What evidence would change the strongest positive view across my portfolio?',
  'Which apparent beneficiaries have already reported a benefit, and which remain hypothetical?',
  'Which portfolio companies are exposed to export tariffs and what offsets might matter?',
  'Compare my largest holding with my smallest holding.',
  'Which holdings are funds or have unresolved symbols?',
  'Are these prices live? Give the actual book and quote dates.',
  'What cannot be answered from the currently available dashboard evidence?',
  'What is my cost basis in my largest holding?',
  'What is my unrealised P&L and which accounts contribute to it?',
  'How many shares do I hold and what are the tax lots?',
  'What is my total family NAV, including private assets?',
  'Show my returns and explain any missing prices or periods.',
];

export const COMPANY_QUESTIONS = [
  ['latest', name => `What is the latest info on ${name} for me?`],
  ['week', name => `What changed at ${name} in the last 7 days?`],
  ['materiality', name => `What matters most about ${name} for my portfolio?`],
  ['earnings', name => `What do the latest reported earnings show for ${name}? Preserve periods and units.`],
  ['calls', name => `What guidance and risks are supported by the available con-call evidence for ${name}?`],
  ['filings', name => `Show the latest filings and corporate announcements for ${name}, with source links.`],
  ['operating', name => `What operating metrics explain the latest developments at ${name}?`],
  ['technicals', name => `What do the technical readings say about ${name}, and when were they measured?`],
  ['insiders', name => `What insider or promoter disclosures are available for ${name}?`],
  ['institutions', name => `What changed in disclosed institutional and investor ownership of ${name}?`],
  ['chatter', name => `What are Telegram, public news and Public Chatter saying about ${name}? Separate rumours from filings.`],
  ['conflicts', name => `Where do the sources disagree about ${name}?`],
  ['milestones', name => `What is the next dated catalyst or scheduled event for ${name}?`],
  ['gaps', name => `What information is missing or stale for ${name}?`],
];

export function researchQuestionBank(holdings, { complete = false } = {}) {
  const ordered = [...holdings].sort(complete
    ? (a, b) => b.weightPct - a.weightPct || a.isin.localeCompare(b.isin)
    : (a, b) => a.name.localeCompare(b.name));
  return ordered.flatMap((holding, index) => COMPANY_QUESTIONS.map(([category, make]) => ({
    id: `${holding.isin}:${category}`, company: holding.name, ticker: holding.ticker || null,
    rank: complete ? index + 1 : null, category, question: make(holding.name),
    expected: 'Use dated source evidence; cite claims; state material gaps. Never infer absence from omitted samples or unknown tickers.',
  })));
}
