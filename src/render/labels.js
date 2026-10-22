// Centre name labels (design-centres §6), lettered like an atlas: the
// display serif in warm white over a soft dark shadow, names as written, no
// pill, icon or numbers. The main centre is set upright and larger, the
// lesser centres in italic, as a map sets a town and its quarters. They
// belong to the overview only: hidden while the camera is close, fading in
// (300 ms) once it is well zoomed out, the main centre first. Overlaps keep
// the higher rank; labels never sit over the UI's insets and fade toward the
// edges of the free area.
//
// Reads view.centres = [{id, name, x, z, rank}] (the lowest rank is the main centre).
// DOM text over the canvas: crisp at any pixel ratio, no textures.

const STYLE_ID = 'hv-centre-label-style';
const CSS = `
.hv-centre-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.hv-centre-label {
  position: absolute; left: 0; top: 0; white-space: nowrap;
  font: italic 500 14px/1 "Fraunces", "Iowan Old Style", Georgia, serif;
  font-variation-settings: "opsz" 36, "SOFT" 30;
  letter-spacing: 0.03em;
  color: #fbf7ec;
  text-shadow: 0 1px 1px rgba(24, 28, 20, 0.7), 0 0 4px rgba(24, 28, 20, 0.55), 0 0 12px rgba(24, 28, 20, 0.35);
  opacity: 0; transition: opacity 300ms ease; will-change: transform, opacity;
}
.hv-centre-label.rank0 {
  font-style: normal; font-weight: 600; font-size: 18px; letter-spacing: 0.02em;
  font-variation-settings: "opsz" 72, "SOFT" 30;
}
`;

const EDGE = 60; // px over which labels fade at the free area's edges

export function createLabels(ctx) {
  const { canvas, camera, rig, ground } = ctx;
  if (typeof document === 'undefined' || !canvas?.parentElement) {
    return { update() {}, dispose() {} };
  }
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }
  const layer = document.createElement('div');
  layer.className = 'hv-centre-labels';
  const host = canvas.parentElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.append(layer);

  let key = '';
  const items = []; // {el, x, y, z, rank, w, h}
  const v = { x: 0, y: 0, z: 0 };

  function rebuild(centres) {
    layer.textContent = '';
    items.length = 0;
    // sim-world ranks from 1 (the main centre); normalise so the main is 0.
    const live = centres.filter((c) => c?.name && c.mergedInto == null);
    const top = Math.min(...live.map((c) => c.rank ?? 0));
    for (const c of live) {
      const el = document.createElement('div');
      const rank = Math.max(0, (c.rank ?? 0) - top);
      el.className = `hv-centre-label rank${Math.min(rank, 1)}`;
      el.textContent = c.name;
      layer.append(el);
      // Anchored a little above the centre's core; steady, no bobbing.
      const y = (ground?.sample(c.x, c.z) ?? 0) + 16;
      items.push({ el, x: c.x, y, z: c.z, rank, w: 0, h: 0, shown: false });
    }
    // Measure once (text does not change until the list does).
    for (const it of items) {
      it.w = it.el.offsetWidth;
      it.h = it.el.offsetHeight;
    }
    items.sort((a, b) => a.rank - b.rank);
  }

  /** Project a world point to canvas pixels (null when behind the camera). */
  function project(it, width, height) {
    v.x = it.x; v.y = it.y; v.z = it.z;
    const e = camera.matrixWorldInverse.elements;
    const p = camera.projectionMatrix.elements;
    // view space
    const vx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
    const vy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
    const vz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
    if (vz >= -1) return null;
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
    const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    return { sx: (cx / cw * 0.5 + 0.5) * width, sy: (-cy / cw * 0.5 + 0.5) * height };
  }

  const placed = [];
  function update(view, frame) {
    const enabled = ctx.labelsOn !== false;
    const centres = view?.centres ?? [];
    const k = centres.map((c) => `${c.id}:${c.name}:${c.rank ?? 0}`).join('|');
    if (k !== key) {
      key = k;
      rebuild(centres);
    }
    if (!items.length) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const ins = rig.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    // Zoom gate: the main centre needs ~2.5x the home framing distance (or a
    // view spanning ~250 m); each lower rank needs 12 % more.
    const home = rig.homeDistance?.() ?? 150;
    const base = Math.min(Math.max(2.5 * home, 200), 270);
    placed.length = 0;
    for (const it of items) {
      // Every rank can show at full zoom-out (max distance 340).
      let show = enabled && frame.distance > Math.min(base * (1 + 0.12 * it.rank), 325);
      let alpha = 1;
      let pos = null;
      if (show) {
        pos = project(it, width, height);
        if (!pos) show = false;
      }
      if (show) {
        const x0 = pos.sx - it.w / 2, y0 = pos.sy - it.h;
        const x1 = x0 + it.w, y1 = y0 + it.h;
        // Fade toward the free area's edges; hidden over the UI's insets.
        const l = ins.left, r = width - ins.right, t = ins.top, b = height - ins.bottom;
        const edge = Math.min(x0 - l, r - x1, y0 - t, b - y1);
        alpha = Math.max(0, Math.min(1, edge / EDGE));
        if (alpha <= 0) show = false;
        // Declutter: a lower rank never overlaps a label already placed.
        for (const p of placed) {
          if (x0 < p.x1 + 8 && x1 > p.x0 - 8 && y0 < p.y1 + 4 && y1 > p.y0 - 4) { show = false; break; }
        }
        if (show) {
          placed.push({ x0, y0, x1, y1 });
          it.el.style.transform = `translate3d(${x0.toFixed(1)}px, ${y0.toFixed(1)}px, 0)`;
        }
      }
      const opacity = show ? alpha.toFixed(2) : '0';
      if (it.el.style.opacity !== opacity) it.el.style.opacity = opacity;
    }
  }

  return {
    update,
    dispose() {
      layer.remove();
    },
  };
}
