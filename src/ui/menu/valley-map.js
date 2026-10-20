// The main menu's valley map: a surveyor's sheet of the valley a seed grows,
// drawn from the same terrain the game uses. Heights are sampled in a worker
// (valley-worker.js); this file shades them into paper, contours and water.

const SIZE = 200;          // samples per side
const EXTENT = 420;        // world units from the centre to the sheet's edge
const CONTOUR = 3;         // height between contour lines
const INDEX = 5;           // every fifth line is drawn heavier
const WATER = new Set([1, 2, 3, 4, 5]);

function hex(value, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => hex(cs.getPropertyValue(name), fb);
  return {
    paper: v('--paper-card', [255, 254, 249]),
    low: v('--green-soft', [227, 234, 211]),
    mid: v('--paper-3', [233, 235, 219]),
    high: v('--line-2', [207, 215, 189]),
    ink: v('--ink', [47, 63, 47]),
    river: v('--river', [63, 138, 153]),
    riverSoft: v('--river-soft', [217, 235, 236]),
    gold: v('--gold', [201, 162, 74]),
    night: document.documentElement.dataset.theme === 'night',
  };
}

const mix = (a, b, t) => a + (b - a) * t;

// Samples on the main thread: the fallback when workers are unavailable.
async function sampleHere(job) {
  const t = await import('../../terrain.js');
  t.setTerrainSeed(job.seed, job.version, job.archetype);
  const size = Math.round(job.size / 2), step = (job.extent * 2) / (size - 1);
  const heights = new Float32Array(size * size), kinds = new Uint8Array(size * size), banks = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -job.extent + i * step, z = -job.extent + j * step;
      heights[j * size + i] = t.heightAt(x, z);
      kinds[j * size + i] = t.waterKindAt(x, z);
      banks[j * size + i] = Math.max(-40, Math.min(40, t.bankDistance(x, z)));
    }
  }
  const river = t.hasRiver();
  const ford = river ? t.FORDS.reduce((a, f) => (Math.abs(f.z) < Math.abs(a.z) ? f : a), t.FORDS[0]) : null;
  return {
    size, extent: job.extent, heights, kinds, banks, river,
    archetype: t.terrainInfo().archetype ?? 'river',
    fords: river ? t.FORDS.map((f) => ({x: t.riverX(f.z), z: f.z})) : [],
    hamlet: ford ? {x: t.riverX(ford.z), z: ford.z} : {x: 0, z: 0},
  };
}

