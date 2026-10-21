// The render view across a thread boundary (docs/design/sim-worker.md §4.3).
//
// In the sim worker, createMirrorSource() turns the render view after each sync into a
// delta: the walker rows written, the building records that changed, the road cells that
// changed, and the small per-step fields. On the main thread, createRenderMirror()
// applies those deltas to an object with exactly the shape createRenderView returns, so
// src/render reads it as it reads the live view.
//
//   worker:  const source = createMirrorSource();
//            view.sync(state, {now, speed});
//            const {delta, transfer} = source.delta(view, state);
//            postMessage({delta}, transfer);
//   main:    const mirror = createRenderMirror({rowFloats: 20});
//            mirror.apply(delta);  world.update(mirror.view, ...)
//
// Identity is part of that shape. The renderer notices change by object identity
// (lot.record !== b, a new buildings array, a new roads object or roads.tier, a new
// people buffer), so the mirror replaces an object exactly when the worker's object was
// replaced, and patches it in place otherwise. Otherwise a renderer subsystem would
// rebuild every frame: slow, not wrong, and easy to miss.
//
// The source takes over the consumer's side of the view's handshakes: it reads and clears
// view.peopleDirty and view.buildingEvents, and the sim's own roads.dirty (the renderer
// clears it today). On the mirror they are the union of what arrived since the renderer
// last cleared them.
//
// Changes that nobody announced still arrive: road grids are compared with a copy of what
// was last sent, and a round-robin slice of building records is compared field for field.

// The road grids the renderer reads (one cell each, ROAD_GRID² cells).
const GRIDS = ['wear', 'tier', 'planned', 'low'];
const EVENTS_CAP = 50000;   // as render-view: a consumer that never reads must not grow this forever

