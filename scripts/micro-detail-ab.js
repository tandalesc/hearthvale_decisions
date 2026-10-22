// In-page A/B of the micro-detail relief and the specular term
// (docs/design/micro-detail.md): one loaded page per view, the MICRO_DETAIL
// (or, with --feature=spec, SPECULAR) define of the terrain (paving), of the
// kit materials (roofs, glass) or of both flipped between interleaved blocks
// of GPU-timed frames, so load and scene state are shared. --feature=ground
// flips only the ground's own detail (grass, soil, sand, rock relief and the
// wet-sand sheen; graphics-review P1) on the terrain, with micro-detail and
// specular left on: off is the High terrain from before it.
//
//   node scripts/micro-detail-ab.js [--feature micro|spec|ground] [--target terrain|kit|both]
//        [--tier high] [--blocks 8] [--frames 40] [--only bridge,street40]
//        [--dpr 1.25] [--out DIR] [--shots] [--views spec]
//
// Prints, per view, median GPU ms of the whole frame with the feature off and
// on, the median of the per-pair differences (on - off), and the same for the
// target drawn alone (aloneOff/On/Delta: the terrain, the buildings, or
// both). Same server and browser setup as fidelity-shots.js. --target=kit
// defaults to the roof views, --feature=spec to the spec views (rain and low
// sun) and target both, --feature=ground to the ground views. --shots also saves an off | on screenshot per view
// (DIR/<name>-ab.jpg, needs ffmpeg); --blocks=0 skips the timing.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const tier = args.tier ?? 'high';
const dpr = Number(args.dpr ?? 1.25);
const blocks = Number(args.blocks ?? 8);
const frames = Number(args.frames ?? 40);
const feature = args.feature ?? 'micro';
const target = args.target ?? (feature === 'spec' ? 'both' : 'terrain');
const only = args.only ? new Set(args.only.split(',')) : null;
const out = resolve(args.out ?? 'test-results/micro-detail');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const VIEWS = {
  bridge: 'fixture=city&yearT=0.66&cx=9&cz=-105&dist=20&elev=30',
  street40: 'fixture=city&yearT=0.66&cx=5&cz=-28&dist=40&elev=30',
  'square-dawn': 'fixture=city&yearT=0.02&cx=5&cz=-28&dist=25&elev=25',
  // Worst case: paving fills most of the screen, seen from above at 16 m.
  'paving-top': 'fixture=city&yearT=0.66&cx=5&cz=-28&dist=16&elev=70',
  'city-close': 'fixture=city&yearT=0.66&cx=-20&cz=0&dist=60&elev=30',
  'city-autumn': 'fixture=city&yearT=0.7',
  'town-close': 'fixture=town&yearT=0.3&cx=-30&cz=10&dist=55&elev=28',
};
// Roof courses (--target=kit): close and default-range views over tile, slate
// and shingle roofs, with the sun low and high.
const ROOF_VIEWS = {
  'roofs-20': 'fixture=city&yearT=0.66&cx=-20&cz=0&dist=20&elev=40',
  'roofs-40': 'fixture=city&yearT=0.66&cx=-20&cz=0&dist=40&elev=35',
  'roofs-dawn': 'fixture=city&yearT=0.02&cx=-20&cz=0&dist=30&elev=30',
  // Worst case: roofs fill the screen, seen from above at 18 m.
  'roofs-top': 'fixture=city&yearT=0.66&cx=-20&cz=0&dist=18&elev=70',
  'city-close': VIEWS['city-close'],
  'city-autumn': VIEWS['city-autumn'],
  'town-close': VIEWS['town-close'],
};

// Specular (--feature=spec): wet paving and roofs in rain, glass at low sun,
// close and at the default range, and dry views where only glass shines.
// Ground detail (--feature=ground): grass, trodden soil and trails, sand,
// shingle and river banks, rock faces; close, at low sun, and the default range.
const GROUND_VIEWS = {
  'grass-28': 'fixture=town&yearT=0.3&cx=-30&cz=10&dist=28&elev=40',
  'grass-dawn': 'fixture=town&yearT=0.02&weather=clear&cx=-30&cz=10&dist=24&elev=22',
  'trails-20': 'fixture=town&yearT=0.3&cx=-10&cz=0&dist=20&elev=45',
  // Worst case: near ground fills the screen, seen from above at 16 m.
  'ground-top': 'fixture=town&yearT=0.3&cx=-30&cz=10&dist=16&elev=70',
  'beach-sand': 'seed=3&arch=coast&yearT=0.3&weather=clear&cx=-32&cz=-132&dist=24&elev=32',
  'lake-shingle': 'seed=9&yearT=0.3&weather=clear&cx=8&cz=88&dist=24&elev=32',
  'river-bank': 'seed=9&yearT=0.3&weather=clear&cx=-8&cz=-20&dist=20&elev=45',
  'rock-face': 'seed=9&yearT=0.3&weather=clear&cx=-92&cz=-244&dist=35&elev=30',
  'town-close': VIEWS['town-close'],
  'city-autumn': VIEWS['city-autumn'],
};

