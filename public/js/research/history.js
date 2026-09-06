// Apply the same conversation bound before upload and again on the server.
// The on-screen transcript can be longer without bloating every model request.
export function researchHistory(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  let chars = 0;
  for (const item of input.slice(-12).reverse()) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 2_000) : '';
    if (!role || !text || item.incomplete || chars >= 3_000) continue;
    const kept = text.slice(0, 3_000 - chars);
    chars += kept.length;
    out.push({ role, text: kept });
  }
  return out.reverse();
}