export function createMirrorSource({scanShare = 60} = {}) {
  let first = true;
  let peopleCap = -1;
  // What was last sent, by identity, and copies to compare against.
  const ref = {buildings: null, roads: null, embanked: null, bridges: null, embankments: null, attention: null, centres: null, aesthetics: null, landscape: null, weather: null, worldEvents: null};
  const grids = {};          // grid name -> the sim's array last sent
  const shadow = {};         // grid name -> a copy of it as the mirror has it
  let roadsVersion = -1;
  const recRefs = new Map(); // building id -> the record object last sent
  const recSigs = new Map(); // building id -> its JSON as last sent
  let scanCursor = 0;
  let aestheticsRev = null, landscapeRev = null, landscapeYear = null;
  const json = {weather: '', worldEvents: ''};

  function delta(view, state) {
    const transfer = [];
    const out = {
      people: people(view, transfer),
      buildings: buildings(view, state),
      roads: roads(state, transfer),
      fields: fields(view),
    };
    first = false;
    return {delta: out, transfer};
  }

  // Walker rows written since the last delta, as transferred copies.
  function people(view, transfer) {
    const stride = view.rowFloats;
    const cap = view.people.length / stride;
    const out = {count: view.peopleCount, cap, stride};
    const d = view.peopleDirty;
    if (d && d.end > d.start) {
      out.start = d.start;
      out.end = d.end;
      out.rows = view.people.slice(d.start * stride, d.end * stride);
      out.ids = view.peopleIds.slice(d.start, d.end);
      transfer.push(out.rows.buffer, out.ids.buffer);
    }
    if (cap !== peopleCap && !d) {
      // A new buffer always comes with every row dirty (render-view grow); this is
      // only a guard for a view that grew without writing.
      out.start = 0;
      out.end = view.peopleCount;
      out.rows = view.people.slice(0, view.peopleCount * stride);
      out.ids = view.peopleIds.slice(0, view.peopleCount);
      transfer.push(out.rows.buffer, out.ids.buffer);
    }
    peopleCap = cap;
    view.peopleDirty = null;
    return out;
  }

  function buildings(view, state) {
    const list = state.buildings;
    const n = list.length;
    const out = {};
    const events = view.buildingEvents.length ? view.buildingEvents.slice() : null;
    view.buildingEvents.length = 0;
    const changed = new Set();
    let order = first || list !== ref.buildings || n !== recRefs.size;
    if (events) {
      for (const e of events) {
        if (e.kind !== 'update') order = true;
        if (e.kind !== 'remove') changed.add(e.id);
      }
    }
    for (const b of list) {
      const was = recRefs.get(b.id);
      if (was === b) continue;
      changed.add(b.id);
      if (was) order = true;   // a record object replaced in place: its slot in the list changes
    }
    // A slice of the rest, compared field for field: changes no event announced.
    if (n && !first) {
      const k = Math.min(n, Math.max(16, Math.ceil(n / scanShare)));
      for (let i = 0; i < k; i++) {
        if (scanCursor >= n) scanCursor = 0;
        const b = list[scanCursor++];
        if (!changed.has(b.id) && recSigs.get(b.id) !== JSON.stringify(plainRecord(b))) changed.add(b.id);
      }
    }
    if (changed.size) {
      out.records = [];
      for (const b of list) {
        if (!changed.has(b.id)) continue;
        const fresh = recRefs.get(b.id) !== b;
        const rec = plainRecord(b);
        recRefs.set(b.id, b);
        recSigs.set(b.id, JSON.stringify(rec));
        out.records.push(fresh ? {rec, fresh: true} : {rec});
      }
    }
    if (order) {
      out.order = list.map((b) => b.id);
      out.newList = list !== ref.buildings;
      ref.buildings = list;
      if (recRefs.size > n) {
        const live = new Set(out.order);
        for (const id of recRefs.keys()) {
          if (!live.has(id)) { recRefs.delete(id); recSigs.delete(id); }
        }
      }
    }
    if (events) out.events = events;
    return out;
  }

  function roads(state, transfer) {
    const r = state.roads;
    const out = {scalars: scalarsOf(r)};
    const dirty = r.dirty;
    if (first || r !== ref.roads) {
      ref.roads = r;
      out.fresh = true;
      out.grids = {};
      for (const k of GRIDS) {
        if (!r[k]) continue;
        grids[k] = r[k];
        shadow[k] = r[k].slice();
        out.grids[k] = r[k].slice();
        transfer.push(out.grids[k].buffer);
      }
      ref.embanked = r.embanked ?? null;
      shadow.embanked = r.embanked ? r.embanked.slice() : null;
      out.embanked = shadow.embanked ? shadow.embanked.slice() : null;
    } else {
      // Tier, plan and the low flags change only with roads.version or a dirty cell;
      // wear changes every tick, often without marking a cell.
      const structural = r.version !== roadsVersion || dirty != null;
      for (const k of GRIDS) {
        const a = r[k];
        if (!a) continue;
        if (a !== grids[k]) {
          grids[k] = a;
          shadow[k] = a.slice();
          (out.replace ??= {})[k] = a.slice();
          transfer.push(out.replace[k].buffer);
          continue;
        }
        if (k !== 'wear' && !structural) continue;
        const rect = changedRect(a, shadow[k], r.W, r.H);
        if (!rect) continue;
        const data = copyRect(a, shadow[k], r.W, rect);
        (out.patches ??= []).push({k, ...rect, data});
        transfer.push(data.buffer);
      }
      const e = r.embanked;
      if (e !== ref.embanked) {
        ref.embanked = e ?? null;
        shadow.embanked = e ? e.slice() : null;
        out.embankedNew = true;
        out.embanked = shadow.embanked ? shadow.embanked.slice() : null;
      } else if (e && !sameArray(e, shadow.embanked)) {
        shadow.embanked.set(e);
        out.embanked = e.slice();
      }
    }
    roadsVersion = r.version;
    if (dirty) out.dirty = {x0: dirty.x0, z0: dirty.z0, x1: dirty.x1, z1: dirty.z1};
    r.dirty = null;
    return out;
  }

  function fields(view) {
    const out = {time: view.time, projects: view.projects, era: view.era, styleEra: view.styleEra, archetype: view.archetype};
    // Replaced by render-view whenever they change.
    for (const k of ['bridges', 'attention', 'centres']) {
      if (first || view[k] !== ref[k]) { ref[k] = view[k]; out[k] = view[k]; }
    }
    // Lamps are rebuilt in place in the same branch that replaces embankments.
    if (first || view.embankments !== ref.embankments) {
      ref.embankments = view.embankments;
      out.embankments = view.embankments;
      out.lamps = view.lamps;
    }
    // Live sim objects: replaced when the sim replaced them, patched when they changed.
    for (const k of ['weather', 'worldEvents']) {
      const v = view[k] ?? null;
      const s = JSON.stringify(v);
      if (first || v !== ref[k]) { ref[k] = v; json[k] = s; out[k] = {value: v, replace: true}; }
      else if (s !== json[k]) { json[k] = s; out[k] = {value: v}; }
    }
    const a = view.aesthetics ?? null;
    if (first || a !== ref.aesthetics || (a?.rev ?? null) !== aestheticsRev) {
      out.aesthetics = {value: a, replace: first || a !== ref.aesthetics};
      ref.aesthetics = a;
      aestheticsRev = a?.rev ?? null;
    }
    const L = view.landscape ?? null;
    if (first || L !== ref.landscape || (L?.rev ?? null) !== landscapeRev || (L?.year ?? null) !== landscapeYear) {
      out.landscape = {value: L, replace: first || L !== ref.landscape};
      ref.landscape = L;
      landscapeRev = L?.rev ?? null;
      landscapeYear = L?.year ?? null;
    }
    return out;
  }

  return {delta};
}

