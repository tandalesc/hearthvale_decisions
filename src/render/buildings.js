import * as THREE from 'three';
import { PieceBatch } from './kit/batch.js';
import { composeLot, createSpecPool, PIECES } from './kit/compose.js';
import { createKitMaterials, createKitUniforms } from './kit/material.js';
import * as G from './kit/geometry.js';
import { LAYER_REFLECT } from './shaderlib.js';

// Instanced buildings (design-visual §4.1, §6). One InstancedMesh per kit
// piece for the whole town (~18 draw calls), slot-allocated per lot and
// updated incrementally: a change rewrites only that lot's instances.
// Construction, completion, grow-in and demolition are short tweens on the
// affected lots only.

export const GEOMETRY = {
  body: () => G.bodyPiece(),
  gable: () => G.pitchedRoof(G.PROFILES.gable),
  thatch: () => G.pitchedRoof(G.PROFILES.thatch),
  mansard: () => G.pitchedRoof(G.PROFILES.mansard),
  hip: () => G.hipRoof(),
  flat: () => G.flatRoof(),
  chimney: () => G.chimneyPiece(),
  spire: () => G.spirePiece(),
  dome: () => G.domePiece(),
  sawtooth: () => G.sawtoothPiece(),
  stack: () => G.stackPiece(),
  posts: () => G.postsPiece(),
  scaffold: () => G.postsPiece({ planks: true }),
  portico: () => G.porticoPiece(),
  awning: () => G.awningPiece(),
  sails: () => G.sailsPiece(),
  field: () => G.fieldPiece(),
  banner: () => G.bannerPiece(),
  band: () => G.bandPiece(),
  piles: () => G.pilesPiece(),
  balcony: () => G.balconyPiece(),
};

// Which material variant and shadow role each piece uses.
const PIECE_OPTS = {
  chimney: { variant: 'detail' },
  awning: { variant: 'detail' },
  banner: { variant: 'detail double' },
  sails: { variant: 'rotor double', castShadow: false },
  field: { variant: 'crop', castShadow: false },
  scaffold: { variant: 'double' },
  posts: {},
  balcony: { variant: 'detail' },
};

const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** Signature of the fields that change a lot's look (missed-event safety net). */
function signature(b) {
  let h = 17;
  const mix = (v) => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 16777619); };
  mix(b.x); mix(b.z); mix(b.w); mix(b.d); mix(b.rot ?? 0); mix(b.storeys ?? 1); mix(b.tier ?? 1);
  mix(b.styleEra ?? 0); mix(Math.round((b.wealth ?? 0) * 20)); mix(Math.round((b.condition ?? 1) * 20));
  mix(b.built ?? 1); mix(b.lit === false ? 0 : 1); mix(b.occupied === false ? 0 : 1);
  mix(b.extensions?.length ?? 0); mix(b.banner ? b.banner.length : 0); mix(b.type.length * 31 + b.type.charCodeAt(0));
  mix(b.flags?.heritage ? 1 : 0);
  return h;
}

