// Tailwind utilities and custom CSS share these role-specific colour tokens.
// Solid action fills stay saturated; pale surfaces and foregrounds change.
const neutral = new Set(['slate', 'gray', 'zinc', 'neutral', 'stone']);
const surface = { 50: '#111c2e', 100: '#1c293e', 200: '#2a3a51', 300: '#42526a' };
const ink = { 50: '#f8fafc', 100: '#f1f5f9', 200: '#dce5f2', 300: '#bbc9dc', 400: '#9eafc7', 500: '#a5b5cb', 600: '#bfccdf', 700: '#d4deec', 800: '#e4ebf5', 900: '#f1f5f9', 950: '#f8fafc' };
const edge = { 50: '#25334a', 100: '#2b3a51', 200: '#35465f', 300: '#4b5e7a' };
const rgb = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(' ');
const blend = (hex, weight) => {
  const base = [17, 28, 46], tint = rgb(hex).split(' ').map(Number);
  return '#' + base.map((v, i) => Math.round(v * (1 - weight) + tint[i] * weight).toString(16).padStart(2, '0')).join('');
};

function dark(role, family, shade, ramp) {
  const value = ramp[shade];
  if (role === 'text') return neutral.has(family) ? ink[shade] || value : ramp[shade >= 500 ? (shade >= 800 ? 200 : 300) : shade] || value;
  if (neutral.has(family)) return (role === 'surface' ? surface : edge)[shade] || value;
  return shade <= 300 ? blend(ramp[400] || value, role === 'edge' ? 0.4 : ({ 50: 0.1, 100: 0.17, 200: 0.25, 300: 0.4 }[shade])) : value;
}

function entries(palette, visit) {
  for (const [family, ramp] of Object.entries(palette)) {
    if (!ramp || typeof ramp !== 'object') continue;
    for (const [shade, hex] of Object.entries(ramp)) {
      if (/^#[0-9a-f]{6}$/i.test(hex)) visit(family, shade, hex, ramp);
    }
  }
}

function colors(role, palette) {
  const result = {};
  entries(palette, (family, shade, hex) => {
    (result[family] ||= {})[shade] = `rgb(var(--${role}-${family}-${shade}, ${rgb(hex)}) / <alpha-value>)`;
  });
  if (role !== 'text') result.white = 'rgb(var(--surface-white, 255 255 255) / <alpha-value>)';
  return result;
}

function tokens(palette, isDark) {
  const result = { '--surface-white': isDark ? '22 33 52' : '255 255 255' };
  for (const role of ['surface', 'text', 'edge']) entries(palette, (family, shade, hex, ramp) => {
    result[`--${role}-${family}-${shade}`] = rgb(isDark ? dark(role, family, shade, ramp) : hex);
  });
  return result;
}

module.exports = { colors, tokens };
