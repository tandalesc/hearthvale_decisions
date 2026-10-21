import { createWorld } from '../index.js';
import { createStandinView } from './standin.js';

// Renderer dev page: /src/render/dev/render-dev.html?fixture=town&tier=medium&yearT=0.4
// Uses sim-core's fixtures when present, else the local stand-in.
const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') ?? 'town';
const tier = params.get('tier') ?? 'auto';
const yearT = Number(params.get('yearT') ?? 0.38);
const frozen = params.has('freeze');
const hud = params.get('hud') !== '0';

async function loadView() {
  if (params.get('source') !== 'standin') {
    try {
      const [{ createRenderView }, sim] = await Promise.all([
        import('../../sim/render-view.js'),
        import('../../sim/index.js'),
      ]);
      const { stepTick } = sim;
      // ?seed=N starts a fresh town on that terrain seed (hilly / floodplain
      // comparisons); otherwise load the named fixture.
      // &arch=coast forces a valley archetype (src/waters.js); &years=N grows the town first.
      const state = params.has('seed')
        ? sim.createState(Number(params.get('seed')), params.has('arch') ? { archetype: params.get('arch') } : {})
        : sim.loadFixture ? await sim.loadFixture(fixture) : sim.fixtureState(fixture);
      if (params.has('seed') && Number(params.get('years')) > 0) sim.fastForward(state, Number(params.get('years')));
      const view = createRenderView(state, { rowFloats: 20 });
      window.__state = state;
      const speed = Number(params.get('speed') ?? 1);
      let t0 = null;
      return {
        view,
        source: 'sim',
        sync(t, dt) {
          if (t0 === null) t0 = t;
          if (speed > 0) stepTick(state, dt * speed);
          view.sync(state, { now: t, speed });
          // Pin the season for screenshots: yearT param, advancing unless frozen.
          if (params.has('yearT')) view.time.yearT = (yearT + (frozen ? 0 : (t - t0) / 60)) % 1;
          // Pin the weather for screenshots: &weather=rain|snow|clear.
          if (params.has('weather')) {
            const w = params.get('weather');
            view.weather = { ...(view.weather ?? {}), rain: w === 'rain' ? 0.8 : 0, snow: w === 'snow' ? 0.8 : 0, wind: view.weather?.wind ?? [0.6, 0.3] };
          }
        },
      };
    } catch (err) {
      console.info('sim fixtures unavailable, using the stand-in:', err.message);
    }
  }
  const view = createStandinView(fixture, { yearT, yearSpeed: frozen ? 0 : 1 / 60 });
  return { view, sync: (t) => view.sync(t), source: 'standin' };
}

const { view, sync, source } = await loadView();
// &micro=0|1 forces micro-detail off or on over the tier's default (A/B shots).
const tierPatch = params.has('micro') ? { microDetail: params.get('micro') === '1' } : null;
const world = createWorld(document.querySelector('#world'), { quality: tier, tierPatch });
world.setDayCycle(params.get('cycle') ?? 'seasonal');
world.setSimSpeed(Number(params.get('speed') ?? 1));
if (params.has('overlay')) world.setOverlay(params.get('overlay'));
if (params.has('peopleShadows')) world.setPeopleShadows(params.get('peopleShadows'));
// Explicit camera: applied after the world's own first framing.
const camAt = params.has('cx') ? [Number(params.get('cx')), Number(params.get('cz') ?? 0), params.has('dist') ? Number(params.get('dist')) : null] : null;
world.onPick((p) => console.log('pick', JSON.stringify(p)));

let last = performance.now();
let frames = 0;
window.__world = world;
window.__view = view;
window.__frames = () => frames;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  sync(now / 1000, dt);
  world.update(view, now / 1000, dt);
  if (camAt && frames === 0) world.camera.home(...camAt);
  // Optional low camera: &elev=12 (degrees above the horizon).
  if (frames === 1 && params.has('elev')) {
    const rig = world.camera;
    const t = rig.controls.target;
    const cam = rig.camera.position;
    const d = cam.distanceTo(t);
    const el = (Number(params.get('elev')) * Math.PI) / 180;
    // &az=deg turns the camera round the target (0: looking toward -z).
    const az = params.has('az') ? (Number(params.get('az')) * Math.PI) / 180 : Math.atan2(cam.x - t.x, cam.z - t.z);
    cam.set(t.x + Math.sin(az) * Math.cos(el) * d, t.y + Math.sin(el) * d, t.z + Math.cos(az) * Math.cos(el) * d);
    rig.controls.update();
    world.requestFrame();
  }
  frames++;
  if (hud && frames % 15 === 0) {
    const s = world.stats();
    document.querySelector('#hud').textContent =
      `${fixture} (${source}) · ${s.tier}\n${s.fps} fps · ${s.frameMs} ms js\n${s.drawCalls} calls · ${(s.triangles / 1000).toFixed(0)}k tris\n${s.buildings} lots · ${s.instances} pieces · ${s.people} people\nyearT ${view.time.yearT.toFixed(3)}`;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
