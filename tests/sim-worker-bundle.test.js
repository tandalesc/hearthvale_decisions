// The production build's sim worker is one file. If anything in its graph uses import(),
// Vite splits a chunk off it, and that chunk imports the shared code back from the
// worker's own file. Safari then runs the worker file a second time in the same worker:
// the second copy (session null) takes over the messages, and no town opens ("null is
// not an object (evaluating 'sn.init')"). The dev server never bundles, so only a build
// shows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'vite';

test('the built sim worker is a single file that nothing imports back from', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'hearthvale-build-'));
  try {
    await build({logLevel: 'silent', build: {outDir, emptyOutDir: true}});
    const assets = join(outDir, 'assets');
    const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
    const worker = files.find((f) => /^sim-worker-.*\.js$/.test(f));
    assert.ok(worker, 'a sim-worker chunk is built');
    const code = readFileSync(join(assets, worker), 'utf8');
    assert.doesNotMatch(code, /\bimport\s*\(/, 'the sim worker has no dynamic import');
    assert.doesNotMatch(code, /^\s*import\s*[{*\w]/m, 'the sim worker imports no chunk');
    for (const f of files) {
      if (f === worker) continue;
      const text = readFileSync(join(assets, f), 'utf8');
      assert.ok(!new RegExp(`from\\s*["'][^"']*${worker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(text), `${f} does not import from the sim worker`);
    }
  } finally {
    rmSync(outDir, {recursive: true, force: true});
  }
});