export function createRenderMirror({rowFloats = 20} = {}) {
  const view = {
    people: new Float32Array(0),
    peopleCount: 0,
    peopleDirty: null,
    peopleVersion: 0,
    peopleIds: new Int32Array(0),
    buildings: [],
    buildingEvents: [],
    roads: null,
    bridges: [],
    lamps: [],
    embankments: [],
    attention: [],
    centres: [],
    projects: [],
    worldEvents: [],
    weather: {},
    time: {year: 0, month: 0, season: 0, seasonT: 0, yearT: 0, monthT: 0},
    era: 0,
    styleEra: 0,
    archetype: null,
    rowFloats,
    aesthetics: null,
    landscape: null,
  };
  const recs = new Map();   // building id -> the mirror's record

  function applyPeople(p) {
    const stride = view.rowFloats;
    if (p.cap * stride !== view.people.length) {
      const people = new Float32Array(p.cap * stride);
      people.set(view.people.subarray(0, Math.min(view.people.length, people.length)));
      const ids = new Int32Array(p.cap).fill(-1);
      ids.set(view.peopleIds.subarray(0, Math.min(view.peopleIds.length, p.cap)));
      view.people = people;
      view.peopleIds = ids;
      view.peopleVersion++;
    }
    if (p.rows) {
      view.people.set(p.rows, p.start * stride);
      view.peopleIds.set(p.ids, p.start);
      const d = view.peopleDirty;
      if (d) {
        if (p.start < d.start) d.start = p.start;
        if (p.end > d.end) d.end = p.end;
      } else view.peopleDirty = {start: p.start, end: p.end};
    }
    view.peopleCount = p.count;
  }

  function applyBuildings(b) {
    for (const {rec, fresh} of b.records ?? []) {
      const cur = recs.get(rec.id);
      if (!cur || fresh) { recs.set(rec.id, rec); continue; }
      for (const k of Object.keys(cur)) if (!(k in rec)) delete cur[k];
      Object.assign(cur, rec);
    }
    if (b.order) {
      const list = b.newList ? [] : view.buildings;
      list.length = 0;
      for (const id of b.order) {
        const r = recs.get(id);
        if (r) list.push(r);
      }
      if (recs.size > list.length) {
        const live = new Set(b.order);
        for (const id of recs.keys()) if (!live.has(id)) recs.delete(id);
      }
      view.buildings = list;
    }
    if (b.events) {
      if (view.buildingEvents.length > EVENTS_CAP) view.buildingEvents.length = 0;
      for (const e of b.events) view.buildingEvents.push(e);
    }
  }

  function applyRoads(d) {
    if (d.fresh) {
      view.roads = {...d.scalars, ...d.grids, embanked: d.embanked ?? null, dirty: d.dirty ?? null};
      return;
    }
    const r = view.roads;
    Object.assign(r, d.scalars);
    for (const [k, a] of Object.entries(d.replace ?? {})) r[k] = a;
    for (const p of d.patches ?? []) {
      const a = r[p.k], w = p.x1 - p.x0 + 1;
      for (let z = p.z0, o = 0; z <= p.z1; z++, o += w) a.set(p.data.subarray(o, o + w), z * r.W + p.x0);
    }
    if (d.embankedNew) r.embanked = d.embanked;
    else if (d.embanked) r.embanked.set(d.embanked);
    if (d.dirty) {
      const x = r.dirty;
      if (!x) r.dirty = d.dirty;
      else {
        if (d.dirty.x0 < x.x0) x.x0 = d.dirty.x0;
        if (d.dirty.z0 < x.z0) x.z0 = d.dirty.z0;
        if (d.dirty.x1 > x.x1) x.x1 = d.dirty.x1;
        if (d.dirty.z1 > x.z1) x.z1 = d.dirty.z1;
      }
    }
  }

  function applyFields(f) {
    Object.assign(view.time, f.time);
    const rows = view.projects;
    for (let i = 0; i < f.projects.length; i++) {
      if (rows[i]) Object.assign(rows[i], f.projects[i]);
      else rows[i] = f.projects[i];
    }
    rows.length = f.projects.length;
    view.era = f.era;
    view.styleEra = f.styleEra;
    view.archetype = f.archetype;
    for (const k of ['bridges', 'attention', 'centres', 'embankments']) if (k in f) view[k] = f[k];
    if (f.lamps) {
      view.lamps.length = 0;
      for (const l of f.lamps) view.lamps.push(l);
    }
    for (const k of ['weather', 'worldEvents', 'aesthetics']) {
      if (!f[k]) continue;
      if (f[k].replace || !view[k] || !f[k].value) view[k] = f[k].value;
      else patchInPlace(view[k], f[k].value);
    }
    if (f.landscape) {
      const L = f.landscape.value;
      const cur = view.landscape;
      if (f.landscape.replace || !cur || !L || !cur.level || cur.level.length !== L.level?.length) view.landscape = L;
      else {
        const level = cur.level;
        level.set(L.level);
        for (const k of Object.keys(cur)) if (!(k in L)) delete cur[k];
        Object.assign(cur, L, {level});
      }
    }
  }

  return {
    view,
    apply(delta) {
      applyPeople(delta.people);
      applyBuildings(delta.buildings);
      applyRoads(delta.roads);
      applyFields(delta.fields);
      return view;
    },
  };
}

