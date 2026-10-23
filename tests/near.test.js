// The grid searches behind nearestOf and assignBuilders give a full scan's answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pointGrid, ringSearch} from '../src/sim/near.js';
import {fixtureState, stepTick} from '../src/sim/index.js';
import {assignBuilders, setNearScan} from '../src/sim/people.js';
import {serialize} from '../src/sim/serialize.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {projectSite} from '../src/sim/buildings.js';

let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test('a ring search finds the nearest point (the first on a tie) as a scan does', () => {
  for (const cell of [5, 24, 100]) {
    const n = 400;
    // Clustered, with repeats (ties) and a few far out.
    const xs = new Float64Array(n), zs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i % 9 === 0 && i) { xs[i] = xs[i - 3]; zs[i] = zs[i - 3]; continue; }
      const far = i % 50 === 0;
      xs[i] = (rand() - 0.5) * (far ? 700 : 120) + 20;
      zs[i] = (rand() - 0.5) * (far ? 700 : 90) - 10;
    }
    const grid = pointGrid(xs, zs, n, cell);
    for (let q = 0; q < 300; q++) {
      const x = (rand() - 0.5) * 800, z = (rand() - 0.5) * 800;
      const at = q % 5 === 0 ? Math.floor(rand() * n) : -1;
      const qx = at >= 0 ? xs[at] : x, qz = at >= 0 ? zs[at] : z;
      let want = -1, wantD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (xs[i] - qx) ** 2 + (zs[i] - qz) ** 2;
        if (d < wantD) { wantD = d; want = i; }
      }
      let got = -1, gotD = Infinity, seen = 0;
      ringSearch(grid, qx, qz, (i) => {
        seen++;
        const d = (xs[i] - qx) ** 2 + (zs[i] - qz) ** 2;
        if (d < gotD || (d === gotD && i < got)) { gotD = d; got = i; }
      }, (b2) => got >= 0 && gotD < b2);
      assert.equal(got, want, `cell ${cell}, query ${q}`);
      if (cell === 24 && at >= 0) assert.ok(seen < n, 'a search near the points stops early');
    }
  }
});

test('builders are chosen exactly as by the scan, in a city with many to choose from', () => {
  // The scan as it was (people.js before the grid), run on a copy of the same town.
  const scan = (state) => {
    const open = state.projects.filter((p) => (p.progress ?? 0) < 1);
    if (!open.length) return;
    const assigned = new Set();
    const alive = new Set(state.people.map((p) => p.id));
    for (const pr of open) {
      pr.workers = (pr.workers ?? []).filter((id) => alive.has(id) && !assigned.has(id));
      for (const id of pr.workers) assigned.add(id);
    }
    const households = new Map(state.households.map((h) => [h.id, h]));
    const candidates = state.people.filter((p) => {
      if (assigned.has(p.id)) return false;
      const h = households.get(p.householdId);
      return h && (h.trade === 'craft' || h.trade === 'labour' || h.trade === 'none');
    });
    for (const pr of open) {
      const site = sites.get(pr.id);
      if (!site || !Number.isFinite(site.x)) continue;
      const want = Math.min(6, 2 + Math.floor((pr.workRequired ?? 30) / 40));
      while (pr.workers.length < want && candidates.length) {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const d = (c.x - site.x) ** 2 + (c.z - site.z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        const [p] = candidates.splice(best, 1);
        pr.workers.push(p.id);
      }
    }
  };
  const s = fixtureState('city');
  for (let i = 0; i < 40; i++) stepTick(s, 0.1);
  // Every project open and short of hands, some sites shared (ties between walkers on
  // the same spot are broken by list order).
  const projects = s.buildings.filter((b) => b.type === 'home').slice(0, 30).map((b, i) => ({id: 9000 + i, kind: 'build', buildingId: b.id, progress: 0, workRequired: 200, workers: []}));
  for (const p of s.people.slice(0, 40)) { p.x = s.people[40].x; p.z = s.people[40].z; }
  s.projects = projects;
  const sites = new Map(s.projects.map((pr) => [pr.id, {...projectSite(s, pr)}]));
  const copy = structuredClone({projects: s.projects, people: s.people, households: s.households, buildings: s.buildings});
  assignBuilders(s);
  scan(copy);
  assert.deepEqual(s.projects.map((p) => p.workers), copy.projects.map((p) => p.workers));
  assert.ok(s.projects.every((p) => p.workers.length === 6));
});

test('a town run with every nearest-of search on the grid is the town run with scans', () => {
  const run = (scan) => {
    setNearScan(scan);
    try {
      const s = fixtureState('town');
      const routes = createRoutePlanner({worker: false, clock: () => 0});
      for (let i = 0; i < 900; i++) {
        routes.tick(s, 1e9);
        stepTick(s, 0.1, {routes});
      }
      return serialize(s);
    } finally {
      setNearScan(48);
    }
  };
  assert.ok(run(0) === run(Infinity), 'the same town');
});
