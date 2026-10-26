// Narration fact sheets as triples, for a small model that writes the
// narrator's prose in place of the hosted one.
//
// Pure module, shared by the collection scripts (Node), the trainer's export
// and, later, the game: the single source of truth for what the model sees, as
// src/decision-features.js is for the decision students.
//
//   narrationTriples(facts, {drop}) -> [[scope, attribute, value, num, type], ...]
//
// The sheet is walked against its schema (src/narrative-schema.js for people,
// households, buildings and bodies; src/narrative-prose.js for cards, years
// and the end page), so a new fact needs no code here:
//   scope      the sheet's type ('card', 'year', 'end') or entity kind
//              ('person', ...) at the top; a nested object's field name
//              ('asker', 'now'); a list item's field and key or index
//              ('options:x_do', 'stances:0'), joined with '/' when nested.
//   type       'enum'  a fixed value (enums, flags, option keys); value as is
//              'num'   a number; value is its digits (so prose can copy it),
//                      num is sign·ln(1+|x|), or the offset from the sheet's year
//                      for year fields
//              'text'  free text (names, places, labels, catalogue sentences),
//                      kept with its case for the model to copy from
// Lists of plain values give one triple per item under the same attribute.
// `v` and a card's `id` are left out: they carry nothing a writer can use.
// Triples come out in schema order.
import {FACT_SCHEMA} from './narrative-schema.js';
import {CARD_FACTS_SCHEMA, YEAR_FACTS_SCHEMA, END_FACTS_SCHEMA} from './narrative-prose.js';

export const NARRATION_FEATURES_VERSION = 1;

const SCHEMAS = {card: CARD_FACTS_SCHEMA, year: YEAR_FACTS_SCHEMA, end: END_FACTS_SCHEMA};
const SKIP = new Set(['v', 'id']);   // top-level fields only
// Year fields: the model learns "last year", not a calendar, so num is the offset.
const YEAR_FIELDS = new Set(['year', 'since', 'founded', 'from', 'to']);

export const scaleNumber = (x) => (Math.abs(x) <= 1 ? x : Math.sign(x) * Math.log1p(Math.abs(x)));

export const sheetType = (facts) => facts?.type ?? facts?.kind;
export const sheetSchema = (facts) => SCHEMAS[facts?.type] ?? (facts?.kind ? FACT_SCHEMA : null);

function walk(out, spec, value, scope, name, ctx) {
  if (value === undefined || value === null) return;
  const path = `${scope}.${name}`;
  if ((scope === ctx.top && SKIP.has(name)) || ctx.drop.has(path)) return;
  switch (spec.t) {
    case 'enum':
    case 'key':
      out.push([scope, name, String(value), null, 'enum']);
      return;
    case 'bool':
      out.push([scope, name, value ? 'yes' : 'no', null, 'enum']);
      return;
    case 'int':
    case 'num': {
      const offset = YEAR_FIELDS.has(name) && spec.min < 0 && Number.isFinite(ctx.year);
      out.push([scope, name, String(value), offset ? scaleNumber(value - ctx.year) : scaleNumber(value), 'num']);
      return;
    }
    case 'str':
      if (value !== '') out.push([scope, name, value, null, 'text']);
      return;
    case 'arr':
      value.forEach((item, i) => {
        if (spec.of.t === 'obj') {
          const id = item?.key ?? item?.id ?? item?.era ?? i;
          walkObject(out, spec.of, item, `${scope === ctx.top ? '' : `${scope}/`}${name}:${id}`, ctx);
        } else walk(out, spec.of, item, scope, name, ctx);
      });
      return;
    case 'obj':
      walkObject(out, spec, value, `${scope === ctx.top ? '' : `${scope}/`}${name}`, ctx);
      return;
    default:
  }
}

function walkObject(out, spec, value, scope, ctx) {
  for (const [name, field] of Object.entries(spec.fields)) walk(out, field, value?.[name], scope, name, ctx);
}

// drop: paths to leave out, as 'scope.attribute' (the field the model is asked to write).
export function narrationTriples(facts, {drop = []} = {}) {
  const schema = sheetSchema(facts);
  if (!schema) throw new Error('Unknown fact sheet');
  const top = sheetType(facts);
  const out = [];
  walkObject(out, schema, facts, top, {top, year: facts.year, drop: new Set(drop)});
  return out;
}
