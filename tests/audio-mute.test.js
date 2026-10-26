import test from 'node:test';
import assert from 'node:assert/strict';

// A browser just big enough for src/audio: a fake AudioContext that records
// resume/suspend, window gesture listeners, document visibility and iOS's
// navigator.audioSession.
const calls = [];
let contexts = 0;
const anything = () => new Proxy(function () {}, {
  get(t, k) {
    if (k === 'connect') return (n) => n;
    if (k === 'then') return undefined;
    if (!(k in t)) t[k] = anything();
    return t[k];
  },
  apply: () => anything(),
  set(t, k, v) { t[k] = v; return true; },
});
class FakeAudioContext {
  constructor() {
    contexts++; this.state = 'suspended'; this.sampleRate = 3000; this.currentTime = 0; this.destination = anything();
    // Any other node the graph asks for.
    return new Proxy(this, {get: (t, k) => (k in t ? t[k] : String(k).startsWith('create') ? () => anything() : undefined)});
  }
  resume() { this.state = 'running'; calls.push('resume'); return Promise.resolve(); }
  suspend() { this.state = 'suspended'; calls.push('suspend'); return Promise.resolve(); }
  addEventListener() {}
  createBuffer(_c, length) { return {getChannelData: () => new Float32Array(length)}; }
}
const gestures = new Map();
const visibility = [];
globalThis.AudioContext = FakeAudioContext;
globalThis.addEventListener = (name, fn) => gestures.set(name, fn);
globalThis.removeEventListener = (name) => gestures.delete(name);
globalThis.document = {hidden: false, addEventListener: (name, fn) => { if (name === 'visibilitychange') visibility.push(fn); }};
Object.defineProperty(globalThis, 'navigator', {value: {userAgent: 'test', platform: 'test', maxTouchPoints: 0, audioSession: {type: 'auto'}}, configurable: true});

function prefsWith(values) {
  const listeners = new Set();
  return {
    get: (k) => values[k],
    set(k, v) { values[k] = v; for (const fn of listeners) fn(k, v); },
    onChange(fn) { listeners.add(fn); },
  };
}
const tap = () => gestures.get('pointerdown')?.();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('with sound off, nothing starts audio; turning it off again stops the context', async () => {
  const {createAudio} = await import('../src/audio/index.js');
  const prefs = prefsWith({muted: true, master: 0.6, ambience: 0.6, ui: 0.7});
  createAudio(prefs);

  tap();
  assert.equal(contexts, 0, 'a tap while muted makes no AudioContext');

  prefs.set('muted', false);   // the sound switch, inside its click
  assert.equal(contexts, 1);
  assert.ok(calls.includes('resume'), 'turning sound on starts it');
  assert.equal(navigator.audioSession.type, 'playback');

  calls.length = 0;
  prefs.set('muted', true);
  await wait(450);
  assert.deepEqual(calls, ['suspend'], 'sound off suspends the context after the fade');
  assert.equal(navigator.audioSession.type, 'ambient', 'and gives the audio focus back');

  calls.length = 0;
  document.hidden = false;
  for (const fn of visibility) fn();
  assert.deepEqual(calls, [], 'coming back to the tab while muted does not resume');

  prefs.set('muted', false);
  assert.deepEqual(calls, ['resume']);
  assert.equal(navigator.audioSession.type, 'playback');

  calls.length = 0;
  prefs.set('muted', true);
  prefs.set('muted', false);   // a quick off-and-on never suspends
  await wait(450);
  assert.ok(!calls.includes('suspend'));
});
