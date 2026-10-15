// Saves (version 2). Plain JSON; typed arrays become {"$typed": "Float32Array", "b64": "..."}.
// Transient fields (state.slices and any key starting with "_") are not saved.
// Version 1 saves are refused with SaveVersionError so the UI can start a new town.

import {SAVE_VERSION, emptyState} from './state.js';
import {runPhase} from './hooks.js';
import {setTerrainSeed} from '../terrain.js';

const TYPED = {Float32Array, Float64Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Uint8Array, Int8Array};
const TRANSIENT = new Set(['slices']);

export class SaveVersionError extends Error {
  constructor(version) {
    super('This save comes from an older Hearthvale. Old towns cannot be opened. A new town will start.');
    this.name = 'SaveVersionError';
    this.code = 'old-version';
    this.version = version;
  }
}

export class SaveFormatError extends Error {
  constructor(detail) {
    super(`This save cannot be read. ${detail}`);
    this.name = 'SaveFormatError';
    this.code = 'invalid';
  }
}

export function serialize(state) {
  return JSON.stringify(state, (key, value) => {
    if (key && (key[0] === '_' || TRANSIENT.has(key))) return undefined;
    if (ArrayBuffer.isView(value) && TYPED[value.constructor.name]) {
      return {$typed: value.constructor.name, b64: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))};
    }
    return value;
  });
}

export function restore(raw, {services = {}} = {}) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw, reviveTyped) : raw;
  } catch {
    throw new SaveFormatError('The file is not valid JSON.');
  }
  if (!data || typeof data !== 'object') throw new SaveFormatError('The file is empty.');
  if (data.version !== SAVE_VERSION) {
    if (data.version == null || data.version < SAVE_VERSION) throw new SaveVersionError(data.version ?? 1);
    throw new SaveFormatError(`Save version ${data.version} is newer than this game.`);
  }
  validate(data);
  // The valley first: everything after this reads the terrain. Saves from before
  // seeded valleys have no terrainSeed and keep the classic valley.
  setTerrainSeed('terrainSeed' in data ? data.terrainSeed : null);
  const state = {...emptyState(data.seed), terrainSeed: data.terrainSeed ?? null, ...data};
  runPhase('restore', state, {services});
  return state;
}

function reviveTyped(key, value) {
  if (value && typeof value === 'object' && typeof value.$typed === 'string' && typeof value.b64 === 'string') {
    const Ctor = TYPED[value.$typed];
    if (!Ctor) throw new SaveFormatError(`Unknown array type ${value.$typed}.`);
    const bytes = fromBase64(value.b64);
    return new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
  }
  return value;
}

function validate(s) {
  const fail = (what) => { throw new SaveFormatError(what); };
  for (const k of ['buildings', 'people', 'households', 'enterprises', 'institutions', 'projects', 'docket']) {
    if (!Array.isArray(s[k])) fail(`The ${k} list is missing.`);
  }
  if (!s.time || !Number.isFinite(s.time.tick) || !Number.isFinite(s.time.year)) fail('The clock is missing.');
  if (!s.rng || !Number.isFinite(s.rng.main)) fail('The random seed is missing.');
  if (!Number.isFinite(s.treasury)) fail('The treasury is missing.');
  const r = s.roads;
  if (!r || !(r.wear instanceof Float32Array) || !(r.tier instanceof Uint8Array) || !(r.planned instanceof Uint8Array)) fail('The road map is missing.');
  if (r.wear.length !== r.W * r.H || r.tier.length !== r.W * r.H) fail('The road map has the wrong size.');
  const ids = new Set();
  for (const list of [s.buildings, s.people, s.households, s.enterprises]) {
    for (const rec of list) {
      if (!Number.isSafeInteger(rec.id) || ids.has(rec.id)) fail('Two records share an id.');
      ids.add(rec.id);
      if (rec.id >= s.nextId) fail('The id counter is behind.');
    }
  }
  for (const p of s.people) if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) fail('A walker has no position.');
}

// ---------------------------------------------------------------------------
// Base64 for Node and browsers.

const hasBuffer = typeof globalThis.Buffer === 'function';

function toBase64(bytes) {
  if (hasBuffer) return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function fromBase64(text) {
  if (hasBuffer) {
    const buf = globalThis.Buffer.from(text, 'base64');
    // Copy into a fresh, aligned ArrayBuffer so any typed view can sit on it.
    const out = new Uint8Array(buf.length);
    out.set(buf);
    return out;
  }
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
