// The main menu: the first thing a player sees. Continue the last town, found
// a new one in a valley of their choosing, open or manage the towns kept on
// this device, and change settings before playing.
//
// It runs before the simulation and the renderer are loaded (main.js loads
// them meanwhile), so it imports only light modules: the save store, prefs,
// seeds and the valley map's worker.
//
//   const menu = createMainMenu({saves, prefs});
//   const choice = await menu.choose();   // {kind: 'continue'|'load', id} | {kind: 'new', ...}
//   menu.busy('Opening Millbrook…');      // while main.js builds the town
//   menu.fail('That town cannot be opened.'); then choose() again
//   menu.close();                         // fades out over the running game

import '../tokens.css';
import '../layout.css';
import '../components.css';
import './menu.css';
import {esc} from '../dom.js';
import {icon, mountSprite} from '../icons.js';
import {ERA_NAMES, num} from '../format.js';
import {newSeed, parseSeed, seedCode} from '../../seed.js';
import {archetypeOf} from '../../waters.js';
import {metaFromSave} from '../../save-store.js';
import {createValleyMap} from './valley-map.js';
import {suggestName} from './names.js';
import {createCloudTowns} from './cloud-towns.js';


// Valleys a player can ask for. 'seed' lets the seed decide; 'classic' is the
// river-only valley every town had before lakes and the sea (terrain version 1).
export const LANDSCAPES = [
  {id: 'seed', label: 'Seed decides', hint: 'The seed picks the land and its water.'},
  {id: 'river', label: 'River', hint: 'A river winds through the valley, with fords to wade.'},
  {id: 'lake', label: 'Lake', hint: 'The river runs through a lake on its way down the valley.'},
  {id: 'greatlake', label: 'Great lake', hint: 'A wide lake fills one side of the valley.'},
  {id: 'delta', label: 'Delta', hint: 'The river splits into shallow creeks before the sea.'},
  {id: 'coast', label: 'Coast', hint: 'The river runs out to the sea.'},
  {id: 'shore', label: 'Shore', hint: 'No river. The town grows along the sea shore.'},
  {id: 'dry', label: 'Dry plain', hint: 'No river and no sea. Open land and hills.'},
  {id: 'classic', label: 'River only', hint: 'The river and hills alone, as every valley was before lakes and the sea.'},
];
const LANDSCAPE_NAMES = {river: 'River valley', lake: 'Lake valley', greatlake: 'Great lake', delta: 'Delta', coast: 'Coast', shore: 'Shore', dry: 'Dry plain'};

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
};

/** "A town of 783 people." */
export function townLine(meta) {
  const era = (ERA_NAMES[meta.era ?? 0] ?? 'Hamlet').toLowerCase();
  const people = meta.people ?? 0;
  return `A ${era} of ${num(people)} ${people === 1 ? 'person' : 'people'}.`;
}

export function valleyName(meta) {
  if (!Number.isFinite(meta.seed)) return 'The first valley';
  if ((meta.terrain ?? 2) < 2) return 'River only';
  return LANDSCAPE_NAMES[meta.archetype ?? archetypeOf(meta.seed)] ?? 'River valley';
}

function playedWhen(t) {
  if (!t) return '';
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(t)) / 86400000);
  if (days <= 0) return 'Played today';
  if (days === 1) return 'Played yesterday';
  if (days < 7) return `Played ${days} days ago`;
  return `Played on ${new Date(t).toLocaleDateString(undefined, {day: 'numeric', month: 'long'})}`;
}
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileName = (meta) => `${String(meta.name || 'hearthvale').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-year-${meta.year ?? 0}.json`;

