// Leisure visitors sit on the benches decor draws (or the park lawn), one to a seat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureState, stepTick} from '../src/sim/index.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {ACTION} from '../src/sim/people.js';
import {seatsOf, benchesOf} from '../src/sim/seats.js';
import {designatePark, parkCandidates} from '../src/sim/parks.js';

test('seats sit on the drawn benches, two to a bench, and parks add lawn spots', () => {
  const s = fixtureState('town');
  for (const c of parkCandidates(s)) designatePark(s, c);
  const park = s.buildings.find((b) => b.type === 'park');
  assert.ok(park, 'a park to sit in');
  const benches = benchesOf(park), seats = seatsOf(park);
  assert.equal(seats.filter((x) => x.bench).length, benches.length * 2);
  for (const seat of seats.filter((x) => x.bench)) {
    assert.ok(benches.some((b) => Math.hypot(b.x - seat.x, b.z - seat.z) < 0.5 && b.yaw === seat.yaw), 'every bench seat is on a bench');
  }
  assert.ok(seats.some((x) => !x.bench), 'lawn spots in a park');
  assert.deepEqual(seatsOf(park), seats, 'pure');
});

test('leisure visitors take free seats inside, facing the way the seat faces', () => {
  const s = fixtureState('town');
  for (const c of parkCandidates(s)) designatePark(s, c);
  const routes = createRoutePlanner({worker: false, clock: () => 0});
  let seated = 0, onBench = 0;
  for (let t = 0; t < 900; t++) {
    routes.tick?.(s);
    stepTick(s, 0.1, {routes});
    if (t % 30) continue;
    const taken = new Set();
    for (const p of s.people) {
      const seat = p.task?.seat;
      if (!seat) continue;
      assert.ok(!taken.has(seat.key), `seat ${seat.key} taken twice`);
      taken.add(seat.key);
      if (p.task.waiting || p.task.seg < p.task.route.length) continue;
      seated++;
      assert.equal(p.heading, seat.yaw);
      if (seat.bench) { onBench++; assert.equal(p.action, ACTION.bench); }
    }
  }
  assert.ok(seated > 0 && onBench > 0, `people sat down (${seated}, ${onBench} on benches)`);
});
