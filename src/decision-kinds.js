// Decision kinds: the questions non-player actors may ask the local model.
//
// Pure module, shared by the browser (client-side checks) and the Node server
// (authoritative validation and instruction rendering). Nothing here touches
// the network, the DOM or secrets.
//
// A request to the service carries a shared `state` (a town, district, slice
// or proposal snapshot) plus short per-question instructions. Questions with
// byte-identical states travel together and the service reads that state
// once, and caches it, so put shared context in `state` and keep
// instructions short. Throughput is bound by input tokens.
//
// ADDING A KIND
//   Population kinds normally live in src/sim/decisions/kinds.js (pure data,
//   registered below). To add one here instead, call defineDecisionKind with:
//      id            lowercase snake_case, unique ('household_move').
//      criteria      fixed option keys -> short plain-language labels. A
//                    question may narrow them with `allowed`, never add any.
//      context       per-question fields, built with the `field` helpers:
//                      field.int(min, max)        whole number in range
//                      field.number(min, max)     finite number in range
//                      field.oneOf([...values])   one of fixed strings
//                      field.text(maxLength)      short label, safe charset
//                      field.tags([...values], n) up to n distinct values
//                    Last argument {optional: true} makes a field optional.
//                    Unknown or missing fields are rejected, so the client
//                    can never smuggle free-form text.
//      state         schema for the shared snapshot, same helpers (optional;
//                    `stateSchema` is accepted as an alias). Tag arrays are
//                    sorted on validation so equal sets give equal states.
//                    Share it wherever it makes sense: coarse bands make
//                    identical states (and cache hits) likely. Exact values
//                    are fine when the decision needs them.
//      share         'town' | 'district' | 'slice' | 'proposal' | 'individual'
//                    how questions are grouped (metadata for schedulers).
//      slices        slice dimensions for population kinds; weights per
//                    dimension; combine 'mean' (default) or 'min'.
//      instructions  (context, offered, state) -> short plain English. Say who
//                    decides and what is specific to them; the council (the
//                    player) always keeps its decisions.
//      minConfidence optional, default 0.45: winner-only answers (no
//                    probabilities map) below this are discarded.
//
// Example:
//   defineDecisionKind({
//     id: 'festival_vote',
//     criteria: {attend: 'Go to the festival.', stay_home: 'Stay home.'},
//     context: {mood: field.int(0, 3)},
//     state: {season: field.oneOf(['spring', 'summer', 'autumn', 'winter'])},
//     share: 'town',
//     instructions: (c) => `Residents in mood ${c.mood} of 3 decide whether to attend the festival.`,
//   });
import {KINDS as SIM_KINDS, SNAPSHOTS} from './sim/decisions/kinds.js';

const KIND_ID = /^[a-z][a-z0-9_]{1,39}$/;
const OPTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const QUESTION_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
// Letters, digits, spaces and a little punctuation: no quotes, braces,
// newlines or angle brackets can reach the model instructions.
const SAFE_TEXT = /^[A-Za-z0-9 _,.\/-]*$/;
const QUESTION_KEYS = new Set(['kind', 'id', 'context', 'allowed']);
const SHARES = ['town', 'district', 'slice', 'proposal', 'individual'];

export const MAX_QUESTIONS_PER_REQUEST = 64; // the service batches up to 64 questions per request
export const MAX_GROUPS_PER_REQUEST = 64;
export const MAX_STATE_BYTES = 24 * 1024;
export const DEFAULT_MIN_CONFIDENCE = 0.45;

const kinds = new Map();

