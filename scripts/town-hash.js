// Determinism check for simulation speed-ups (docs/design/data-locality.md §4):
// grows one headless town as scripts/distill-collect.js --answer student --player
// does, but records nothing, and prints the serialize() hash every ten game years.
// A change that keeps towns bit-identical prints the same lines before and after.
//
//   node scripts/town-hash.js [--seed 66] [--years 150] [--index 0] [--student public/students/decisions.v2.json]
//
// To compare with another commit, run it in a copy of that commit:
//   git archive BASE src scripts public/students | tar -x -C /tmp/base && ln -s $PWD/node_modules /tmp/base/
//   node /tmp/base/scripts/town-hash.js --seed 66 > base.txt; node scripts/town-hash.js --seed 66 > new.txt
//   diff <(grep -v seconds base.txt) <(grep -v seconds new.txt)
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createState, stepTick, serialize} from '../src/sim/index.js';
import {simulatedPlayer} from '../src/sim/fixtures.js';
import {fallbackFor} from '../src/sim/decisions/effects.js';
import {validateQuestion, validateState} from '../src/decision-kinds.js';
import {loadStudent} from '../src/decision-student.js';
import {ARCHETYPES} from '../src/waters.js';
import {STYLES} from './council-styles.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const seed = Number(arg('seed', 66)), years = Number(arg('years', 150)), index = Number(arg('index', 0));
const studentFile = arg('student', fileURLToPath(new URL('../public/students/decisions.v2.json', import.meta.url)));
const student = loadStudent(JSON.parse(readFileSync(studentFile, 'utf8')));

// The same town distill-collect.js grows for this seed and index (salt 0).
const styleNames = Object.keys(STYLES);
const style = styleNames[index % styleNames.length];
const state = createState(seed, {archetype: ARCHETYPES[index % ARCHETYPES.length]});
const council = simulatedPlayer({...STYLES[style], seed: Math.imul(seed, 31) >>> 0});
let studentMs = 0, answers = 0;
const bus = {
  ask(kind, id, context, {allowed, state: snapshot} = {}) {
    let question, cleanState;
    try {
      question = validateQuestion({kind, id, context, ...(allowed ? {allowed} : {})});
      cleanState = validateState(question.kind, snapshot);
    } catch {
      return null;
    }
    if (student.kinds.has(kind)) {
      const t = performance.now();
      const a = student.answer(question.kind, cleanState, question.context, question.allowed);
      studentMs += performance.now() - t;
      answers++;
      return a;
    }
    const probabilities = fallbackFor(kind, context, snapshot, state, allowed ?? undefined);
    const choice = Object.keys(probabilities).reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
    return {kind, choice, confidence: probabilities[choice], probabilities};
  },
  stats: () => ({state: 'idle', room: 8}),
};

const hash = () => createHash('sha256').update(serialize(state)).digest('hex').slice(0, 16);
const t0 = performance.now();
let lastYear = state.time.year;
while (state.time.year < years) {
  stepTick(state, 1, {decisions: bus}, {skipPeople: true});
  council(state);
  await null;
  if (state.time.year !== lastYear) {
    lastYear = state.time.year;
    if (lastYear % 10 === 0) console.log(`year ${lastYear} pop ${state.indicators.pop} hash ${hash()}`);
  }
}
console.log(`final pop ${state.indicators.pop} hash ${hash()} answers ${answers}`);
console.log(`seconds ${((performance.now() - t0) / 1000).toFixed(1)} student ${(studentMs / 1000).toFixed(1)}`);
