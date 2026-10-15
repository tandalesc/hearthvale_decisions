// Development stand-in for the renderer's createWorld (contract §6). Draws a
// simple oblique 2D map on a canvas so the UI can be built and screenshotted
// before src/render lands. Honours setSceneInsets so framing can be checked.
import {riverX} from '../../terrain.js';

const ROOF = ['#b5714d', '#a8593f', '#9a4e3c', '#7f6a5d', '#6b7480', '#5d7c86'];
const WALL = ['#e9dcc0', '#d9d0bd', '#c98d6a', '#d6c1a1', '#e4ddcd', '#eef0ea'];
const CLOTH = ['#b2563f', '#526d42', '#3f8a99', '#c9a24a', '#6c5a8a', '#8a6a4a', '#33433a'];

export function createWorld(canvas, {quality = 'auto'} = {}) {
  const ctx = canvas.getContext('2d');
  let view = null, insets = {top: 0, right: 0, bottom: 0, left: 0};
  let cam = {x: -18, z: 4, scale: 0}, target = null, tier = quality === 'auto' ? 'medium' : quality;
  let overlay = 'none', dayCycle = 'seasonal', pickCb = null;
  let lastDraw = 0, frames = 0, fps = 60, fpsAt = 0;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);

  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return {w, h};
  }

  function fit(w, h) {
    if (cam.scale || !view?.buildings?.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of view.buildings) {
      minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x); minZ = Math.min(minZ, b.z); maxZ = Math.max(maxZ, b.z);
    }
    cam.x = (minX + maxX) / 2;
    cam.z = (minZ + maxZ) / 2;
    const fw = w - insets.left - insets.right, fh = h - insets.top - insets.bottom;
    cam.scale = Math.max(2.2, Math.min(14, Math.min(fw / (maxX - minX + 40), fh / ((maxZ - minZ + 40) * 0.62))));
  }

  function project(x, z, y = 0, w, h) {
    const cx = insets.left + (w - insets.left - insets.right) / 2;
    const cy = insets.top + (h - insets.top - insets.bottom) / 2;
    return [cx + (x - cam.x) * cam.scale, cy + (z - cam.z) * cam.scale * 0.62 - y * cam.scale];
  }

  function draw() {
    const {w, h} = resize();
    fit(w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const yearT = view?.time?.yearT ?? 0.3;
    const night = dayCycle === 'off' ? 0 : Math.max(0, (yearT - 0.94) / 0.06);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, mix('#a9c98a', '#2a3a33', night));
    g.addColorStop(1, mix('#8fb873', '#223029', night));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // River ribbon
    ctx.beginPath();
    for (let z = -300; z <= 300; z += 6) {
      const [sx, sy] = project(riverX(z) - 4.8, z, 0, w, h);
      z === -300 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    }
    for (let z = 300; z >= -300; z -= 6) {
      const [sx, sy] = project(riverX(z) + 4.8, z, 0, w, h);
      ctx.lineTo(sx, sy);
    }
    ctx.fillStyle = mix('#4f98a6', '#1f3b44', night);
    ctx.fill();
    if (!view) return;
    const s = cam.scale;
    const list = [...view.buildings].sort((a, b) => a.z - b.z);
    for (const b of list) {
      const [sx, sy] = project(b.x, b.z, 0, w, h);
      if (sx < -40 || sx > w + 40 || sy < -60 || sy > h + 40) continue;
      const bw = b.w * s, bh = b.storeys * 1.3 * s, bd = b.d * s * 0.62;
      const e = Math.min(5, b.styleEra ?? 0);
      if (b.type === 'farm') {
        ctx.fillStyle = mix('#c9b46a', '#4a4a32', night);
        ctx.fillRect(sx - bw, sy - bd, bw * 2, bd * 2);
      }
      ctx.fillStyle = 'rgba(30,40,30,.18)';
      ctx.fillRect(sx - bw / 2 + s * 0.4, sy - bd / 2 + s * 0.3, bw, bd);
      ctx.fillStyle = mix(overlay === 'value' ? heat(b.wealth) : WALL[e], '#3a4038', night * 0.7);
      ctx.fillRect(sx - bw / 2, sy - bh, bw, bh);
      ctx.fillStyle = mix(ROOF[e], '#2b2f2a', night * 0.6);
      ctx.beginPath();
      ctx.moveTo(sx - bw / 2 - s * 0.3, sy - bh);
      ctx.lineTo(sx, sy - bh - bd * 0.9);
      ctx.lineTo(sx + bw / 2 + s * 0.3, sy - bh);
      ctx.closePath();
      ctx.fill();
      if (night > 0.3) {
        ctx.fillStyle = 'rgba(255,214,140,.85)';
        ctx.fillRect(sx - s * 0.4, sy - bh * 0.6, s * 0.5, s * 0.5);
      }
    }
    const people = view.people, n = view.peopleCount;
    const r = Math.max(0.8, s * 0.22);
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const [sx, sy] = project(people[o], people[o + 2], 0, w, h);
      if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
      ctx.fillStyle = CLOTH[people[o + 12] % CLOTH.length];
      ctx.fillRect(sx - r / 2, sy - r * 2, r, r * 2);
    }
  }

  // Pointer: drag pans, wheel zooms, a tap without drag picks.
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = {x: e.clientX, y: e.clientY, cx: cam.x, cz: cam.z, moved: false}; canvas.setPointerCapture?.(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.hypot(dx, dy) > 5) down.moved = true;
    if (down.moved) { cam.x = down.cx - dx / cam.scale; cam.z = down.cz - dy / (cam.scale * 0.62); }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (down && !down.moved) pick(e.clientX, e.clientY);
    down = null;
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.scale = Math.max(1.5, Math.min(30, cam.scale * Math.exp(-e.deltaY * 0.0015))); }, {passive: false});

  function pick(px, py) {
    if (!view || !pickCb) return;
    const rect = canvas.getBoundingClientRect();
    const {w, h} = {w: rect.width, h: rect.height};
    let best = null, bestD = 18;
    for (const b of view.buildings) {
      const [sx, sy] = project(b.x, b.z, 0, w, h);
      const d = Math.hypot(sx - (px - rect.left), sy - b.storeys * cam.scale * 0.6 - (py - rect.top));
      if (d < bestD) { bestD = d; best = {buildingId: b.id}; }
    }
    pickCb(best ?? {x: cam.x, z: cam.z});
  }

  return {
    update(v, time) {
      view = v;
      const now = time * 1000;
      if (target) {
        const k = Math.min(1, (now - target.t0) / target.ms);
        cam.x = target.fx + (target.x - target.fx) * ease(k);
        cam.z = target.fz + (target.z - target.fz) * ease(k);
        if (k >= 1) target = null;
      }
      frames++;
      if (now - fpsAt > 1000) { fps = frames * 1000 / (now - fpsAt); frames = 0; fpsAt = now; }
      if (now - lastDraw < 30) return;
      lastDraw = now;
      draw();
    },
    setQuality(q) { tier = q === 'auto' ? 'medium' : q; },
    quality: () => tier,
    setDayCycle(mode) { dayCycle = mode; },
    setOverlay(mode) { overlay = mode; },
    focus({x, z}, ms = 800) { target = {x, z, fx: cam.x, fz: cam.z, ms, t0: performance.now()}; },
    onPick(cb) { pickCb = cb; },
    stats: () => ({fps, frameMs: 1000 / Math.max(1, fps), drawCalls: 0, triangles: 0, tier, stub: true}),
    setSceneInsets(next) { insets = {...insets, ...next}; },
    insets: () => ({...insets}),
    projectPoint(x, z) { const r = canvas.getBoundingClientRect(); const [sx, sy] = project(x, z, 0, r.width, r.height); return {x: sx + r.left, y: sy + r.top}; },
    dispose() {},
  };
}

function ease(t) { return 1 - Math.pow(1 - t, 3); }

function heat(v) {
  return mix('#e8d9a8', '#b2563f', Math.max(0, Math.min(1, v ?? 0)));
}

function mix(a, b, t) {
  if (!(t > 0)) return a;
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map((sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t));
  return `rgb(${c.join(',')})`;
}