export const field = {
  int: (min, max, opts = {}) => ({type: 'int', min, max, optional: !!opts.optional}),
  number: (min, max, opts = {}) => ({type: 'number', min, max, optional: !!opts.optional}),
  oneOf: (values, opts = {}) => ({type: 'enum', values: [...values], optional: !!opts.optional}),
  text: (maxLength, opts = {}) => ({type: 'text', maxLength, optional: !!opts.optional}),
  tags: (values, maxItems = values.length, opts = {}) => ({type: 'tags', values: [...values], maxItems, optional: !!opts.optional}),
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

function checkSchema(owner, schemas) {
  for (const [name, schema] of Object.entries(schemas ?? {})) {
    if (!['int', 'number', 'enum', 'text', 'tags'].includes(schema?.type)) {
      throw new Error(`Decision kind ${owner}: field ${name} has no valid schema`);
    }
  }
}

export function defineDecisionKind(spec) {
  if (!spec || !KIND_ID.test(spec.id)) throw new Error('Decision kind needs a snake_case id');
  if (kinds.has(spec.id)) throw new Error(`Decision kind ${spec.id} already defined`);
  const options = Object.keys(spec.criteria ?? {});
  if (options.length < 2 || options.length > 16 || !options.every((k) => OPTION_KEY.test(k)) ||
      !options.every((k) => typeof spec.criteria[k] === 'string' && spec.criteria[k].length <= 240)) {
    throw new Error(`Decision kind ${spec.id} needs 2-16 criteria with short labels`);
  }
  if (typeof spec.instructions !== 'function') throw new Error(`Decision kind ${spec.id} needs instructions()`);
  if (spec.share !== undefined && !SHARES.includes(spec.share)) throw new Error(`Decision kind ${spec.id}: unknown share`);
  checkSchema(spec.id, spec.context);
  const stateSchema = spec.state ?? spec.stateSchema;
  checkSchema(spec.id, stateSchema);
  const kind = Object.freeze({
    id: spec.id,
    criteria: Object.freeze({...spec.criteria}),
    options: Object.freeze(options),
    context: Object.freeze({...(spec.context ?? {})}),
    state: Object.freeze({...(stateSchema ?? {})}),
    share: spec.share ?? 'individual',
    slices: Object.freeze([...(spec.slices ?? [])]),
    weights: Object.freeze({...(spec.weights ?? {})}),
    combine: spec.combine === 'min' ? 'min' : 'mean',
    highStakes: !!spec.highStakes,
    cadence: spec.cadence ?? 0,
    instructions: spec.instructions,
    minConfidence: spec.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  });
  kinds.set(kind.id, kind);
  return kind;
}

export const getDecisionKind = (id) => kinds.get(id) ?? null;
export const decisionKindIds = () => [...kinds.keys()];

function checkValue(schema, value) {
  switch (schema.type) {
    case 'int': return Number.isSafeInteger(value) && value >= schema.min && value <= schema.max;
    case 'number': return Number.isFinite(value) && value >= schema.min && value <= schema.max;
    case 'enum': return typeof value === 'string' && schema.values.includes(value);
    case 'text': return typeof value === 'string' && value.length <= schema.maxLength && SAFE_TEXT.test(value);
    case 'tags': return Array.isArray(value) && value.length <= schema.maxItems && new Set(value).size === value.length &&
      value.every((v) => schema.values.includes(v));
    default: return false;
  }
}

// Validate `values` against a field-schema map; returns a clean copy or throws.
export function checkFields(schemas, values, what = 'context') {
  if (values === undefined) values = {};
  if (!isPlainObject(values)) throw new Error(`Invalid ${what}`);
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown ${what} field ${name}`);
  }
  const clean = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const value = values[name];
    if (value === undefined) {
      if (!schema.optional) throw new Error(`Missing ${what} field ${name}`);
      continue;
    }
    if (!checkValue(schema, value)) throw new Error(`Invalid ${what} field ${name}`);
    clean[name] = schema.type === 'tags' ? [...value].sort() : value;
  }
  return clean;
}

function checkAllowed(kind, allowed) {
  if (allowed === undefined || allowed === null) return null;
  if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > kind.options.length ||
      new Set(allowed).size !== allowed.length || allowed.some((a) => !kind.options.includes(a))) {
    throw new Error('Invalid allowed options');
  }
  // Keep the kind's declared order so equivalent questions render identically.
  return kind.options.filter((a) => allowed.includes(a));
}

// Returns a normalized copy {kind, id, context, allowed} or throws.
export function validateQuestion(question) {
  if (!isPlainObject(question) || Object.keys(question).some((k) => !QUESTION_KEYS.has(k))) {
    throw new Error('Invalid question');
  }
  const kind = kinds.get(question.kind);
  if (!kind) throw new Error('Unknown decision kind');
  let id = question.id;
  if (Number.isSafeInteger(id) && id >= 0) id = String(id);
  if (typeof id !== 'string' || !QUESTION_ID.test(id)) throw new Error('Invalid question id');
  return {kind: kind.id, id, context: checkFields(kind.context, question.context), allowed: checkAllowed(kind, question.allowed)};
}

// A kind's shared state: validated against its schema; {} when it has none.
export function validateState(kindId, state) {
  const kind = kinds.get(kindId);
  if (!kind) throw new Error('Unknown decision kind');
  const clean = checkFields(kind.state, state ?? {}, 'state');
  if (JSON.stringify(clean).length > MAX_STATE_BYTES) throw new Error('State too large');
  return clean;
}

// Canonical JSON (sorted keys, recursively): equal states give equal keys.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Short stable id for a state, for grouping and diagnostics.
export function stateKey(state) {
  const text = canonicalJson(state ?? {});
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b, 33) ^ c) >>> 0;
  }
  return `s${a.toString(36)}${b.toString(36)}${text.length.toString(36)}`;
}

export const offeredOptions = (question) => question.allowed ?? getDecisionKind(question.kind).options;

// The verified upstream shape for one question: {instructions, criteria}.
export function renderQuestion(question, state = {}) {
  const kind = getDecisionKind(question.kind);
  const offered = offeredOptions(question);
  return {
    instructions: String(kind.instructions(question.context, offered, state)),
    criteria: Object.fromEntries(offered.map((k) => [k, kind.criteria[k]])),
  };
}

// Probabilities must cover only offered options, each in [0, 1], summing to
// ~1. Missing offered options become 0. Anything else is rejected outright.
export function normalizeOptionProbabilities(value, offered) {
  if (!isPlainObject(value) || Object.keys(value).some((k) => !offered.includes(k))) return null;
  let sum = 0;
  const result = {};
  for (const option of offered) {
    const p = value[option] ?? 0;
    if (!Number.isFinite(p) || p < 0 || p > 1) return null;
    result[option] = p;
    sum += p;
  }
  if (sum <= 0 || Math.abs(sum - 1) > 0.05) return null;
  for (const option of offered) result[option] /= sum;
  return result;
}

// Upstream {type, choice, confidence, probabilities?} -> normalized answer or null.
export function normalizeAnswer(question, raw) {
  const kind = getDecisionKind(question.kind);
  if (!kind || !isPlainObject(raw) || raw.type !== 'choice') return null;
  const offered = offeredOptions(question);
  if (!offered.includes(raw.choice)) return null;
  if (raw.probabilities !== undefined) {
    const probabilities = normalizeOptionProbabilities(raw.probabilities, offered);
    if (!probabilities || !(probabilities[raw.choice] > 0)) return null;
    return {kind: kind.id, choice: raw.choice, confidence: probabilities[raw.choice], probabilities};
  }
  if (!Number.isFinite(raw.confidence) || raw.confidence < kind.minConfidence || raw.confidence > 1) return null;
  return {kind: kind.id, choice: raw.choice, confidence: raw.confidence};
}

// ---------------------------------------------------------------------------
// Registered kinds
// ---------------------------------------------------------------------------

// Everyday activity for the browser routine policy (src/routine-policy.js).
// The town snapshot is the shared state; each question describes one slice
// of residents (or an intersection of slices, or one resident) briefly.
export const ROUTINE_SLICES = ['town', 'district', 'work', 'wealth', 'energy', 'fullness', 'social', 'intersection', 'individual'];
const BANDS = ['critical', 'low', 'normal', 'high'];
export const ROUTINE = defineDecisionKind({
  id: 'routine',
  share: 'town',
  slices: ['district', 'work', 'wealth', 'energy', 'fullness', 'social'],
  // Kept short: every question repeats its criteria and instructions, and
  // throughput is bound by input tokens. The town context is in `state`.
  criteria: {work: 'Work at a farm or workshop.', rest: 'Rest at home.', shop: 'Shop at the market.', leisure: 'Relax in a garden.'},
  state: {
    phase: field.oneOf(['rest', 'work', 'shop', 'leisure']),
    food: field.oneOf(['low', 'ok', 'plenty']),
    wellbeing: field.oneOf(['poor', 'fair', 'good']),
    taxStep: field.int(0, 25),
  },
  context: {
    slice: field.oneOf(ROUTINE_SLICES),
    label: field.text(80, {optional: true}),
    group: field.int(1, 1000000, {optional: true}),
    energy: field.oneOf(BANDS, {optional: true}),
    fullness: field.oneOf(BANDS, {optional: true}),
    social: field.oneOf(BANDS, {optional: true}),
    wealth: field.number(0, 1e12, {optional: true}),
  },
  instructions: (c) => {
    const who = c.slice === 'individual' ? 'A resident' : `Residents${c.label ? ` ${c.label}` : ''}${c.group ? ` (${c.group})` : ''}`;
    const needs = ['energy', 'fullness', 'social'].filter((k) => c[k]).map((k) => `${k} ${c[k]}`).join(', ');
    return `${who}: next activity?${needs ? ` ${needs}.` : ''}${c.wealth !== undefined ? ` Savings ${Math.round(c.wealth)}.` : ''} Own choice only.`;
  },
});

// Population and actor kinds from the simulation (pure data, owned by the
// sim). Their shared state schema is the snapshot named by `share`.
for (const spec of SIM_KINDS) {
  defineDecisionKind({...spec, state: spec.state ?? spec.stateSchema ?? SNAPSHOTS[spec.share] ?? {}});
}
