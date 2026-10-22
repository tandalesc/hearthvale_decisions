// Runs the decision-student loop again and again, so a new version can follow
// whenever enough new questions have been labelled, not once a night.
//
//   node scripts/distill-loop-watch.js [--every 60] -- [distill-loop.js arguments, e.g. --publish]
//
// Every --every minutes it runs scripts/distill-loop.js and waits for it to end;
// a run never overlaps the last. A run with fewer than `minRows` new labelled
// questions stops after the input gates and the labelling step, so a quiet
// interval costs one read of the log. The proxy labels flagged questions as
// they arrive, so most of a cycle's labels are already there when it starts.
import {spawn} from 'node:child_process';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const split = args.indexOf('--');
const own = split >= 0 ? args.slice(0, split) : args, pass = split >= 0 ? args.slice(split + 1) : [];
const every = Number(own.includes('--every') ? own[own.indexOf('--every') + 1] : 60);
if (!(every > 0)) throw new Error('--every takes minutes, above 0');

const once = () => new Promise((ok) => {
  const child = spawn(process.execPath, [resolve(ROOT, 'scripts/distill-loop.js'), ...pass], {cwd: ROOT, stdio: 'inherit'});
  child.on('close', (code) => ok(code));
});
for (;;) {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] loop run`);
  const code = await once();
  if (code !== 0) console.log(`[${new Date().toISOString()}] the run exited ${code}; trying again next interval`);
  const wait = every * 60_000 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