const SPEC_VIEWS = {
  'rain-street': 'fixture=city&yearT=0.66&weather=rain&cx=5&cz=-28&dist=25&elev=25',
  'rain-bridge': 'fixture=city&yearT=0.45&weather=rain&cx=9&cz=-105&dist=22&elev=28',
  'rain-roofs': 'fixture=city&yearT=0.45&weather=rain&cx=-20&cz=0&dist=30&elev=35',
  'rain-dawn': 'fixture=city&yearT=0.02&weather=rain&cx=5&cz=-28&dist=30&elev=22',
  // Worst case: wet paving fills the screen, seen from above at 16 m.
  'rain-paving-top': 'fixture=city&yearT=0.66&weather=rain&cx=5&cz=-28&dist=16&elev=70',
  // The camera at the sun's mirror image in a facade facing -z (az 145) or
  // -x (az 325): sun azimuth 215 (daylight.js), elevation about the sun's.
  'dawn-glass': 'fixture=city&yearT=0.02&weather=clear&cx=-20&cz=0&dist=40&elev=18&az=145',
  'dawn-glass-x': 'fixture=city&yearT=0.02&weather=clear&cx=-20&cz=0&dist=40&elev=18&az=325',
  'evening-glass': 'fixture=city&yearT=0.8&weather=clear&cx=-20&cz=0&dist=45&elev=24&az=145',
  'town-rain': 'fixture=town&yearT=0.45&weather=rain&cx=-30&cz=10&dist=75&elev=32',
  'city-autumn': VIEWS['city-autumn'],
};

