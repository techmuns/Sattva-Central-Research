// Public visual identities only. This catalogue contains no Family membership,
// holdings, account identifiers or private workbook data. Assets are served locally.
import { escapeHtml as esc } from '../core/dom.js';
import { avatarFor } from '../ui/visual.js';

export const MANAGER_IMAGES = [
  ['ashika', 'Ashika Group', ['ashika'], ['custodian']],
  ['julius-baer', 'Julius Baer', ['julius baer'], ['custodian']],
  ['nuvama', 'Nuvama', ['nuvama'], ['custodian']],
  ['tandem', 'Tandem Capital', ['tandem parallel fund', 'tandem capital'], ['fund']],
  ['ideaspring', 'Ideaspring Capital', ['ideaspring capital'], ['fund']],
  ['fireside', 'Fireside Ventures', ['fireside ventures'], ['fund']],
  ['stellaris', 'Stellaris Venture Partners', ['stellaris venture partners'], ['fund']],
  ['waterbridge', 'WaterBridge Ventures', ['waterbridge ventures'], ['fund']],
  ['disruptors', 'Disruptors Capital', ['disruptors capital'], ['fund']],
  ['lc-nueva', 'Lighthouse Canton · LC Nueva', ['lc nueva'], ['fund']],
  ['multiply', 'Multiply Ventures', ['multiply ventures'], ['fund']],
  ['capier', 'Capier Investments', ['capier'], ['fund']],
  ['roots', 'Roots Ventures', ['roots ventures'], ['fund']],
  ['z47', 'Z47 · formerly Matrix Partners India', ['matrix partners india', 'z47'], ['fund']],
  ['lumikai', 'Lumikai', ['lumikai'], ['fund']],
  ['sparrow', 'Sparrow Capital', ['sparrow capital'], ['fund']],
  ['pavestone', 'Pavestone', ['pavestone technology fund'], ['fund']],
  ['kettleborough', 'Kettleborough VC', ['kettleborough', 'bowden syndicates kettleborough nisarg'], ['fund']],
  ['shastra', 'Shastra VC · formerly Veda VC', ['veda investment trust', 'shastra winners fund', 'shastra vc'], ['fund']],
  ['sauce', 'Sauce VC', ['sauce consumer venture capital', 'sauce continuity fund', 'sauce continiuity fund'], ['fund']],
  ['aeravti', 'Aeravti Ventures', ['aeravti ventures'], ['fund']],
  ['promaft', 'Promaft Partners', ['promaft partner', 'promaft partners'], ['fund']],
  ['blue-ashva', 'Blue Ashva Capital', ['innergize blue ashva', 'blue ashva'], ['fund']],
  ['360-one', '360 ONE · formerly IIFL Wealth', ['iifl special opportunities fund', '360 one special opportunities fund'], ['fund']],
  ['trifecta', 'Trifecta Capital', ['trifecta leaders fund'], ['fund']],
  ['abakkus', 'Abakkus', ['abbakkus four two eight', 'abakkus four two eight'], ['fund']],
  ['alteria', 'Alteria Capital', ['alteria capital'], ['fund']],
  ['exfinity', 'Exfinity Ventures', ['exfinity'], ['fund']],
  ['bajaj-finserv', 'Bajaj Finserv Mutual Fund', ['bajaj finserv'], ['listed-fund']],
  ['hdfc', 'HDFC Mutual Fund', ['hdfc'], ['listed-fund']],
  ['nippon', 'Nippon India Mutual Fund', ['nippon india'], ['listed-fund']],
  ['icici-prudential', 'ICICI Prudential Mutual Fund', ['icici prudential'], ['listed-fund']],
].map(([id, name, aliases, kinds]) => ({ id, name, aliases, kinds, src: `/assets/managers/${id}.webp` }));

const normalise = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function managerImage(manager) {
  const name = normalise(manager.name);
  if (manager.kind === 'custodian' && name === 'direct in house') return {
    id: 'sattva', name: 'Sattva Ventures', src: '/assets/brand/sattva-ventures-mark.svg',
  };
  // A bounded name prefix supports workbook fund/series suffixes without matching
  // a different firm that happens to mention a brand elsewhere in its name.
  return MANAGER_IMAGES.find(image => image.kinds.includes(manager.kind) && image.aliases.some(alias => name === alias || name.startsWith(`${alias} `))) || null;
}

export function managerAvatar(manager) {
  const image = managerImage(manager), { color, initials } = avatarFor(manager.name);
  // The mounted gradient remains behind the image. Removing a failed local image
  // restores that fallback without changing the card size, focus or identity.
  return `<span class="manager-avatar" aria-hidden="true"><span class="manager-avatar-fallback bg-gradient-to-br ${color}">${esc(initials)}</span>${image ? `<img data-manager-image="${image.id}" src="${image.src}" alt="" title="${esc(image.name)}" width="44" height="44" loading="lazy" decoding="async" class="manager-image" onerror="this.remove()">` : ''}</span>`;
}
