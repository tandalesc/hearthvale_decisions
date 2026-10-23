// Exact existing-kind preservation check for the targeted strike extension.
// node scripts/check-strike-isolated.js BASE.json CANDIDATE.json OLD_HELDOUT.jsonl OUT.json
import {readFileSync, createReadStream, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {loadStudent} from '../src/decision-student.js';
const [basePath, candidatePath, dataPath, outPath] = process.argv.slice(2);
const base = JSON.parse(readFileSync(basePath)), candidate = JSON.parse(readFileSync(candidatePath));
assert.deepEqual(candidate.confidence, base.confidence);
let weightRows = 0;
for (const [name, old] of Object.entries(base.weights)) {
  const next = candidate.weights[name];
  assert(next, name);
  for (const type of ['i8', 'scale', 'f16', 'f32']) if (old[type]) {
    const a = Buffer.from(old[type], 'base64'), b = Buffer.from(next[type], 'base64');
    assert(a.equals(b.subarray(0, a.length)), `${name}.${type} changed an original byte`);
  }
  weightRows += old.shape[0] ?? 1;
}
for (const key of ['scopes', 'attrs', 'values', 'kind_options', 'options']) {
  for (const [token, id] of Object.entries(base.vocab[key])) assert.equal(candidate.vocab[key][token], id, `${key}:${token}`);
}
// General shared words and bare option lookups retain the original UNK mapping.
assert.deepEqual(candidate.vocab.options, base.vocab.options);
assert.deepEqual(Object.keys(candidate.vocab.values).filter(k => !(k in base.vocab.values)), ['strike_resolve']);
const before = loadStudent(base), after = loadStudent(candidate);
const kinds = {}, contexts = new Set();
let rows = 0, maxProbabilityDifference = 0, maxExpectedKLDifference = 0;
for await (const line of createInterface({input: createReadStream(dataPath), crlfDelay: Infinity})) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (!before.kinds.has(r.kind)) continue;
  const a = before.fromTriples(r.kind, r.triples, r.options), b = after.fromTriples(r.kind, r.triples, r.options);
  for (let i = 0; i < a.length; i++) maxProbabilityDifference = Math.max(maxProbabilityDifference, Math.abs(a[i] - b[i]));
  maxExpectedKLDifference = Math.max(maxExpectedKLDifference, Math.abs(before.expectedFromTriples(r.kind, r.triples, r.options) - after.expectedFromTriples(r.kind, r.triples, r.options)));
  kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  contexts.add(JSON.stringify([r.kind, r.triples.filter(t => t[0] === 'q'), r.options]));
  rows++;
}
assert.equal(maxProbabilityDifference, 0);
assert.equal(maxExpectedKLDifference, 0);
const report = {pass: true, rows, kinds, distinctQuestionContexts: contexts.size, originalWeightRowsChecked: weightRows, originalSerializedWeightsExact: true, confidenceExact: true, sharedWordAndBareOptionMappingExact: true, maxProbabilityDifference, maxExpectedKLDifference};
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
