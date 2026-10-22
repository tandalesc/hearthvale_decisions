// Check a student bundle's JS forward pass against the trainer's own answers,
// and time it.
//
//   node scripts/distill-check-student.js public/students/decisions.v1.json
//
// The bundle's fixture holds rows with the probabilities PyTorch gave them;
// this prints the largest difference (it should be well under 1e-4).
import {readFileSync} from 'node:fs';
import {loadStudent} from '../src/decision-student.js';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/distill-check-student.js BUNDLE.json');
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const student = loadStudent(bundle);
let worst = 0, worstConf = 0;
for (const row of student.fixture) {
  const p = student.fromTriples(row.kind, row.triples, row.options);
  for (let i = 0; i < p.length; i++) worst = Math.max(worst, Math.abs(p[i] - row.probabilities[i]));
  if (student.hasConfidence && row.expected_kl != null) {
    const e = student.expectedFromTriples(row.kind, row.triples, row.options);
    worstConf = Math.max(worstConf, Math.abs(e - row.expected_kl) / Math.max(1e-3, row.expected_kl));
  }
}
if (student.hasConfidence) console.log(`confidence head: largest relative difference in expected KL ${worstConf.toExponential(2)}`);
// Time it uncached, and with each row's snapshot memory cached as in play.
const stateOf = (row) => JSON.stringify(row.triples.filter((t) => bundle.vocab.state_scopes.includes(t[0])));
const time = (cached) => {
  const reps = Math.max(1, Math.ceil(2000 / Math.max(1, student.fixture.length)));
  for (const row of student.fixture) student.fromTriples(row.kind, row.triples, row.options, cached ? stateOf(row) : null);
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) for (const row of student.fixture) student.fromTriples(row.kind, row.triples, row.options, cached ? stateOf(row) : null);
  return ((performance.now() - t0) / (reps * student.fixture.length)) * 1000;
};
console.log(`${file}: ${bundle.config.arch}, ${student.fixture.length} fixture rows, largest difference ${worst.toExponential(2)}; ` +
  `${time(false).toFixed(0)} µs a question uncached, ${time(true).toFixed(0)} µs with its state cached (${student.kinds.size} kinds)`);
process.exitCode = worst < 1e-4 && worstConf < 1e-3 ? 0 : 1;