export function createMainMenu({saves, cloud, prefs, start = 'title', openAccount}) {
  mountSprite();
  applyLook(prefs);
  const darkMedia = matchMedia('(prefers-color-scheme: dark)');
  const onDark = () => { applyLook(prefs); map?.redraw(); };
  darkMedia.addEventListener?.('change', onDark);

  const root = document.createElement('div');
  root.className = 'mm';
  root.dataset.screen = 'title';
  root.innerHTML = `
    <div class="mm-view">
      <div class="mm-backdrop"><img alt="" decoding="async"></div>
      <figure class="mm-sheet" aria-label="Map of the valley">
        <canvas class="mm-map" role="img" aria-label="Map of the valley"></canvas>
        <figcaption class="mm-cartouche"><span class="mm-cart-name"></span><span class="mm-cart-sub"></span></figcaption>
      </figure>
      <div class="mm-picture" hidden><img alt=""></div>
    </div>
    <main class="mm-page" aria-label="Hearthvale">
      <header class="mm-head">
        <button type="button" class="mm-back btn btn-ghost" data-go="title">${icon('chevron-left')}Back</button>
        <h1 class="mm-word">Hearthvale</h1>
        <p class="mm-tagline">A town that grows into a city over 150 years, and remembers every choice you made along the way.</p>
      </header>
      <div class="mm-body"></div>
      ${openAccount ? '<footer class="mm-foot"><button type="button" class="btn btn-ghost mm-account" data-act="account">Sign in</button><span class="mm-account-tier" hidden></span></footer>' : ''}
    </main>
    <p class="mm-status" role="status" aria-live="polite"></p>`;
  document.body.append(root);

  const body = root.querySelector('.mm-body');
  const status = root.querySelector('.mm-status');
  const backdrop = root.querySelector('.mm-backdrop img');
  const picture = root.querySelector('.mm-picture');
  let map = null;
  let towns = [];
  let latest = null;
  let resolveChoice = null;
  let selected = null;     // the town picked on the Manage Towns screen
  let cloudPanel = null;
  let confirmDelete = null;
  const urls = new Set();
  const objectUrl = (blob) => { const u = URL.createObjectURL(blob); urls.add(u); return u; };

  // The new-town form keeps its choices while the player moves between screens.
  const form = {
    name: suggestName('seed'),
    seedText: seedCode(newSeed()),
    landscape: 'seed',
    found: null,   // what the map found for this seed: {archetype, river}
  };

  function say(text, kind = '') {
    status.textContent = text;
    status.dataset.kind = kind;
    status.classList.toggle('show', !!text);
  }

  // ---------- backdrop ----------
  function setBackdrop() {
    const thumb = latest?.thumb;
    const src = thumb instanceof Blob ? objectUrl(thumb) : '/menu/hero.jpg';
    if (backdrop.getAttribute('src') === src) return;
    backdrop.classList.remove('in');
    backdrop.onload = () => backdrop.classList.add('in');
    backdrop.src = src;
  }

  // ---------- screens ----------
  const parentScreen = {play: 'title', new: 'play', towns: 'play', settings: 'title', about: 'title'};
  const screens = {title: renderTitle, play: renderPlay, new: renderNew, towns: renderTowns, settings: renderSettings, about: renderAbout};

  function go(screen, {focus = true} = {}) {
    if (!screens[screen]) return;
    cloudPanel?.destroy();cloudPanel=null;
    root.dataset.screen = screen;
    root.querySelector('.mm-back').dataset.go = parentScreen[screen] ?? 'title';
    confirmDelete = null;
    say('');
    body.innerHTML = '';
    screens[screen]();
    picture.hidden = screen !== 'towns' || !selected?.thumb;
    if (focus) requestAnimationFrame(() => (body.querySelector('[data-autofocus]') ?? body.querySelector('h2') ?? body.querySelector('button'))?.focus({preventScroll: true}));
  }

  function menuList(items, label) {
    return `<nav aria-label="${label}"><ul class="mm-list">${items.map((it, i) => `
      <li><button type="button" class="mm-item ${it.cls ?? ''}" data-go="${it.go}"${i === 0 ? ' data-autofocus' : ''}>
        <span class="mm-item-label">${esc(it.label)}</span>
        <span class="mm-item-sub">${esc(it.sub)}</span>
      </button></li>`).join('')}</ul></nav>`;
  }

  function renderTitle() {
    body.innerHTML = menuList([
      {go: 'play', label: 'Play', sub: 'Continue a town, or find a new valley.'},
      {go: 'settings', label: 'Settings', sub: 'Sound, display and reading.'},
      {go: 'about', label: 'About', sub: 'What Hearthvale is, and how to play.'},
    ], 'Main menu');
  }

  function renderPlay() {
    const items = [];
    if (latest) items.push({go: 'continue', label: 'Continue', sub: `${latest.name || 'Hearthvale'}, year ${latest.year ?? 0}. ${townLine(latest)}`, cls: 'mm-continue'});
    items.push({go: 'new', label: 'New town', sub: 'Choose a valley and begin with seven families.'});
    items.push({go: 'towns', label: 'Manage Towns', sub: towns.length ? `${towns.length} ${towns.length === 1 ? 'town' : 'towns'} on this device.` : 'Find and manage the towns saved on this device.'});
    body.innerHTML = `<section class="mm-screen" aria-labelledby="mm-play-title"><h2 id="mm-play-title" tabindex="-1">Play</h2>${menuList(items, 'Play')}</section>`;
  }

  function renderNew() {
    body.innerHTML = `
      <section class="mm-screen" aria-labelledby="mm-new-title">
        <h2 id="mm-new-title" tabindex="-1">A new town</h2>
        <p class="mm-lede">Seven families, a few huts and a place to cross the water. You choose the valley. They choose everything else.</p>
        <div class="mm-field">
          <label for="mm-name">Name</label>
          <span class="mm-input-row">
            <input id="mm-name" name="name" maxlength="24" autocomplete="off" spellcheck="false" value="${esc(form.name)}" data-autofocus>
            <button type="button" class="icon-btn" data-act="name-roll" aria-label="Suggest another name" title="Suggest another name">${icon('refresh')}</button>
          </span>
        </div>
        <div class="mm-field">
          <label for="mm-seed">Valley seed<small>A code, a number or any word. The same seed always grows the same valley.</small></label>
          <span class="mm-input-row">
            <input id="mm-seed" name="seed" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(form.seedText)}">
            <button type="button" class="icon-btn" data-act="seed-roll" aria-label="Roll a new valley" title="Roll a new valley">${icon('refresh')}</button>
          </span>
        </div>
        <fieldset class="mm-field">
          <legend>Landscape</legend>
          <div class="mm-chips" role="radiogroup" aria-label="Landscape">${LANDSCAPES.map((l) => `<button type="button" role="radio" class="mm-chip" data-landscape="${l.id}" aria-checked="${l.id === form.landscape}" tabindex="${l.id === form.landscape ? 0 : -1}">${esc(l.label)}</button>`).join('')}</div>
          <p class="mm-hint" data-hint="landscape"></p>
        </fieldset>
        <div class="mm-actions">
          <button type="button" class="btn btn-primary mm-found" data-act="found"></button>
        </div>
      </section>`;
    syncNew();
    drawValley();
  }

  function seedValue() {
    const text = form.seedText.trim();
    return text ? parseSeed(text) : parseSeed(seedCode(newSeed()));
  }

  function terrainChoice() {
    if (form.landscape === 'classic') return {version: 1, archetype: null};
    return {version: 2, archetype: form.landscape === 'seed' ? null : form.landscape};
  }

  function syncNew() {
    const found = body.querySelector('[data-act="found"]');
    if (found) found.textContent = `Found ${form.name.trim() || 'the town'}`;
    const l = LANDSCAPES.find((x) => x.id === form.landscape) ?? LANDSCAPES[0];
    const hint = body.querySelector('[data-hint="landscape"]');
    if (hint) {
      const picked = form.landscape === 'seed' && form.found ? ` This one is ${(LANDSCAPE_NAMES[form.found.archetype] ?? 'a river valley').toLowerCase()}.` : '';
      hint.textContent = l.hint + picked;
    }
    root.querySelector('.mm-cart-name').textContent = form.name.trim() || 'A new town';
    const seed = seedValue();
    const kind = form.landscape === 'classic' ? 'River only' : LANDSCAPE_NAMES[form.landscape === 'seed' ? form.found?.archetype ?? archetypeOf(seed) : form.landscape];
    root.querySelector('.mm-cart-sub').textContent = `${kind ?? 'River valley'}, seed ${seedCode(seed)}`;
  }

  let drawTimer = 0;
  function drawValley(delay = 0) {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(async () => {
      map ??= createValleyMap(root.querySelector('.mm-map'));
      const {version, archetype} = terrainChoice();
      const found = await map.show({seed: seedValue(), version, archetype});
      if (found) { form.found = found; syncNew(); }
    }, delay);
  }

  // Cloud backup adds icons, placeholder rows and a few buttons to this screen.
  function mountCloud() {
    if (!cloud) return;
    cloudPanel?.destroy();
    cloudPanel = createCloudTowns({cloud, say, play: (id) => pick({kind: 'cloud', id}),
      changed: () => refreshTowns(), update: () => refreshTownList()});
  }

  // Towns on this device, then cloud towns that are not.
  const allTowns = () => [...towns, ...(cloudPanel?.entries(towns) ?? [])];
  const townRows = () => allTowns().map((t) => t.cloudOnly ? cloudPanel.row(t, t.id === selected?.id) : townRow(t)).join('');
  function keepSelection(all = allTowns()) {
    selected = all.find((t) => t.id === selected?.id) ?? all[0] ?? null;
  }

  function renderTowns() {
    if (!cloudPanel) mountCloud();
    const importer = `<div class="mm-actions"><button type="button" class="btn btn-secondary" data-act="import">${icon('upload')}Import town</button><input type="file" accept="application/json,.json" data-act="import-file" hidden></div>`;
    const all = allTowns();
    if (!all.length) {
      body.innerHTML = `<section class="mm-screen" aria-labelledby="mm-towns-title"><h2 id="mm-towns-title" tabindex="-1">Manage Towns</h2>
        <p class="mm-lede">No towns on this device yet. Start a new town or import one from another device.</p>
        <div class="mm-actions"><button type="button" class="btn btn-primary" data-go="new" data-autofocus>New town</button></div>${importer}</section>`;
      return;
    }
    keepSelection(all);
    body.innerHTML = `<section class="mm-screen" aria-labelledby="mm-towns-title">
      <h2 id="mm-towns-title" tabindex="-1">Manage Towns</h2>
      <ul class="mm-towns" role="listbox" aria-labelledby="mm-towns-title">${townRows()}</ul>
      <div class="mm-town-actions"></div>
      ${importer}
    </section>`;
    syncTownActions();
    showPicture();
  }

  // Cloud state changed: redraw the rows and actions, keeping focus and selection.
  function refreshTownList() {
    if (root.dataset.screen !== 'towns' || body.querySelector('.mm-rename')) return;
    const list = body.querySelector('.mm-towns');
    const all = allTowns();
    if (!list || !all.length) return all.length || list ? renderTowns() : undefined;
    keepSelection(all);
    const focused = document.activeElement?.closest?.('.mm-town')?.dataset.town;
    list.innerHTML = townRows();
    if (focused) list.querySelector(`[data-town="${CSS.escape(focused)}"]`)?.focus({preventScroll: true});
    syncTownActions();
    showPicture();
  }

  function townRow(t) {
    const on = t.id === selected?.id;
    const thumb = t.thumb instanceof Blob ? `<img src="${objectUrl(t.thumb)}" alt="">` : `<span class="mm-thumb-blank">${icon('moot')}</span>`;
    return `<li role="option" class="mm-town" data-town="${esc(t.id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">
      <span class="mm-thumb">${thumb}</span>
      <span class="mm-town-text">
        <span class="mm-town-name">${esc(t.name || 'Hearthvale')}</span>
        <span class="mm-town-line">Year ${t.year ?? 0}. ${esc(townLine(t))}</span>
        <span class="mm-town-meta">${esc(valleyName(t))}. ${esc(playedWhen(t.savedAt))}.</span>
      </span>
      ${cloudPanel?.badge(t) ?? ''}
    </li>`;
  }

  function syncTownActions() {
    const box = body.querySelector('.mm-town-actions');
    if (!box || !selected) return;
    if (selected.cloudOnly) {
      box.innerHTML = `<div class="btn-row">${cloudPanel?.buttons(selected) ?? ''}</div>${cloudPanel?.notice(selected) ?? ''}`;
      return;
    }
    const name = esc(selected.name || 'Hearthvale');
    box.innerHTML = confirmDelete === selected.id
      ? `<p class="mm-confirm" role="alert">Delete ${name} from this device? This cannot be undone. Export it first to keep a copy.</p>
         <div class="btn-row"><button type="button" class="btn btn-ghost" data-act="keep">Keep it</button><button type="button" class="btn btn-secondary" data-act="export">${icon('save')}Export</button><button type="button" class="btn btn-primary btn-start" data-act="delete-yes">Delete ${name}</button></div>`
      : `<div class="btn-row">
          <button type="button" class="btn btn-primary" data-act="play">${icon('play')}Play ${name}</button>
          <button type="button" class="btn btn-secondary" data-act="rename">Rename</button>
          <button type="button" class="btn btn-secondary" data-act="export">${icon('save')}Export</button>
          ${cloudPanel?.buttons(selected) ?? ''}
          <button type="button" class="btn btn-ghost btn-danger" data-act="delete">Delete</button>
        </div>${cloudPanel?.notice(selected) ?? ''}`;
  }

  function showPicture() {
    const img = picture.querySelector('img');
    if (selected?.thumb instanceof Blob) {
      img.src = objectUrl(selected.thumb);
      picture.hidden = false;
    } else picture.hidden = true;
  }

  function selectTown(id, focus) {
    const next = allTowns().find((t) => t.id === id) ?? selected;
    if (next?.id !== selected?.id) cloudPanel?.reset();
    selected = next;
    confirmDelete = null;
    for (const row of body.querySelectorAll('.mm-town')) {
      const on = row.dataset.town === selected.id;
      row.setAttribute('aria-selected', String(on));
      row.tabIndex = on ? 0 : -1;
      if (on && focus) row.focus();
    }
    syncTownActions();
    showPicture();
  }

  function renderSettings() {
    const p = prefs.all();
    const seg = (pref, value, options) => `<div class="seg" role="radiogroup" data-pref="${pref}">${options.map(([v, label]) => `<button type="button" role="radio" data-value="${v}" aria-checked="${v === value}" aria-pressed="${v === value}">${esc(label)}</button>`).join('')}</div>`;
    const row = (label, hint, control, id) => `<div class="mm-field mm-set"><span${id ? ` id="${id}"` : ''}>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>${control}</div>`;
    body.innerHTML = `<section class="mm-screen" aria-labelledby="mm-set-title">
      <h2 id="mm-set-title" tabindex="-1">Settings</h2>
      <p class="mm-lede">More settings wait in the game, under the gear at the top right.</p>
      ${row('Sound', null, `<button type="button" class="switch" role="switch" data-act="sound" aria-checked="${!p.muted}" aria-labelledby="mm-sound-label"></button>`, 'mm-sound-label')}
      ${row('Volume', null, `<input type="range" min="0" max="1" step="0.05" value="${p.master}" data-range="master" aria-label="Volume">`)}
      ${row('Detail', 'Auto picks what this device can draw smoothly.', seg('quality', p.quality, [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]))}
      ${row('Theme', null, seg('theme', p.theme, [['auto', 'Auto'], ['light', 'Light'], ['night', 'Night']]))}
      ${row('Motion', 'Reduced turns off slides and camera moves.', seg('motion', p.motion, [['full', 'Full'], ['reduced', 'Reduced']]))}
      ${row('Text size', null, seg('textSize', p.textSize, [['normal', 'Normal'], ['large', 'Large']]))}
    </section>`;
  }

  function renderAbout() {
    body.innerHTML = `<section class="mm-screen mm-prose" aria-labelledby="mm-about-title">
      <h2 id="mm-about-title" tabindex="-1">About Hearthvale</h2>
      <p>You sit on the council of a small town. You never place a building or draw a road. People bring you their requests, and you decide. Then you watch the town live with what you decided.</p>
      <p>Paths wear in where people walk. Families pick their own plots, businesses find their own sites, and new councils ask to be formed. Your rulings shape what the town finds easy, and the town's behaviour shapes what lands on your desk next.</p>
      <p>A year passes in about two minutes at normal speed. Play again in the same valley and you will get a different city.</p>
      <h3>Keys</h3>
      <div class="keys"><kbd>Space</kbd><span>Pause or resume</span><kbd>1</kbd><span>Normal speed</span><kbd>2</kbd><span>Three times</span><kbd>3</kbd><span>Five times</span><kbd>4</kbd><span>Ten times</span><kbd>5</kbd><span>Twenty times</span><kbd>C</kbd><span>Open or close the Council</span><kbd>R</kbd><span>Open or close the Rule Book</span><kbd>H</kbd><span>Hide or show the interface</span></div>
      <p class="mm-small">Towns are saved on this device every 30 seconds. Signed-in players also get automatic cloud backup: one town for free, up to ten with Plus. Plus players can restore past versions from Play → Manage Towns.</p>
    </section>`;
  }

  // ---------- events ----------
  function pick(choice) {
    if (!resolveChoice) return;
    const r = resolveChoice;
    resolveChoice = null;
    root.classList.add('mm-busy');
    r(choice);
  }

  function found() {
    const name = form.name.trim() || suggestName(form.landscape);
    const {version, archetype} = terrainChoice();
    pick({kind: 'new', name, seed: seedValue(), terrainVersion: version, archetype});
  }

  async function exportTown(meta) {
    const raw = await saves.load(meta.id);
    if (raw) download(fileName(meta), raw);
    else say('That town could not be read.', 'error');
  }

  root.addEventListener('click', async (e) => {
    if (root.classList.contains('mm-busy')) return;
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) {
      const where = goBtn.dataset.go;
      if (where === 'continue') return pick({kind: 'continue', id: latest.id});
      return go(where);
    }
    const chip = e.target.closest('[data-landscape]');
    if (chip) {
      form.landscape = chip.dataset.landscape;
      for (const c of body.querySelectorAll('[data-landscape]')) {
        c.setAttribute('aria-checked', String(c === chip));
        c.tabIndex = c === chip ? 0 : -1;
      }
      form.found = null;
      syncNew();
      return drawValley();
    }
    const prefBtn = e.target.closest('.seg[data-pref] button');
    if (prefBtn) {
      for (const b of prefBtn.parentElement.children) { const on = b === prefBtn; b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-pressed', String(on)); }
      prefs.set(prefBtn.parentElement.dataset.pref, prefBtn.dataset.value);
      applyLook(prefs);
      map?.redraw();
      return;
    }
    const cloudBtn = e.target.closest('[data-cloud-act]');
    if (cloudBtn) return cloudPanel?.handle(cloudBtn, selected);
    const row = e.target.closest('[data-town]');
    if (row) return selectTown(row.dataset.town);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'account') return openAccount?.();
    if (act === 'import') return body.querySelector('[data-act="import-file"]')?.click();
    if (act === 'name-roll') {
      form.name = suggestName(form.landscape, form.name);
      body.querySelector('#mm-name').value = form.name;
      return syncNew();
    }
    if (act === 'seed-roll') {
      form.seedText = seedCode(newSeed());
      body.querySelector('#mm-seed').value = form.seedText;
      form.found = null;
      syncNew();
      return drawValley();
    }
    if (act === 'sound') {
      const sw = e.target.closest('[data-act]');
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      prefs.set('muted', !on);
      return;
    }
    if (act === 'found') return found();
    if (act === 'play' && selected) return pick({kind: 'load', id: selected.id});
    if (act === 'export' && selected) return exportTown(selected);
    if (act === 'delete' && selected) { confirmDelete = selected.id; syncTownActions(); body.querySelector('[data-act="keep"]')?.focus(); return; }
    if (act === 'keep') { confirmDelete = null; syncTownActions(); return; }
    if (act === 'delete-yes' && selected) {
      const gone = selected;
      await saves.remove(gone.id);
      await refreshTowns();
      selected = towns[0] ?? null;
      setBackdrop();
      go('towns');
      say(`${gone.name || 'Hearthvale'} was deleted.`);
      return;
    }
    if (act === 'rename' && selected) return startRename();
  });

  function startRename() {
    const nameEl = body.querySelector(`[data-town="${CSS.escape(selected.id)}"] .mm-town-name`);
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'mm-rename';
    input.maxLength = 24;
    input.value = selected.name || 'Hearthvale';
    input.setAttribute('aria-label', 'Town name');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep && name && name !== selected.name) {
        await saves.rename(selected.id, name);
        await refreshTowns();
        selected = towns.find((t) => t.id === selected.id) ?? selected;
      }
      go('towns', {focus: false});
      body.querySelector(`[data-town="${CSS.escape(selected.id)}"]`)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  root.addEventListener('input', (e) => {
    if (e.target.id === 'mm-name') { form.name = e.target.value; syncNew(); }
    if (e.target.id === 'mm-seed') { form.seedText = e.target.value; form.found = null; syncNew(); drawValley(250); }
    if (e.target.dataset.range) prefs.set(e.target.dataset.range, Number(e.target.value));
  });
  root.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'import-file' || root.classList.contains('mm-busy')) return;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      const meta = metaFromSave(raw);
      pick({kind: 'import', raw, name: meta.name});
    } catch {
      say('That file is not a Hearthvale town.', 'error');
    }
  });
  root.addEventListener('keydown', (e) => {
    if (root.classList.contains('mm-busy')) return;
    if (e.key === 'Enter' && (e.target.id === 'mm-name' || e.target.id === 'mm-seed')) { e.preventDefault(); found(); return; }
    // Arrow keys move along the menu, the towns and each radio group.
    const keys = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1};
    if (!(e.key in keys)) return;
    const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    const group = e.target.closest('.mm-list, .mm-towns, [role="radiogroup"]');
    if (!group || (group.classList.contains('mm-list') && !vertical)) return;
    const items = [...group.querySelectorAll('.mm-item, .mm-town, [role="radio"]')];
    const i = items.indexOf(e.target.closest('.mm-item, .mm-town, [role="radio"]'));
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + keys[e.key] + items.length) % items.length];
    if (next.classList.contains('mm-town')) selectTown(next.dataset.town, true);
    else if (next.getAttribute('role') === 'radio') { next.click(); next.focus(); }
    else next.focus();
  });
  root.addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-town]');
    if (!row || root.classList.contains('mm-busy')) return;
    const town = allTowns().find((t) => t.id === row.dataset.town);
    if (!town?.cloudOnly) pick({kind: 'load', id: row.dataset.town});
    else if (!town.removed) pick({kind: 'cloud', id: town.cloudId});
  });

  // Escape returns to the parent menu, even with nothing focused.
  const onEscape = (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.key !== 'Escape' || e.defaultPrevented || root.classList.contains('mm-busy') || root.dataset.screen === 'title') return;
    e.preventDefault();
    go(parentScreen[root.dataset.screen] ?? 'title');
  };
  document.addEventListener('keydown', onEscape);
  const onResize = () => { if (root.dataset.screen === 'new') map?.redraw(); };
  addEventListener('resize', onResize);

  async function refreshTowns() {
    towns = await saves.list();
    latest = await saves.latest();
  }

  const ready = refreshTowns().then(() => {
    setBackdrop();
    go(screens[start] ? start : 'title');
    requestAnimationFrame(() => root.classList.add('mm-in'));
  });

  return {
    updateAccount(session) {
      if (root.dataset.screen === 'towns') { mountCloud(); refreshTownList(); }
      const button = root.querySelector('.mm-account');
      if (button) button.textContent = session.authenticated ? 'Manage account' : 'Sign in';
      const tier = root.querySelector('.mm-account-tier');
      if (tier) { tier.textContent = session.tier === 'paid' ? 'Hearthvale Plus' : ''; tier.hidden = session.tier !== 'paid'; }
    },
    /** Waits for the player's choice. */
    async choose() {
      await ready;
      root.classList.remove('mm-busy');
      return new Promise((resolve) => { resolveChoice = resolve; });
    },
    /** A line under the menu while the town is being built. */
    busy(text) {
      root.classList.add('mm-busy');
      say(text, 'busy');
    },
    /** The choice could not be carried out: say why and let the player choose again. */
    async fail(text) {
      await refreshTowns();
      setBackdrop();
      go('title', {focus: false});
      say(text, 'error');
      root.classList.remove('mm-busy');
    },
    /** Fades out over the game, then leaves the page. */
    close() {
      cloudPanel?.destroy();
      darkMedia.removeEventListener?.('change', onDark);
      removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onEscape);
      map?.dispose();
      root.classList.add('mm-out');
      const done = () => {
        root.remove();
        for (const u of urls) URL.revokeObjectURL(u);
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || prefs.get('motion') === 'reduced') done();
      else setTimeout(done, 700);
    },
    element: root,
  };
}

// The game's theme, text size and motion settings, applied before the game's
// own UI exists (app.js takes over once it starts).
function applyLook(prefs) {
  const pref = prefs.get('theme');
  const night = pref === 'night' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const html = document.documentElement;
  html.dataset.theme = night ? 'night' : 'light';
  html.dataset.text = prefs.get('textSize');
  html.dataset.motion = prefs.get('motion');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', night ? '#1f2622' : '#f6f7ef');
}