export function createBuildings({ scene, grade, lights, ground }) {
  const kitUniforms = createKitUniforms();
  const materials = new Map();
  const materialFor = (variant) => {
    if (!materials.has(variant)) materials.set(variant, createKitMaterials(grade, { variant, shared: kitUniforms }));
    return materials.get(variant);
  };

  const group = new THREE.Group();
  group.name = 'buildings';
  scene.add(group);
  const batches = new Map();
  for (const name of PIECES) {
    // A kit piece without a builder must never stop the world from booting.
    if (typeof GEOMETRY[name] !== 'function') {
      console.warn(`[render] kit piece '${name}' has no geometry; skipped`);
      continue;
    }
    const opts = PIECE_OPTS[name] ?? {};
    const { material, depth } = materialFor(opts.variant ?? '');
    const geometry = GEOMETRY[name]();
    geometry.setAttribute('aPartAO', interleavePartAO(geometry));
    geometry.deleteAttribute('aPart');
    geometry.deleteAttribute('aAO');
    const batch = new PieceBatch(name, geometry, material, depth, {
      capacity: name === 'body' ? 512 : 64,
      castShadow: opts.castShadow ?? true,
    });
    batch.mesh.layers.enable(LAYER_REFLECT);
    batches.set(name, batch);
    group.add(batch.mesh);
  }

  const lots = new Map(); // id -> { slots: [{piece, index}], summary, sig, record, anim }
  const pool = createSpecPool();
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const tweens = new Set();
  const events = []; // {kind, x, z, size} for particles (dust puffs, completions)
  let byId = new Map();
  let indexedArray = null;
  let indexedLength = -1;
  let primed = false;
  let version = 0;
  let scanCursor = 0;
  let lastScan = 0;
  let time = 0;
  let selectedId = null;

  function reindex(list) {
    if (list === indexedArray && list.length === indexedLength) return;
    byId = new Map();
    for (const b of list) byId.set(b.id, b);
    indexedArray = list;
    indexedLength = list.length;
  }

  function writeLot(lot) {
    const summary = composeLot(lot.record, pool, lot.anim, lot.record.id === selectedId);
    lot.summary = summary;
    syncPads(lot, summary.pads);
    const n = pool.count();
    // Reuse slots whose piece matches, in order; release the rest.
    const old = lot.slots;
    const next = [];
    const used = new Array(old.length).fill(false);
    for (let i = 0; i < n; i++) {
      const spec = pool.at(i);
      let slot = null;
      for (let j = 0; j < old.length; j++) {
        if (!used[j] && old[j].piece === spec.piece) { used[j] = true; slot = old[j]; break; }
      }
      const batch = batches.get(spec.piece);
      if (!batch) continue; // unknown piece (warned at startup)
      if (!slot) slot = { piece: spec.piece, index: batch.alloc() };
      quat.setFromAxisAngle(yAxis, spec.yaw);
      pos.set(spec.x, spec.y, spec.z);
      scl.set(spec.sx, spec.sy, spec.sz);
      matrix.compose(pos, quat, scl);
      batch.write(slot.index, spec, matrix);
      next.push(slot);
    }
    for (let j = 0; j < old.length; j++) if (!used[j]) batches.get(old[j].piece).release(old[j].index);
    lot.slots = next;
    lights.markDirty();
  }

  /** Flatten the ground under this lot's walls (ids "<lot>:<n>"). */
  function syncPads(lot, pads) {
    if (!ground) return;
    const id = lot.record.id;
    for (let i = 0; i < pads.length; i++) ground.setPad(`${id}:${i}`, pads[i]);
    for (let i = pads.length; i < (lot.padCount ?? 0); i++) ground.removePad(`${id}:${i}`);
    lot.padCount = pads.length;
  }

  function addLot(record, animate) {
    const lot = { slots: [], summary: null, sig: signature(record), record, anim: null };
    lots.set(record.id, lot);
    if (animate && (record.built ?? 1) >= 1) {
      lot.anim = { grow: 0, settle: 1, scaffold: 0, t0: time, kind: 'grow' };
      tweens.add(lot);
    }
    writeLot(lot);
    version++;
    if (animate) events.push({ kind: 'dust', x: record.x, z: record.z, size: Math.max(record.w, record.d) });
  }

  function updateLot(lot, record) {
    const prevBuilt = lot.lastBuilt ?? 1;
    lot.record = record;
    lot.sig = signature(record);
    const built = record.built ?? 1;
    if (prevBuilt < 1 && built >= 1 && !lot.anim) {
      // Completed: scaffold folds away and the body settles.
      lot.anim = { grow: 1, settle: 1.04, scaffold: 1, t0: time, kind: 'complete' };
      tweens.add(lot);
      events.push({ kind: 'complete', x: record.x, z: record.z, size: Math.max(record.w, record.d) });
    }
    lot.lastBuilt = built;
    const footprintChanged = !lot.summary || lot.summary.x !== record.x || lot.summary.z !== record.z || lot.summary.w !== record.w || lot.summary.d !== record.d;
    writeLot(lot);
    if (footprintChanged) version++;
  }

  function removeLot(id) {
    const lot = lots.get(id);
    if (!lot || lot.anim?.kind === 'demolish') return;
    lot.anim = { grow: 1, settle: 1, scaffold: 0, t0: time, kind: 'demolish' };
    tweens.add(lot);
    events.push({ kind: 'dust', x: lot.record.x, z: lot.record.z, size: Math.max(lot.record.w, lot.record.d) * 1.4 });
  }

  function finishRemove(lot) {
    syncPads(lot, []);
    for (const s of lot.slots) batches.get(s.piece).release(s.index);
    lot.slots = [];
    lots.delete(lot.record.id);
    lights.markDirty();
    version++;
  }

  function stepTweens() {
    for (const lot of tweens) {
      const a = lot.anim;
      const t = time - a.t0;
      if (a.kind === 'grow') {
        const k = Math.min(1, t / 0.7);
        a.grow = Math.max(0.001, easeOutBack(k));
        if (k >= 1) { lot.anim = null; tweens.delete(lot); }
      } else if (a.kind === 'complete') {
        const k = Math.min(1, t / 0.5);
        a.scaffold = 1 - k;
        a.settle = 1 + 0.04 * (1 - easeOutBack(Math.min(1, t / 0.4)));
        if (k >= 1) { lot.anim = null; tweens.delete(lot); }
      } else if (a.kind === 'demolish') {
        const k = Math.min(1, t / 0.8);
        a.grow = Math.max(0.001, 1 - k * k);
        if (k >= 1) { tweens.delete(lot); finishRemove(lot); continue; }
      }
      writeLot(lot);
      lights.animateFor(0.3, time);
    }
  }

  /** Round-robin safety net: catch changes that arrived without an event. */
  function scan(list) {
    if (time - lastScan < 0.25 || !list.length) return;
    lastScan = time;
    const n = Math.min(list.length, 300);
    for (let i = 0; i < n; i++) {
      scanCursor = (scanCursor + 1) % list.length;
      const b = list[scanCursor];
      const lot = lots.get(b.id);
      if (!lot) { addLot(b, primed); continue; }
      if (lot.anim?.kind === 'demolish') continue;
      if (lot.record !== b || signature(b) !== lot.sig) updateLot(lot, b);
    }
  }

  function update(view, t) {
    time = t;
    const list = view.buildings ?? [];
    if (!primed) {
      for (const b of list) addLot(b, false);
      for (const lot of lots.values()) lot.lastBuilt = lot.record.built ?? 1;
      if (view.buildingEvents) view.buildingEvents.length = 0;
      primed = true;
    }
    const evs = view.buildingEvents;
    if (evs && evs.length) {
      reindex(list);
      // Rebuild the index when records were added since the last sync.
      if (evs.some((e) => e.kind === 'add' && !byId.has(e.id))) { indexedArray = null; reindex(list); }
      for (const e of evs) {
        if (e.kind === 'remove') { removeLot(e.id); continue; }
        const rec = byId.get(e.id);
        if (!rec) continue;
        const lot = lots.get(e.id);
        if (!lot) addLot(rec, true);
        else if (lot.anim?.kind !== 'demolish') updateLot(lot, rec);
      }
      evs.length = 0;
    }
    // Lots that vanished from the list without a remove event.
    if (list.length < lots.size - tweensDemolishing()) {
      reindex(list);
      for (const [id, lot] of lots) if (!byId.has(id) && lot.anim?.kind !== 'demolish') removeLot(id);
    }
    scan(list);
    stepTweens();
    for (const b of batches.values()) b.flush();
  }

  function tweensDemolishing() {
    let n = 0;
    for (const l of tweens) if (l.anim?.kind === 'demolish') n++;
    return n;
  }

  /** Detail culling distance follows the quality tier. */
  function applyQuality(q) {
    kitUniforms.uDetailDist.value = q.name === 'low' ? 150 : q.name === 'medium' ? 220 : 300;
  }

  /** Highlight one lot (or none): its instances are rewritten with a flag. */
  function setSelected(id) {
    if (id === selectedId) return;
    const prev = lots.get(selectedId);
    selectedId = id ?? null;
    if (prev) writeLot(prev);
    const next = lots.get(selectedId);
    if (next) writeLot(next);
    for (const b of batches.values()) b.flush();
  }

  return {
    group,
    update,
    applyQuality,
    setSelected,
    lots,
    events,
    version: () => version,
    batches,
    instanceCount() {
      let n = 0;
      for (const b of batches.values()) n += b.live();
      return n;
    },
  };
}

/** Pack aPart and aAO into one vec2 attribute to stay under 16 vertex attributes. */
function interleavePartAO(geometry) {
  const part = geometry.getAttribute('aPart');
  const ao = geometry.getAttribute('aAO');
  const out = new Float32Array(part.count * 2);
  for (let i = 0; i < part.count; i++) {
    out[i * 2] = part.getX(i);
    out[i * 2 + 1] = ao.getX(i);
  }
  return new THREE.BufferAttribute(out, 2);
}
