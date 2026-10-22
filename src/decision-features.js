// Decision questions as triples, for the small student models that copy the
// decision model (docs/design/decision-distillation.md).
//
// Pure module, shared by the collection scripts (Node), the trainer's export
// and the game: it is the single source of truth for what a student sees, so
// features cannot drift between Python and the browser.
//
//   decisionTriples(kind, snapshot, context) -> [[scope, attribute, value, num], ...]
//
// Everything comes from the kind's schemas (src/sim/decisions/kinds.js), so a
// new kind needs no feature code:
//   scope      'kind' for the kind itself, 'q' for the question's context, and
//              for the shared snapshot 'town' or the snapshot's own name
//              ('district', 'proposal', 'body') for the fields it adds.
//   enum       (scope, field, value, null)
//   int        small ranges (12 levels or fewer) as enums; others as numbers
//   number     (scope, field, '#num', x): x as is in [-1, 1], else sign·ln(1+|x|)
//   text       lists ('tithe 2,market' or 'farm many, craft some') give one
//              triple per item: (scope, field, name, level) or
//              (scope, field:name, word, null); other text is one opaque value.
//   names      district, centre and proposal names are dropped: a student
//              cannot learn anything that carries over from them.
// Missing optional fields give no triple. Triples come out in a fixed order
// (snapshot fields, then context fields, in schema order).
import {KIND_BY_ID, SNAPSHOTS} from './sim/decisions/kinds.js';

export const FEATURES_VERSION = 1;

const DROPPED = new Set(['district', 'districtName', 'centre', 'proposalId']);
const TOWN_FIELDS = new Set(Object.keys(SNAPSHOTS.town));
const SNAPSHOT_SCOPE = {town: 'town', district: 'district', slice: 'district', proposal: 'proposal', individual: 'body'};
// Prose fields: one opaque value each (they name plans, sites and options).
const PROSE = /^(summary|p\d|[a-d]|d\d|type|current|need)$/;

export const scaleNumber = (x) => (Math.abs(x) <= 1 ? x : Math.sign(x) * Math.log1p(Math.abs(x)));

function fieldTriples(out, scope, name, schema, value) {
  if (value === undefined || value === null || DROPPED.has(name)) return;
  switch (schema.type) {
    case 'enum':
      out.push([scope, name, value, null]);
      return;
    case 'int':
      if (schema.max - schema.min <= 12) out.push([scope, name, String(value), null]);
      else out.push([scope, name, '#num', scaleNumber(value)]);
      return;
    case 'number':
      out.push([scope, name, '#num', scaleNumber(value)]);
      return;
    case 'tags':
      for (const item of value) out.push([scope, name, item, null]);
      return;
    case 'text': {
      if (!value) return;
      if (PROSE.test(name)) {
        out.push([scope, name, value.trim().toLowerCase(), null]);
        return;
      }
      for (const raw of value.split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const m = /^(.*\S)\s+(-?\d+(?:\.\d+)?)$/.exec(item);
        if (m) {
          out.push([scope, name, m[1], scaleNumber(Number(m[2]))]);
          continue;
        }
        const words = item.split(/\s+/);
        if (words.length === 2) out.push([scope, `${name}:${words[0]}`, words[1], null]);
        else out.push([scope, name, item, null]);
      }
      return;
    }
    default:
  }
}

export function decisionTriples(kindId, snapshot, context) {
  const kind = KIND_BY_ID[kindId];
  if (!kind) throw new Error(`Unknown decision kind ${kindId}`);
  const out = [['kind', 'kind', kindId, null]];
  const schema = SNAPSHOTS[kind.share] ?? {};
  const own = SNAPSHOT_SCOPE[kind.share] ?? 'town';
  for (const [name, field] of Object.entries(schema)) {
    fieldTriples(out, TOWN_FIELDS.has(name) ? 'town' : own, name, field, snapshot?.[name]);
  }
  for (const [name, field] of Object.entries(kind.context)) fieldTriples(out, 'q', name, field, context?.[name]);
  return out;
}

// The options a question offers, in the kind's order.
export function decisionOptions(kindId, allowed) {
  const options = Object.keys(KIND_BY_ID[kindId].criteria);
  return allowed ? options.filter((o) => allowed.includes(o)) : options;
}