export function createValleyMap(canvas) {
  let worker = null;
  let seq = 0;
  let last = null;            // the last sampled valley, kept to redraw on resize or theme change
  const pending = new Map();
  const ctx = canvas.getContext('2d');

  function getWorker() {
    if (worker !== null) return worker;
    try {
      worker = new Worker(new URL('./valley-worker.js', import.meta.url), {type: 'module'});
      worker.onmessage = (e) => {
        const resolve = pending.get(e.data.id);
        pending.delete(e.data.id);
        resolve?.(e.data);
      };
      worker.onerror = () => { worker.terminate(); worker = false; for (const r of pending.values()) r(null); pending.clear(); };
    } catch {
      worker = false;
    }
    return worker;
  }

  function sample(job) {
    const w = getWorker();
    if (!w) return sampleHere(job);
    return new Promise((resolve) => {
      pending.set(job.id, resolve);
      w.postMessage(job);
    });
  }

  function paint(data) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(rect.width * dpr)), H = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const c = palette();
    const {size, heights, kinds} = data;

    // The sheet: a square of the valley, centred, filling the shorter side.
    const side = Math.min(W, H);
    const ox = (W - side) / 2, oy = (H - side) / 2;
    const img = ctx.createImageData(side, side);
    const px = img.data;
    const scale = (size - 1) / (side - 1);
    let hmin = Infinity, hmax = -Infinity;
    for (let k = 0; k < heights.length; k++) if (!WATER.has(kinds[k])) { hmin = Math.min(hmin, heights[k]); hmax = Math.max(hmax, heights[k]); }
    if (!Number.isFinite(hmin)) { hmin = 0; hmax = 1; }
    const span = Math.max(1, hmax - hmin);
    const H_ = (i, j) => heights[Math.min(size - 1, Math.max(0, j)) * size + Math.min(size - 1, Math.max(0, i))];
    // Light from the upper left, as on an old relief map.
    const lx = -0.6, lz = -0.6, ly = 0.55;
    const hatch = Math.max(3, Math.round(4 * dpr));

    // Water from the distance to the bank (negative over water), blended
    // between samples, so shores come out as curves rather than steps.
    const banks = data.banks;
    const W_ = (i, j) => banks[Math.min(size - 1, Math.max(0, j)) * size + Math.min(size - 1, Math.max(0, i))];
    const pxWorld = (EXTENT * 2) / side;
    const K_ = (i, j) => kinds[Math.min(size - 1, Math.max(0, j)) * size + Math.min(size - 1, Math.max(0, i))];
    const cell = (EXTENT * 2) / (size - 1);

    for (let y = 0; y < side; y++) {
      const fy = y * scale, j = Math.floor(fy), ty = fy - j;
      for (let x = 0; x < side; x++) {
        const fx = x * scale, i = Math.floor(fx), tx = fx - i;
        const h00 = H_(i, j), h10 = H_(i + 1, j), h01 = H_(i, j + 1), h11 = H_(i + 1, j + 1);
        const h = mix(mix(h00, h10, tx), mix(h01, h11, tx), ty);
        const d = mix(mix(W_(i, j), W_(i + 1, j), tx), mix(W_(i, j + 1), W_(i + 1, j + 1), tx), ty);
        const o = (y * side + x) * 4;
        let r, g, b;
        if (d < 0) {
          // The kind of the nearest wet sample: still water gets engraved lines, rivers a plain wash.
          let k = K_(Math.round(fx), Math.round(fy));
          if (!WATER.has(k)) k = [K_(i, j), K_(i + 1, j), K_(i, j + 1), K_(i + 1, j + 1)].find((q) => WATER.has(q)) ?? 1;
          const line = (y % hatch) === 0 && k !== 1 && k !== 2;
          const t = line ? 0.3 : 0;
          r = mix(c.riverSoft[0], c.river[0], t); g = mix(c.riverSoft[1], c.river[1], t); b = mix(c.riverSoft[2], c.river[2], t);
        } else {
          const e = (h - hmin) / span;
          const base = e < 0.5 ? [mix(c.low[0], c.mid[0], e * 2), mix(c.low[1], c.mid[1], e * 2), mix(c.low[2], c.mid[2], e * 2)]
            : [mix(c.mid[0], c.high[0], (e - 0.5) * 2), mix(c.mid[1], c.high[1], (e - 0.5) * 2), mix(c.mid[2], c.high[2], (e - 0.5) * 2)];
          // A gentle hillshade from the local slope; steep river banks stay readable.
          const dx = (h10 - h00 + h11 - h01) / 2, dz = (h01 - h00 + h11 - h10) / 2;
          const nx = -dx / cell, nz = -dz / cell, ny = 1;
          const shade = (nx * lx + nz * lz + ny * ly) / Math.hypot(nx, ny, nz) / Math.hypot(lx, ly, lz);
          const s = Math.max(-0.16, Math.min(0.12, (shade - 0.62) * (c.night ? 0.7 : 0.9)));
          r = base[0] * (1 + s); g = base[1] * (1 + s); b = base[2] * (1 + s);
          // Contours: a line where this pixel and its neighbours sit in different bands.
          const band = Math.floor(h / CONTOUR);
          const tr = Math.min(1, tx + scale), td = Math.min(1, ty + scale);
          const hr = mix(mix(h00, h10, tr), mix(h01, h11, tr), ty);
          const hd = mix(mix(h00, h10, tx), mix(h01, h11, tx), td);
          const br = Math.floor(hr / CONTOUR), bd = Math.floor(hd / CONTOUR);
          if (br !== band || bd !== band) {
            const strong = Math.max(band, br, bd) % INDEX === 0;
            const a = strong ? 0.5 : 0.26;
            r = mix(r, c.ink[0], a); g = mix(g, c.ink[1], a); b = mix(b, c.ink[2], a);
          }
        }
        // The shore: a thin darker line along the water's edge, about a pixel wide.
        const edge = Math.abs(d) / (pxWorld * 0.9);
        if (edge < 1) {
          const a = 0.85 * (1 - edge);
          r = mix(r, c.river[0], a); g = mix(g, c.river[1], a); b = mix(b, c.river[2], a);
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }

    ctx.fillStyle = `rgb(${c.paper.join(',')})`;
    ctx.fillRect(0, 0, W, H);
    ctx.putImageData(img, ox, oy);

    const toPx = (wx) => ((wx + EXTENT) / (EXTENT * 2)) * side;
    ctx.save();
    ctx.translate(ox, oy);

    // Fords: two short strokes across the stream.
    ctx.strokeStyle = `rgba(${c.ink.join(',')},0.7)`;
    ctx.lineWidth = Math.max(1, dpr);
    for (const f of data.fords) {
      const x = toPx(f.x), y = toPx(f.z), r = 6 * dpr;
      ctx.beginPath();
      ctx.moveTo(x - r, y - 2 * dpr); ctx.lineTo(x + r, y - 2 * dpr);
      ctx.moveTo(x - r, y + 2 * dpr); ctx.lineTo(x + r, y + 2 * dpr);
      ctx.stroke();
    }

    // Where the first families settle.
    const hx = toPx(data.hamlet.x), hy = toPx(data.hamlet.z);
    ctx.fillStyle = `rgb(${c.gold.join(',')})`;
    ctx.strokeStyle = `rgb(${c.ink.join(',')})`;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(hx, hy, 6 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, 13 * dpr, 0, Math.PI * 2);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = `italic 500 ${Math.round(14 * dpr)}px Fraunces, Georgia, serif`;
    ctx.fillStyle = `rgb(${c.ink.join(',')})`;
    ctx.textBaseline = 'middle';
    const label = 'Seven families';
    const tw = ctx.measureText(label).width;
    const right = hx + 20 * dpr + tw < side - 12 * dpr;
    ctx.textAlign = right ? 'left' : 'right';
    ctx.fillText(label, right ? hx + 20 * dpr : hx - 20 * dpr, hy);

    // The neat line: a double rule round the sheet.
    ctx.strokeStyle = `rgba(${c.ink.join(',')},0.55)`;
    ctx.lineWidth = dpr;
    ctx.strokeRect(0.5 * dpr, 0.5 * dpr, side - dpr, side - dpr);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(6 * dpr, 6 * dpr, side - 12 * dpr, side - 12 * dpr);
    ctx.restore();
  }

  return {
    /** Draws the valley for a seed; resolves with what the sampler found (archetype, river). */
    async show({seed, version, archetype}) {
      const id = ++seq;
      canvas.dataset.loading = 'true';
      const data = await sample({id, seed, version, archetype, size: SIZE, extent: EXTENT});
      if (id !== seq || !data) return null;
      last = data;
      paint(data);
      canvas.dataset.loading = 'false';
      return {archetype: data.archetype, river: data.river};
    },
    /** Paints the last valley again (after a resize or a theme change). */
    redraw() { if (last) paint(last); },
    dispose() { if (worker) worker.terminate(); worker = false; pending.clear(); },
  };
}