// A building record as sent: own fields without the sim's transient `_` caches.
function plainRecord(b) {
  const out = {};
  for (const k in b) if (k[0] !== '_') out[k] = b[k];
  return out;
}

// The roads object's own numbers, strings and flags (version, embankRev, the grid's
// size and origin, ...); grids and tables go separately or not at all.
function scalarsOf(r) {
  const out = {};
  for (const k in r) {
    const v = r[k];
    if (k === 'dirty' || (v !== null && typeof v === 'object')) continue;
    out[k] = v;
  }
  return out;
}

// The bounding rectangle (cells, inclusive) of every cell where a differs from s.
function changedRect(a, s, W, H) {
  let x0 = W, x1 = -1, z0 = -1, z1 = -1;
  for (let z = 0, i = 0; z < H; z++) {
    let hit = false;
    for (let x = 0; x < W; x++, i++) {
      if (a[i] !== s[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        hit = true;
      }
    }
    if (hit) {
      if (z0 < 0) z0 = z;
      z1 = z;
    }
  }
  return x1 < 0 ? null : {x0, z0, x1, z1};
}

// Copies a's cells in rect into a new array (rows of the rect), and into s.
function copyRect(a, s, W, {x0, z0, x1, z1}) {
  const w = x1 - x0 + 1;
  const out = new a.constructor(w * (z1 - z0 + 1));
  for (let z = z0, o = 0; z <= z1; z++, o += w) {
    const row = a.subarray(z * W + x0, z * W + x0 + w);
    out.set(row, o);
    s.set(row, z * W + x0);
  }
  return out;
}

function sameArray(a, b) {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Makes target hold value's contents while keeping target's identity.
function patchInPlace(target, value) {
  if (Array.isArray(target)) {
    target.length = 0;
    for (const v of value) target.push(v);
    return;
  }
  for (const k of Object.keys(target)) if (!(k in value)) delete target[k];
  Object.assign(target, value);
}
