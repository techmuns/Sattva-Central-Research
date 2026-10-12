// Lossless JSON working representation. Repeated text has one copy and buffers can move to
// a browser worker without structured-cloning hundreds of thousands of record objects.
import { runSteps, runStepsInSlices } from './slices.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const NULL = 0, FALSE = 1, TRUE = 2, NUMBER = 3, STRING = 4, ARRAY = 5, OBJECT = 6, UNDEFINED = 7, HOLE = 8;
const hole = Symbol('array-hole');

export function* packJsonSteps(value) {
  const words = [], numbers = [], strings = [], ids = new Map();
  let visited = 0;
  const textId = text => {
    let id = ids.get(text);
    if (id === undefined) { id = strings.length; ids.set(text, id); strings.push(text); }
    return id;
  };
  const ancestors = new Set();
  function* visit(input) {
    if (++visited % 256 === 0) yield;
    if (input === null) words.push(NULL);
    else if (input === undefined) words.push(UNDEFINED);
    else if (typeof input === 'boolean') words.push(input ? TRUE : FALSE);
    else if (typeof input === 'number') { words.push(NUMBER, numbers.length); numbers.push(input); }
    else if (typeof input === 'string') words.push(STRING, textId(input));
    else if (typeof input === 'object') {
      if (ancestors.has(input)) throw Error('Cyclic JSON value');
      if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
        throw Error('Unsupported JSON value');
      ancestors.add(input);
      if (Array.isArray(input)) {
        words.push(ARRAY, input.length);
        for (let i = 0; i < input.length; i++) {
          if (Object.hasOwn(input, i)) yield* visit(input[i]);
          else { words.push(HOLE); if (++visited % 256 === 0) yield; }
        }
      } else {
        const keys = Object.keys(input);
        words.push(OBJECT, keys.length);
        for (const key of keys) { words.push(textId(key)); yield* visit(input[key]); }
      }
      ancestors.delete(input);
    } else throw Error('Unsupported JSON value');
  }
  yield* visit(value);
  const offsets = new Uint32Array(strings.length + 1), escaped = new Uint8Array(strings.length), chunks = [];
  let bytes = 0;
  for (let i = 0; i < strings.length; i++) {
    // JSON permits escaped lone surrogates. UTF-8 alone would replace them and change a field.
    const wellFormed = strings[i].isWellFormed();
    escaped[i] = wellFormed ? 0 : 1;
    const chunk = encoder.encode(wellFormed ? strings[i] : JSON.stringify(strings[i]));
    offsets[i] = bytes; bytes += chunk.byteLength; chunks.push(chunk);
    if (i % 128 === 127) yield;
  }
  offsets[strings.length] = bytes;
  const text = new Uint8Array(bytes);
  for (let i = 0; i < chunks.length; i++) {
    text.set(chunks[i], offsets[i]);
    if (i % 128 === 127) yield;
  }
  return { version: 1, words: new Int32Array(words), numbers: new Float64Array(numbers), offsets, escaped, text };
}

export function* unpackJsonSteps(packed) {
  if (packed?.version !== 1 || !(packed.words instanceof Int32Array) || !(packed.numbers instanceof Float64Array) ||
      !(packed.offsets instanceof Uint32Array) || !(packed.escaped instanceof Uint8Array) ||
      !(packed.text instanceof Uint8Array) || !packed.offsets.length || packed.escaped.length !== packed.offsets.length - 1 ||
      packed.offsets[0] !== 0 || packed.offsets.at(-1) !== packed.text.length) throw Error('Invalid packed JSON');
  const strings = new Array(packed.offsets.length - 1);
  for (let i = 0; i < strings.length; i++) {
    if (packed.offsets[i] > packed.offsets[i + 1]) throw Error('Invalid packed JSON text');
    if (packed.escaped[i] > 1) throw Error('Invalid packed JSON text');
    const decoded = decoder.decode(packed.text.subarray(packed.offsets[i], packed.offsets[i + 1]));
    strings[i] = packed.escaped[i] ? JSON.parse(decoded) : decoded;
    if (typeof strings[i] !== 'string') throw Error('Invalid packed JSON text');
    if (i % 128 === 127) yield;
  }
  let cursor = 0, visited = 0;
  const word = () => { if (cursor >= packed.words.length) throw Error('Incomplete packed JSON'); return packed.words[cursor++]; };
  const string = () => { const id = word(); if (id < 0 || id >= strings.length) throw Error('Invalid packed JSON string'); return strings[id]; };
  function* visit() {
    if (++visited % 256 === 0) yield;
    const kind = word();
    if (kind === NULL) return null;
    if (kind === UNDEFINED) return undefined;
    if (kind === HOLE) return hole;
    if (kind === FALSE) return false;
    if (kind === TRUE) return true;
    if (kind === STRING) return string();
    if (kind === NUMBER) {
      const id = word(); if (id < 0 || id >= packed.numbers.length) throw Error('Invalid packed JSON number');
      return packed.numbers[id];
    }
    if (kind !== ARRAY && kind !== OBJECT) throw Error('Invalid packed JSON token');
    const length = word();
    if (length < 0 || length > packed.words.length - cursor) throw Error('Invalid packed JSON length');
    const value = kind === ARRAY ? new Array(length) : {};
    for (let i = 0; i < length; i++) {
      if (kind === ARRAY) { const item = yield* visit(); if (item !== hole) value[i] = item; }
      else {
        const key = string(), item = yield* visit();
        if (item === hole) throw Error('Invalid packed JSON object');
        if (key === '__proto__') Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
        else value[key] = item;
      }
    }
    return value;
  }
  const value = yield* visit();
  if (value === hole) throw Error('Invalid packed JSON root');
  if (cursor !== packed.words.length) throw Error('Trailing packed JSON');
  return value;
}

export const packJson = value => runSteps(packJsonSteps(value));
export const unpackJson = value => runSteps(unpackJsonSteps(value));
export const packJsonAsync = value => runStepsInSlices(packJsonSteps(value), { sliceMs: 8 });
export const unpackJsonAsync = value => runStepsInSlices(unpackJsonSteps(value), { sliceMs: 8 });
export const jsonBuffers = packed => [packed.words.buffer, packed.numbers.buffer, packed.offsets.buffer, packed.escaped.buffer, packed.text.buffer];
