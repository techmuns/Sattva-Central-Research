import assert from 'node:assert/strict';
import { chatterHighlightReading, shortChatterHighlight } from '../public/js/data/chatter-highlight-reading.js';

const cases = {
  negative: [
    'HDFC Bank shares are underperforming despite CEO clarity, Q2 update',
    'HDFC Bank shares drop 15% in 3 months since Q1 results. Will Q2 earnings bring redemption?',
    'PB Fintech shares: Nomura slashes target price to Rs 1,100, retains Neutral',
    'PB Fintech share price target gets a 31% cut from Nomura',
    'HDFC Bank shares pare early gains, end over 2 pc lower',
    'HDFC Bank gets new CEO: Stock down 25% thus far in 2026; what charts say?',
    'Company reports disappointing earnings as profits fell 20%',
    'Losses widened 30% and expenses rose',
    'Broker cuts its price target and downgrades the stock',
    'Margins contracted as weak demand persists',
    'Technical indicators still signal weakness',
    'Company lost a large contract',
    'Profit halved during the quarter', 'Rising costs weigh on company earnings',
    'Revenue growth slows to 3%',
  ],
  positive: [
    'TCS stock jumps over 5 per cent; market valuation rises to Rs 7.88 lakh crore post Q2 FY27 result',
    'Company shares rally 5% after profits beat estimates',
    'Profit grew 15% and revenue rose to Rs 2,000 crore',
    'Losses narrowed 30% and costs fell',
    'Debt reduced and margins expanded',
    'Broker raises its target price and upgrades the stock',
    'Company wins a new contract worth Rs 50 crore',
    'Analyst retains a buy rating after strong results',
    'Despite lower revenues, shares rallied 5%',
    'I am bullish on the company after record profits',
    'Profits doubled', 'Shares rally as lower costs lift profits',
    'Profits not only grew but also beat estimates',
    'Shares rallied 5% in May', 'Company bags a ₹1,000-crore order',
  ],
  unclear: [
    'PB Fintech Ltd.', 'Company Q2 earnings call on Thursday',
    'Will Company shares rally after results?', 'Could Company profits rise next quarter?',
    'Shares may fall if the rumored deal fails', 'Company stock is not falling',
    'Company profit did not grow', 'No strong results were reported',
    'The company is not bullish about the quarter', 'The Growth Fund bought shares',
    'Company received a court order', '', null,
    'Company denies that shares rallied', 'Debt position improves after discussions',
    'The company isn’t bullish', 'The company cannot grow profits',
    'Company wins an order from the court',
  ],
  mixed: ['Shares rose but profits fell 15%', 'Revenue rose while margins contracted',
    'Profits increased; debt also increased'],
};
for (const [expected, texts] of Object.entries(cases)) for (const text of texts) {
  const reading = chatterHighlightReading(text);
  assert.equal(reading.tone, expected, `${text} (${reading.reason})`);
  assert(shortChatterHighlight(text, reading).split(' ').filter(Boolean).length <= 16);
}
const long = 'Company announced the earnings-call date. Shares fell 15% following weak results after the company released quarterly disclosures and management comments late yesterday evening.';
assert(shortChatterHighlight(long).startsWith('Shares fell 15%'), 'short highlight quotes the directional sentence, not a neutral preamble');
assert(!shortChatterHighlight(long).includes('announced'));
assert.equal(chatterHighlightReading('Stock rose 5%').tone, 'positive', 'repeated calls do not retain regex state');
assert.equal(chatterHighlightReading('Stock rose 5%').tone, 'positive');
console.log(`PASS ${Object.values(cases).flat().length} text readings, financial inverse metrics, questions, negation, mixed posts and short verbatim points`);
