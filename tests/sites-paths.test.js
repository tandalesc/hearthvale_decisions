// Building sites and the paths people walk: a lot may not cut one of the
// town's own busy paths, whatever its tier (a hamlet's dirt path counts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState} from '../src/sim/index.js';
import {proposeSites, busyRef} from '../src/sim/sites.js';
import {cellOf, cellXZ, cellIndex} from '../src/sim/roads.js';

// A worn, untiered path through the hamlet's best ground: the cells the first
// home proposal would take, plus a run either side so it is a real path.
function layPath(s) {
  const first = proposeSites(s, {type: 'home', count: 1})[0];
  assert.ok(first, 'the hamlet has somewhere to build');
  const r = s.roads;
  const cells = [];
  const [cx, cz] = cellXZ(cellOf(first.x, first.z));
  const across = first.w >= first.h;   // run the path across the lot's long side
  for (let k = -12; k <= 12; k++) {
    const j = across ? cellIndex(cx, cz + k) : cellIndex(cx + k, cz);
    if (j < 0 || r.tier[j]) continue;
    r.wear[j] = Math.max(r.wear[j], 2500);
    cells.push(j);
  }
  r.version++;
  return new Set(cells);
}

function covers(site, cells) {
  for (let z = site.cz; z < site.cz + site.h; z++)
    for (let x = site.cx; x < site.cx + site.w; x++) if (cells.has(cellIndex(x, z))) return true;
  return false;
}

test("a hamlet's busy dirt path is not built over", () => {
  const s = fixtureState('hamlet');
  const path = layPath(s);
  assert.ok(path.size >= 10);
  assert.ok(busyRef(s) >= 120);
  const sites = proposeSites(s, {type: 'home', count: 4});
  assert.ok(sites.length > 0);
  for (const site of sites) assert.ok(!covers(site, path), `home lot at (${site.cx}, ${site.cz}) cuts the path`);
});

test('fields may still cross a busy path (open ground)', () => {
  const s = fixtureState('hamlet');
  layPath(s);
  // No assertion on placement: only that farms are still proposed at all.
  assert.ok(proposeSites(s, {type: 'farm', count: 2}).length > 0);
});
