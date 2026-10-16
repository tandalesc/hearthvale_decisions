import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameInterval, pace, powerState, effectiveTier, pixelRatioFor, createRefreshMeter,
  SAVER_FPS, SAVER_PIXEL_RATIO, INTERACT_GRACE,
} from '../src/render/pacing.js';
import { TIERS } from '../src/render/quality.js';

// Drive the pacing rule over animation frames at `hz` with timestamp jitter
// and return the gaps between drawn frames, in refreshes.
function drawnGaps(hz, opts, { frames = 600, jitterMs = 1.2, seed = 7 } = {}) {
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const period = 1 / hz;
  let last = -1, lastIndex = 0;
  const gaps = [];
  for (let i = 0; i < frames; i++) {
    const time = i * period + (rand() - 0.5) * jitterMs / 1000;
    const { interval } = pace({ ...opts, refreshHz: hz });
    if (last < 0 || time - last >= interval) {
      if (last >= 0) gaps.push(i - lastIndex);
      last = time; lastIndex = i;
    }
  }
  return gaps;
}

test('frame caps land on whole refreshes and stay even under timestamp jitter', () => {
  const watching = { idleFor: 5, saving: true, maxFps: 60 };
  const full = { idleFor: 5, saving: false, maxFps: 60 };
  for (const [hz, opts, every] of [[60, watching, 2], [120, watching, 4], [90, watching, 3], [60, full, 1], [120, full, 2]]) {
    const gaps = drawnGaps(hz, opts);
    assert.ok(gaps.length > 100);
    assert.ok(gaps.every((g) => g === every), `${hz} Hz ${opts.saving ? 'saving' : 'full'}: gaps ${[...new Set(gaps)]}`);
  }
  // Never faster than asked: 144 Hz with a 60 cap draws every 3rd refresh (48 fps).
  assert.ok(drawnGaps(144, full).every((g) => g === 3));
  // A browser that already throttles to 30 Hz (iOS Low Power Mode) draws every frame.
  assert.ok(drawnGaps(30, watching).every((g) => g === 1));
  // Unknown refresh rate: the plain interval less 2 ms.
  assert.ok(Math.abs(frameInterval(30, 0) - (1 / 30 - 0.002)) < 1e-9);
});

test('pacing: input draws now, the saver eases off only after the grace period', () => {
  assert.deepEqual(pace({ forced: true, saving: true, idleFor: 60, paused: true }), { interval: 0, paced: false });
  // Paused and idle: once a second, saver or not.
  assert.ok(Math.abs(pace({ paused: true, idleFor: 3, refreshHz: 60 }).interval - (1 - 0.5 / 60)) < 1e-9);
  assert.equal(pace({ paused: true, idleFor: 3 }).paced, true);
  // Watching with the saver: 30 Hz, paced (the tuner ignores those frames).
  const watching = pace({ saving: true, idleFor: INTERACT_GRACE + 0.1, maxFps: 60, refreshHz: 120 });
  assert.equal(watching.paced, true);
  assert.equal(watching.interval, frameInterval(SAVER_FPS, 120));
  // Just after input the saver keeps the full rate.
  const touched = pace({ saving: true, idleFor: INTERACT_GRACE - 0.1, maxFps: 60, refreshHz: 120 });
  assert.equal(touched.paced, false);
  assert.equal(touched.interval, frameInterval(60, 120));
  // No saver: full rate however long the player has been watching.
  assert.equal(pace({ idleFor: 600, maxFps: 60, refreshHz: 60 }).paced, false);
});

test('power state: Off, On battery and Always, with the low-battery rule underneath', () => {
  const plugged = { charging: true, level: 0.5 };
  const unplugged = { charging: false, level: 0.5 };
  const low = { charging: false, level: 0.1 };
  assert.equal(powerState('off', unplugged).saving, false);
  assert.equal(powerState('battery', plugged).saving, false);
  assert.equal(powerState('battery', unplugged).saving, true);
  assert.equal(powerState('always', plugged).saving, true);
  // No Battery API (Safari, Firefox): On battery never engages; Always still does.
  assert.deepEqual(powerState('battery', null), { saving: false, chosen: false, lowBattery: false, unplugged: false, batteryKnown: false });
  assert.equal(powerState('always', null).saving, true);
  // Unplugged below 20 % saves even with the setting Off; charging does not.
  assert.equal(powerState('off', low).saving, true);
  assert.equal(powerState('off', low).lowBattery, true);
  assert.equal(powerState('off', { charging: true, level: 0.1 }).saving, false);
});

test('saving steps Auto detail down one tier, keeps a manual choice and caps the pixel ratio', () => {
  const saving = powerState('always', null);
  const normal = powerState('off', null);
  const low = powerState('off', { charging: false, level: 0.05 });
  assert.equal(effectiveTier('auto', 'high', saving), 'medium');
  assert.equal(effectiveTier('auto', 'medium', saving), 'low');
  assert.equal(effectiveTier('auto', 'low', saving), 'low');
  assert.equal(effectiveTier('auto', 'high', normal), 'high');
  assert.equal(effectiveTier('auto', 'high', low), 'low');
  assert.equal(effectiveTier('high', 'high', saving), 'high');
  assert.equal(effectiveTier('high', 'high', low), 'high');
  // A phone at 3x on Medium: 1.75 normally, 1.25 while saving (half the pixels).
  assert.equal(pixelRatioFor(3, TIERS.medium, normal), 1.75);
  assert.equal(pixelRatioFor(3, TIERS.medium, saving), SAVER_PIXEL_RATIO);
  assert.equal(pixelRatioFor(3, TIERS.high, saving), SAVER_PIXEL_RATIO);
  assert.equal(pixelRatioFor(1, TIERS.high, saving), 1);
  assert.equal(pixelRatioFor(undefined, TIERS.low, normal), 1);
});

test('refresh meter finds the display rate from frame deltas, ignoring dropped frames', () => {
  const meter = createRefreshMeter();
  assert.equal(meter.hz(), 0);
  for (let i = 0; i < 29; i++) meter.sample(8.33);
  assert.equal(meter.hz(), 0); // not enough samples yet
  for (let i = 0; i < 60; i++) meter.sample(i % 10 === 0 ? 16.7 : 8.2 + (i % 3) * 0.1);
  assert.equal(meter.hz(), 120);
  meter.reset();
  for (let i = 0; i < 90; i++) meter.sample(16.4 + (i % 5) * 0.12);
  assert.equal(meter.hz(), 60);
  meter.reset();
  for (let i = 0; i < 90; i++) meter.sample(33.3);
  assert.equal(meter.hz(), 30);
  // Hidden-tab gaps and nonsense are ignored.
  meter.sample(5000); meter.sample(0); meter.sample(NaN);
  assert.equal(meter.hz(), 30);
});
