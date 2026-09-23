// scripts/lib/yaml-lite.mjs — read the block-style YAML that PyYAML's `yaml.dump` writes, with
// nothing but the Node standard library.
//
//   parseYamlLite(text)  ->  plain objects, arrays, strings and integers
//
// WHY THIS EXISTS RATHER THAN `npm i yaml`
//   This repository has no package.json and no node_modules, deliberately (see CLAUDE.md, hard
//   rule 2): when a script needs a capability, the small version of it is built here. The one YAML
//   file this dashboard reads — the sector → KPI ontology in `scripts/fixtures/` — is machine-written
//   and uses a tiny subset of the language, so the reader implements exactly that subset:
//
//     • nested mappings, indented by any consistent number of spaces
//     • sequences of scalars written at their parent key's own indent (PyYAML's default style)
//     • plain scalars, 'single-quoted' scalars ('' is a literal quote) and integers
//     • `&anchor` on a block and `*alias` in place of a value
//     • whole-line `#` comments and blank lines
//
// ANYTHING ELSE THROWS, NAMING THE LINE. Flow collections, block scalars, double quotes, tabs,
// inline comments, duplicate keys and complex keys are not guessed at: a reader that quietly
// half-understood a construct would hand the build a map with a missing branch, and every sector
// under that branch would lose its KPIs without a word. Refusing is the parse check.

const fail = (line, message) => {
  throw new Error(`yaml-lite: line ${line}: ${message}`);
};

/** Split the source into meaningful lines, each with its indent and 1-based line number. */
function tokenize(text) {
  const lines = [];
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const number = i + 1;
    if (/\t/.test(raw.match(/^\s*/)[0])) fail(number, 'tab indentation is not supported');
    const content = raw.trimEnd();
    const trimmed = content.trimStart();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (/^(?:---|\.\.\.)$/.test(trimmed)) fail(number, 'document markers are not supported');
    lines.push({ number, indent: content.length - trimmed.length, text: trimmed });
  });
  return lines;
}

/** One scalar: an integer, a single-quoted string or a plain string. */
function scalar(raw, number) {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) fail(number, `unterminated single-quoted scalar: ${value}`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^["[{|>!%@`]/.test(value)) fail(number, `unsupported scalar form: ${value}`);
  if (/\s#/.test(value)) fail(number, `inline comments are not supported: ${value}`);
  if (/^[-+]?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * A mapping line's key and the rest of the line after the separating colon.
 *
 * A plain key ends at the first `: ` (or a colon closing the line), which is YAML's own rule and is
 * what lets `Auto Parts:O.E.M.: auto_components` read as the key `Auto Parts:O.E.M.` — the first
 * colon there has no space after it, so it is part of the key.
 */
function splitKey(text, number) {
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*:(?:\s+(.*)|\s*)$/.exec(text);
    if (!match) fail(number, `malformed quoted key: ${text}`);
    return { key: match[1].replace(/''/g, "'"), rest: (match[2] || '').trim() };
  }
  if (/^["?[{]/.test(text)) fail(number, `unsupported key form: ${text}`);
  const at = text.search(/:(?:\s|$)/);
  if (at <= 0) fail(number, `expected "key: value": ${text}`);
  return { key: text.slice(0, at).trim(), rest: text.slice(at + 1).trim() };
}

export function parseYamlLite(text) {
  const lines = tokenize(text);
  const anchors = new Map();
  let i = 0;

  const aliasOf = (rest, number) => {
    const name = rest.slice(1);
    if (!/^[\w-]+$/.test(name)) fail(number, `malformed alias: ${rest}`);
    if (!anchors.has(name)) fail(number, `unknown alias: ${rest}`);
    return anchors.get(name);
  };

  function sequence(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && /^-(?:\s|$)/.test(lines[i].text)) {
      const { number, text: line } = lines[i];
      const item = line.slice(1).trim();
      if (!item) fail(number, 'nested blocks inside a sequence are not supported');
      if (/^[^']*:(?:\s|$)/.test(item) && !item.startsWith("'")) fail(number, `mappings inside a sequence are not supported: ${item}`);
      out.push(item.startsWith('*') ? aliasOf(item, number) : scalar(item, number));
      i += 1;
    }
    return out;
  }

  /** The block that follows a key with no inline value: a sequence, a mapping, or nothing. */
  function blockAfter(parentIndent) {
    const next = lines[i];
    if (!next) return null;
    if (/^-(?:\s|$)/.test(next.text) && next.indent >= parentIndent) return sequence(next.indent);
    if (next.indent > parentIndent) return mapping(next.indent);
    return null;
  }

  function mapping(indent) {
    const out = {};
    while (i < lines.length) {
      const { number, indent: at, text: line } = lines[i];
      if (at < indent) break;
      if (at > indent) fail(number, `unexpected indentation (${at}, expected ${indent})`);
      if (/^-(?:\s|$)/.test(line)) break; // a sequence at this indent belongs to the parent key
      const { key, rest } = splitKey(line, number);
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(number, `duplicate key: ${key}`);
      i += 1;
      if (!rest) out[key] = blockAfter(indent);
      else if (rest.startsWith('&')) {
        const name = rest.slice(1);
        if (!/^[\w-]+$/.test(name)) fail(number, `malformed anchor: ${rest}`);
        const value = blockAfter(indent);
        if (value === null) fail(number, `anchor ${rest} has no block after it`);
        anchors.set(name, value);
        out[key] = value;
      } else if (rest.startsWith('*')) out[key] = aliasOf(rest, number);
      else out[key] = scalar(rest, number);
    }
    return out;
  }

  if (!lines.length) return null;
  const root = /^-(?:\s|$)/.test(lines[0].text) ? sequence(lines[0].indent) : mapping(lines[0].indent);
  if (i < lines.length) fail(lines[i].number, `could not read past this line: ${lines[i].text}`);
  return root;
}