const server = await createServer({
  configFile: resolve('vite.config.js'), logLevel: 'error',
  server: { host: '127.0.0.1', port: Number(args.port ?? 5241), strictPort: false, hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.config.server.port}`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const rows = [];
try {
  const viewSet = (args.views ?? (feature === 'spec' ? 'spec' : feature === 'ground' ? 'ground' : target === 'kit' ? 'roof' : 'paving'));
  const views = { spec: SPEC_VIEWS, roof: ROOF_VIEWS, ground: GROUND_VIEWS, paving: VIEWS }[viewSet];
  for (const [name, q] of Object.entries(views)) {
    if (only && !only.has(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 200)); });
    await page.goto(`${url}/src/render/dev/render-dev.html?${q}&tier=${tier}&hud=0&freeze=1&speed=0`);
    await page.waitForFunction(() => window.__frames?.() > 30, null, { timeout: 60000 }).catch(() => {});
    // Wait until the scene stops growing (draw calls steady for 2 s).
    await page.evaluate(async () => {
      let last = -1, steady = 0;
      for (let i = 0; i < 60 && steady < 4; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const c = window.__world.stats().drawCalls;
        steady = c === last ? steady + 1 : 0;
        last = c;
      }
    });
    const stats = await page.evaluate(async ({ blocks, frames, target, feature }) => {
      const w = window.__world, v = window.__view;
      const { renderer, terrain, buildings } = w.internals;
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const px = new Uint8Array(4);
      const tierName = w.stats().tier;
      // terrain.applyQuality reads only these fields (cloud shadows are High's);
      // buildings.applyQuality reads the name (detail distance), microDetail
      // and specular. The feature not under test keeps the tier's setting.
      const high = tierName === 'high';
      const setMicro = (on) => {
        const q = { name: tierName, cloudShadow: high, microDetail: feature === 'micro' ? on : high, specular: feature === 'spec' ? on : high, groundDetail: feature === 'ground' ? on : true };
        if (target !== 'kit') terrain.applyQuality(q);
        if (target !== 'terrain') buildings.applyQuality(q);
      };
      const alone = target === 'kit' ? [buildings.group] : target === 'terrain' ? [terrain.group] : [terrain.group, buildings.group];
      async function run(n) {
        const queries = [];
        for (let i = 0; i < n; i++) {
          w.requestFrame();
          const qq = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
          w.update(v, performance.now() / 1000, 1 / 60);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queries.push(qq);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          await new Promise((r) => setTimeout(r, 0));
        }
        await new Promise((r) => setTimeout(r, 100));
        const ms = [];
        for (const qq of queries) {
          if (gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(qq);
        }
        return ms;
      }
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
      // Warm both programs, then alternate blocks (off, on, on, off, ...).
      for (const on of [true, false]) { setMicro(on); await run(10); }
      const off = [], on = [], diffs = [];
      for (let b = 0; b < blocks; b++) {
        const order = b % 2 ? [true, false] : [false, true];
        const pair = {};
        for (const o of order) { setMicro(o); await run(5); pair[o] = med(await run(frames)); }
        off.push(pair.false); on.push(pair.true); diffs.push(pair.true - pair.false);
      }
      // Target alone: everything else hidden, straight to the canvas (no
      // post pass, no occluders, so every target pixel is shaded: an upper
      // bound on the relief's cost). One timer query over 10 renders.
      const s = w.stats();
      const { scene } = w.internals;
      const camera = w.camera.camera;
      const shown = new Map();
      for (const o of scene.children) { shown.set(o, o.visible); o.visible = alone.includes(o) || o.isLight || o === camera; }
      async function terrainMs() {
        const qq = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
        for (let i = 0; i < 10; i++) renderer.render(scene, camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        await new Promise((r) => setTimeout(r, 30));
        const ok = gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ms = ok ? gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e7 : null;
        gl.deleteQuery(qq);
        return ms;
      }
      for (const o of [true, false]) { setMicro(o); await terrainMs(); }
      const tOff = [], tOn = [], tDiffs = [];
      for (let b = 0; b < blocks * 3; b++) {
        const order = b % 2 ? [true, false] : [false, true];
        const pair = {};
        for (const o of order) { setMicro(o); const a = []; for (let k = 0; k < 3; k++) a.push(await terrainMs()); pair[o] = med(a.filter((x) => x != null)); }
        tOff.push(pair.false); tOn.push(pair.true); tDiffs.push(pair.true - pair.false);
      }
      for (const [o, vis] of shown) o.visible = vis;
      setMicro(high);
      w.requestFrame();
      const r2 = (x) => Math.round(x * 1000) / 1000;
      if (!blocks) return { drawCalls: s.drawCalls, tier: s.tier };
      return {
        gpuOff: r2(med(off)), gpuOn: r2(med(on)), delta: r2(med(diffs)), deltaMin: r2(Math.min(...diffs)), deltaMax: r2(Math.max(...diffs)),
        aloneOff: r2(med(tOff)), aloneOn: r2(med(tOn)), aloneDelta: r2(med(tDiffs)), tDeltaMin: r2(Math.min(...tDiffs)), tDeltaMax: r2(Math.max(...tDiffs)),
        drawCalls: s.drawCalls, tier: s.tier,
      };
    }, { blocks, frames, target, feature });
    if ('shots' in args) {
      // Off, then on, each after a few drawn frames (the program is warm).
      for (const on of [false, true]) {
        await page.evaluate(async ({ on, target, feature }) => {
          const w = window.__world, { terrain, buildings } = w.internals, tierName = w.stats().tier, high = tierName === 'high';
          const q = { name: tierName, cloudShadow: high, microDetail: feature === 'micro' ? on : high, specular: feature === 'spec' ? on : high, groundDetail: feature === 'ground' ? on : true };
          if (target !== 'kit') terrain.applyQuality(q);
          if (target !== 'terrain') buildings.applyQuality(q);
          for (let i = 0; i < 8; i++) { w.requestFrame(); await new Promise((r) => requestAnimationFrame(r)); }
        }, { on, target, feature });
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${out}/${name}-${on ? 'on' : 'off'}.png` });
      }
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${out}/${name}-off.png`, '-i', `${out}/${name}-on.png`, '-filter_complex', 'hstack', '-q:v', '3', `${out}/${name}-ab.jpg`]);
    }
    rows.push({ name, ...stats, errors: errors.slice(0, 3).join(' | ') });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.table(rows);
writeFileSync(`${out}/${feature}-ab-${target}-${tier}.json`, JSON.stringify(rows, null, 2));
