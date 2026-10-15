// App shell. Mounts the paper layers over the canvas, routes view models
// from the sim's selectors into components, and grows the interface as
// selectUnlocks opens new surfaces (design-visual §8.2, design-systems §9.2).
//
// Layouts (data-layout on .ui):
//   desk   ≥ 1000 px: top bar, left rail + drawer, right dock + binder
//          (resizable), time strip.
//   tablet 720–999 px (or short landscape): the binder becomes a side sheet
//          that opens beside the dock.
//   phone  < 720 px: bottom sheet with snap points holds every view; its
//          peek carries a strip of every unlocked view.
import './tokens.css';
import './layout.css';
import './components.css';
import {esc, h, setText, toggleClass} from './dom.js';
import {bodyIcon, icon, mountSprite} from './icons.js';
import {ERA_NAMES, cap, theName} from './format.js';
import {reduced, setReducedMotion} from './motion.js';
import {createSheet} from './sheet.js';
import {createTopbar} from './components/topbar.js';
import {createTime} from './components/time.js';
import {createBodyView} from './components/body-view.js';
import {createRuleBook} from './components/rulebook.js';
import {createTensions} from './components/tensions.js';
import {createPeople} from './components/people.js';
import {createChronicle, createFeed} from './components/chronicle.js';
import {createPlaces} from './components/places.js';
import {createInspector} from './components/inspector.js';
import {createNotices} from './components/notices.js';
import {createMoments} from './components/moment.js';
import {createSettings} from './components/settings.js';
import {createRailColumn} from './components/rail-column.js';
import {createResize} from './components/resize.js';
import {createPhoneNav} from './components/phone-nav.js';
import {createTip} from './components/tip.js';
import {closePopover, eraContent, openPopover, overlayContent} from './components/popover.js';
import {explainer, EXPLAINERS} from './components/explainer.js';
import * as M from './model.js';

const REFRESH_MS = 250;
const MAJOR_EVENTS = new Set(['fire', 'flood', 'plague', 'riot', 'bust', 'famine', 'blight', 'bridge-collapse', 'drought', 'strike']);
const SHORT_NAMES = {
  moot: 'Council', 'agri-council': 'Farms', 'trades-guild': 'Guild', exchange: 'Exchange', 'river-authority': 'River',
  'school-board': 'Schools', parish: 'Parish', 'health-board': 'Health', planning: 'Planning', union: 'Union',
  watch: 'Watch', 'arts-society': 'Arts', steward: 'Steward',
};
// Drawer views (left rail on desk/tablet; sheet tabs on phone).
const DRAWER_VIEWS = [
  {id: 'chronicle', label: 'Chronicle', icon: 'chronicle', unlock: 'chronicle'},
  {id: 'people', label: 'People', icon: 'people', unlock: 'people'},
  {id: 'rules', label: 'Rule Book', short: 'Rules', icon: 'rules', unlock: 'ruleBook'},
  {id: 'tensions', label: 'Tensions', icon: 'tensions', unlock: 'tensions'},
  {id: 'places', label: 'Places', icon: 'map', unlock: 'places'},
];
// Phone strip order after the docket and bodies, and the snap each view opens at.
const NAV_VIEWS = ['rules', 'people', 'tensions', 'chronicle', 'places'];
const NAV_SNAP = {moot: 2, rules: 2, chronicle: 2};
const UNLOCK_NAMES = {places: 'Places', ruleBook: 'The Rule Book', people: 'People', tensions: 'Tensions', overlays: 'The map', bodies: 'Body dashboards', delegation: 'Delegation', debates: 'Debates'};

export function createApp(host) {
  const {sim, prefs, audio} = host;
  let world = host.world;
  const V = sim.view;
  mountSprite();

  const root = h('div.ui', {'data-layout': 'desk', 'data-sheet': '0'});
  document.body.append(root);

  // ---------- shared context for components ----------
  let data = {top: null, unlocks: {}, cards: [], bodies: [], era: null, chronicle: []};
  let factionNames = {}, factionsAt = -Infinity, bodyNames = {};
  const ctx = {
    root, prefs,
    factionName: (id) => factionNames[id] ?? titleCase(id),
    bodyName: (id) => bodyNames[id] ?? (id === 'moot' ? 'The Council' : titleCase(id)),
    bodyIcon: (id) => bodyIcon({id, kind: data.bodies.find((b) => b.id === id)?.kind}),
    coin: () => data.top?.coin,
    unlocks: () => data.unlocks,
    sound: (name, arg) => audio?.play(name, arg),
    onRule,
    setDelegated,
    dissolve: (id) => confirmDissolve(id),
    setStandingOrder: (id, order) => setStandingOrder(id, order),
    onMetric,
    openSettings: () => settings.open(),
    setSpeed: (s) => host.setSpeed(s),
    speed: () => host.speed(),
    lastSpeed: () => host.lastSpeed(),
    toggleMute: () => prefs.set('muted', !prefs.get('muted')),
    openEraPopover: (anchor) => openPopover(anchor, eraContent(data.era), {label: 'Toward the next age', place: 'above'}),
    focusDocket,
    inspect: (pick) => M.inspect(safe(() => V.selectInspect?.(host.state(), pick), null)),
    focusWorld: (at) => world?.focus?.(at, 900),
    openBody: (id) => (layout === 'phone' ? setPhoneTab(id) : openBody(id)),
    openPlaces: () => (layout === 'phone' ? setPhoneTab('places') : setDrawer('places')),
    onInspectorChange: (open) => onInspectorChange(open),
    narrator: host.narrator ?? null,
    state: () => host.state(),
    canFollow: () => typeof world?.follow === 'function',
    follow: (pick) => world?.follow?.(pick.personId),
  };

  // ---------- regions ----------
  const tip = createTip(root);
  const vignette = h('div.vignette', {'aria-hidden': 'true'});
  const topbar = createTopbar(ctx);
  // The left rail mirrors the right dock: views open a drawer beside it, and
  // the open view's tile closes it again; the tools sit below a rule.
  const railUI = createRailColumn({cls: 'rail', label: 'Views', key: 'view', tileClass: 'rail-btn', tipSide: 'right', tip, onPick: pickRail});
  const rail = railUI.el;
  const drawer = h('aside.drawer.paper', {'aria-label': 'View', id: 'drawer'});
  const drawerHead = h('div.panel-head');
  drawerHead.innerHTML = `<h2></h2><button class="icon-btn" aria-label="Close">${icon('close')}</button>`;
  const drawerBody = h('div.panel-body');
  drawer.append(drawerHead, drawerBody);
  drawerHead.querySelector('button').addEventListener('click', () => setDrawer(null));

  const binder = h('aside.binder.paper', {'aria-label': 'Bodies and docket', id: 'binder'});
  const binderBar = h('div.binder-bar');
  const collapseBtn = h('button.icon-btn.collapse-btn', {type: 'button', 'aria-label': 'Tuck the docket away (C)', title: 'Tuck away (C)', 'aria-controls': 'binder', 'aria-expanded': 'true'});
  collapseBtn.innerHTML = icon('chevron-right');
  collapseBtn.addEventListener('click', () => setDocked(true));
  binderBar.append(collapseBtn);
  const binderBody = h('div.panel-body');
  // Live reframing while a panel is dragged wider or narrower.
  let resizeInsetRaf = 0;
  const reframe = () => {
    if (!resizeInsetRaf) resizeInsetRaf = requestAnimationFrame(() => { resizeInsetRaf = 0; updateInsets(); });
  };
  const resize = createResize({root, panel: binder, prefs, onChange: reframe, label: 'Docket width'});
  binder.append(binderBar, binderBody, resize.el);
  const drawerResize = createResize({root, panel: drawer, prefs, onChange: reframe, prefKey: 'drawerWidth', varName: '--drawer-user', edge: 'right', controls: 'drawer', label: 'View width'});
  drawer.append(drawerResize.el);

  // The dock: every body's crest, always visible at the right edge.
  const dockUI = createRailColumn({cls: 'dock', label: 'Bodies', key: 'body', tileClass: 'dock-btn', tipSide: 'left', tip, onPick: pickBody});
  const dock = dockUI.el;
  const petitionHost = h('div.petition-host');

  const strip = h('footer.timestrip.paper');
  const stripTime = createTime(ctx, 'strip');
  strip.append(stripTime.el);

  const feed = createFeed();
  const inspector = createInspector(ctx);
  const notices = createNotices();
  const moments = createMoments({
    root,
    onMomentOpened: () => { setClean(false); momentPaused = host.speed(); if (momentPaused) host.setSpeed(0); syncLabels(); },
    onMomentClosed: () => { if (momentPaused && !moments.isOpen) host.setSpeed(momentPaused); momentPaused = 0; syncLabels(); },
  });
  let momentPaused = 0;
  const settings = createSettings({
    root, prefs,
    decisionSettings: () => host.decisions.settings(),
    configureDecisions: (s) => host.decisions.configure(s),
    decisionStats: () => host.decisions.stats(),
    modelEnabled: () => host.decisions.enabled(),
    setModelEnabled: (on) => host.decisions.setEnabled(on),
    renderStats: () => safe(() => world?.stats?.(), null),
    simMs: () => host.simMs(),
    getIndividualCap: () => host.state()?.settings?.individualCap ?? 2000,
    setIndividualCap: (v) => host.setIndividualCap(v),
    save: (manual) => host.save(manual),
    exportSave: () => host.exportSave(),
    importSave: (file) => host.importSave(file),
    newTown: (opts) => confirmNewTown(opts),
    seedCode: () => host.seedCode?.(),
    hideInterface: () => { settings.close(); setClean(true); },
  });

  const sheet = createSheet({onSnap: (i, peekPx) => {
    root.style.setProperty('--peek', `${Math.round(peekPx)}px`);
    updateInsets();
    closePopover();
  }});
  const peekTime = createTime(ctx, 'peek');
  sheet.peek.append(peekTime.el);
  const nav = createPhoneNav({onPick: onNav});
  sheet.tabs.append(nav.el);

  root.append(vignette, feed.el, inspector.el, topbar.el, rail, drawer, binder, dock, petitionHost, strip, ...notices.hosts, sheet.scrim, sheet.el);

  // ---------- views ----------
  const bodyViews = new Map();
  const views = {
    chronicle: createChronicle(ctx),
    people: createPeople(ctx),
    rules: createRuleBook(ctx),
    tensions: createTensions(ctx),
    places: createPlaces(ctx),
  };
  let activeBody = 'moot', activeDrawer = null, phoneTab = 'moot', prevPhoneTab = 'moot', overlay = 'none';
  let docked = prefs.get('dock') === 'collapsed';
  let layout = '', prevUnlocks = null, prevBodies = null, prevEra = null, prevYear = null, seenCards = null, seenEvents = null;
  const fresh = new Set(); // surfaces revealed this session and not yet visited

  function bodyView(id) {
    if (!bodyViews.has(id)) bodyViews.set(id, createBodyView(ctx, id));
    return bodyViews.get(id);
  }

  // ---------- layout ----------
  function detectLayout() {
    const w = innerWidth, ht = innerHeight;
    const next = w < 720 ? 'phone' : w < 1000 || (ht < 520 && w < 1100) ? 'tablet' : 'desk';
    document.documentElement.style.setProperty('--vh', `${(window.visualViewport?.height ?? ht) / 100}px`);
    if (next === layout) return false;
    layout = next;
    root.dataset.layout = next;
    // The player's choice holds at every width; with no choice yet, the
    // tablet overlay starts tucked away and the desk binder starts open.
    const pref = prefs.get('dock');
    setDocked(pref ? pref === 'collapsed' : next === 'tablet', true);
    if (next === 'phone') {
      setDrawer(null, true);
      sheet.snapTo(sheet.index, false);
    } else {
      sheet.el.style.transform = '';
    }
    mountViews();
    return true;
  }

  function mountViews() {
    if (layout === 'phone') {
      const view = viewFor(phoneTab);
      if (sheet.body.firstChild !== view.el) sheet.body.replaceChildren(view.el);
      binderBody.replaceChildren();
      drawerBody.replaceChildren();
    } else {
      if (inspector.el.parentNode !== root) root.append(inspector.el);
      const bv = bodyView(activeBody);
      if (binderBody.firstChild !== bv.el) binderBody.replaceChildren(bv.el);
      if (activeDrawer) {
        const dv = views[activeDrawer];
        if (drawerBody.firstChild !== dv.el) drawerBody.replaceChildren(dv.el);
      }
      sheet.body.replaceChildren();
    }
  }

  function viewFor(id) {
    if (id === 'inspect') return inspector;
    return views[id] ?? bodyView(id);
  }

  function setDrawer(id, silent) {
    if (layout === 'phone' && id) return setPhoneTab(id);
    activeDrawer = id === activeDrawer ? null : id;
    toggleClass(drawer, 'is-open', Boolean(activeDrawer));
    toggleClass(root, 'drawer-open', Boolean(activeDrawer));
    if (activeDrawer) {
      const def = DRAWER_VIEWS.find((d) => d.id === activeDrawer);
      setText(drawerHead.querySelector('h2'), def?.label ?? '');
      drawerBody.replaceChildren(views[activeDrawer].el);
      drawerBody.scrollTop = 0;
      fresh.delete(activeDrawer);
      if (!silent) audio?.play('slide');
    }
    renderRail();
    refresh(true);
  }

  function setActiveBody(id) {
    if (activeBody === id) return;
    activeBody = id;
    fresh.delete(`body:${id}`);
    binderBody.scrollTop = 0;
    mountViews();
    renderDock();
    audio?.play('tick');
    refresh(true);
  }

  // Dock crests: open the panel to a body; the open body's crest tucks it away.
  function pickBody(id) {
    if (!docked && activeBody === id) return setDocked(true);
    openBody(id);
  }

  function openBody(id) {
    if (docked) setDocked(false);
    setActiveBody(id);
  }

  function setPhoneTab(id, snap = 1) {
    if (phoneTab === 'inspect' && id !== 'inspect' && inspector.open) {
      phoneTab = id;
      inspector.hide();
    }
    phoneTab = id;
    fresh.delete(id);
    fresh.delete(`body:${id}`);
    mountViews();
    sheet.body.scrollTop = 0;
    if (sheet.index < snap) sheet.snapTo(snap);
    renderNav();
    nav.reveal();
    audio?.play('tick');
    refresh(true);
  }

  function setDocked(next, silent) {
    docked = Boolean(next);
    toggleClass(root, 'docked', docked);
    collapseBtn.setAttribute('aria-expanded', String(!docked));
    if (!silent) {
      prefs.set('dock', docked ? 'collapsed' : 'open');
      audio?.play(docked ? 'tick' : 'slide');
      petitionHost.replaceChildren();
    }
    renderDock();
    insetSig = '';
    requestAnimationFrame(updateInsets);
  }

  // The docket on top; every other body below, scrolling when crowded, with
  // quiet bodies sunk below busy ones (the open body and new ones count as busy).
  function renderDock() {
    if (layout === 'phone') return;
    const counts = countByBody();
    const open = !docked;
    const docket = {id: 'moot', name: 'The docket', tip: 'Docket', icon: 'seal', count: countByKind(data.cards), pressed: open && activeBody === 'moot', controls: 'binder'};
    const rest = data.bodies.filter((b) => b.id !== 'moot').map((b) => {
      const count = counts[b.id] ?? 0, pressed = open && activeBody === b.id, isNew = fresh.has(`body:${b.id}`);
      return {id: b.id, name: b.name, icon: ctx.bodyIcon(b.id), count, fresh: isNew, pressed, quiet: !count && !pressed, busy: count > 0 || pressed || isNew, controls: 'binder'};
    });
    const order = rest.length > 6 ? [...rest.filter((i) => i.busy), ...rest.filter((i) => !i.busy)] : rest;
    dockUI.update([{items: [docket]}, {items: order, scroll: true}]);
  }

  function countByKind(cards) {
    return cards.filter((c) => c.kind !== 'report').length;
  }

  function focusDocket(cardId) {
    if (layout === 'phone') {
      if (phoneTab !== 'moot') setPhoneTab('moot');
      sheet.snapTo(2);
    } else {
      openBody('moot');
      binderBody.scrollTop = 0;
    }
    refresh(true);
    bodyView('moot').docket.focus(cardId);
  }

  function onMetric(key) {
    if (key === 'people' || key === 'wellbeing') {
      if (data.unlocks.people) return layout === 'phone' ? setPhoneTab('people') : setDrawer('people');
    }
    if (key === 'food' && data.bodies.some((b) => b.id === 'agri-council')) return layout === 'phone' ? setPhoneTab('agri-council') : openBody('agri-council');
    focusDocket();
  }

  // ---------- rail ----------
  function renderRail() {
    const u = data.unlocks;
    const views = layout === 'phone' ? [] : DRAWER_VIEWS.filter((d) => u[d.unlock]).map((d) => ({id: d.id, name: d.label, icon: d.icon, pressed: activeDrawer === d.id, fresh: fresh.has(d.id), controls: 'drawer'}));
    const tools = [];
    // On phones the map lives in the sheet's view strip.
    if (u.overlays && layout !== 'phone') tools.push({id: 'map', name: 'Map', icon: 'layers', pressed: overlay !== 'none', fresh: fresh.has('map')});
    if (typeof world?.home === 'function') tools.push({id: 'home', name: 'Back to the town', icon: 'locate'});
    if (fsSupported) tools.push({id: 'fullscreen', name: fsElement() ? 'Leave full screen (F)' : 'Full screen (F)', icon: fsElement() ? 'shrink' : 'expand', pressed: Boolean(fsElement())});
    railUI.update([{items: views, scroll: true}, {items: tools}]);
  }

  function pickRail(id, el) {
    if (id === 'map') openMap(el);
    else if (id === 'home') world?.home?.();
    else if (id === 'fullscreen') toggleFullscreen();
    else setDrawer(id);
  }

  function openMap(anchor, place = 'right') {
    fresh.delete('map');
    const content = overlayContent(overlay, (mode) => {
      overlay = mode;
      world?.setOverlay?.(mode);
      renderRail();
      renderNav();
    });
    const note = explainer(ctx, 'overlays', EXPLAINERS.overlays);
    if (note) content.prepend(note);
    openPopover(anchor, content, {label: 'Map', place});
  }

  // Phone view strip: the docket, each body, then the drawer views and the map.
  function renderNav() {
    if (layout !== 'phone') return;
    const counts = countByBody();
    const items = data.bodies.map((b) => (b.id === 'moot'
      ? {id: 'moot', label: 'Docket', icon: 'seal', count: countByKind(data.cards)}
      : {id: b.id, label: shortName(b), icon: ctx.bodyIcon(b.id), count: counts[b.id] ?? 0, fresh: fresh.has(`body:${b.id}`)}));
    if (!items.length) items.push({id: 'moot', label: 'Docket', icon: 'seal', count: 0});
    for (const id of NAV_VIEWS) {
      const d = DRAWER_VIEWS.find((v) => v.id === id);
      if (data.unlocks[d.unlock]) items.push({id, label: d.label, icon: d.icon, fresh: fresh.has(id)});
    }
    if (data.unlocks.overlays) items.push({id: 'map', label: 'Map', icon: 'layers', fresh: fresh.has('map'), pressed: overlay !== 'none'});
    if (inspector.open) items.unshift({id: 'inspect', label: 'Selected', icon: 'info'});
    if (!items.some((i) => i.id === phoneTab)) phoneTab = 'moot';
    nav.update(items, phoneTab);
  }

  function onNav(id, el) {
    if (id === 'map') {
      if (sheet.index === 0) return openMap(el, 'above');
      // Let the sheet settle at its peek, then open the menu above it.
      sheet.snapTo(0);
      return setTimeout(() => openMap(el, 'above'), reducedMs(380));
    }
    if (id === phoneTab && sheet.index > 0) return sheet.snapTo(0);
    setPhoneTab(id, NAV_SNAP[id] ?? 1);
  }

  // Which centre the camera looks at: the renderer's target if it offers one,
  // else the centre that projects nearest the middle of the free area.
  function centreUnderCamera(centres) {
    const nearest = (dist) => {
      let best = null, bd = Infinity;
      for (const c of centres) {
        const d = dist(c);
        if (d < bd) { bd = d; best = c; }
      }
      return best?.id ?? null;
    };
    const at = safe(() => world?.cameraTarget?.(), null);
    if (at && Number.isFinite(at.x)) return nearest((c) => Math.hypot(c.x - at.x, c.z - at.z));
    if (!world?.projectPoint) return null;
    const ins = JSON.parse(insetSig || '{"top":0,"right":0,"bottom":0,"left":0}');
    const cx = (ins.left + innerWidth - ins.right) / 2, cy = (ins.top + innerHeight - ins.bottom) / 2;
    return nearest((c) => {
      const p = safe(() => world.projectPoint(c.x, c.z), null);
      return p ? Math.hypot(p.x - cx, p.y - cy) : Infinity;
    });
  }

  function shortName(b) {
    if (b.kind === 'ward' || String(b.id).startsWith('ward:')) {
      const c = data.centres?.centres?.find((x) => x.id === b.centreId || `ward:${x.id}` === b.id);
      return c?.name ?? String(b.name).replace(/\s*Ward Council$/i, '');
    }
    return SHORT_NAMES[b.kind ?? b.id] ?? b.name;
  }

  function countByBody() {
    const out = {};
    for (const c of data.cards) if (c.kind !== 'report') out[c.from] = (out[c.from] ?? 0) + 1;
    return out;
  }

  // ---------- actions ----------
  function onRule(card, option) {
    const result = host.act('rule', card.id, option.key);
    if (result && result.ok === false) {
      notices.toast(M.actionError(result));
      return;
    }
    audio?.play(card.kind === 'report' ? 'tick' : 'chime');
    refresh(true);
  }

  function setDelegated(bodyId, on, limit) {
    const result = host.act('setDelegated', bodyId, on, limit);
    if (result && result.ok === false) return notices.toast(M.actionError(result));
    const name = ctx.bodyName(bodyId);
    notices.toast(on ? `${cap(theName(name))} now runs its own affairs.` : `You took back ${theName(name)}'s affairs.`);
    audio?.play('chime');
    refresh(true);
  }

  // ---------- growth, moments, nudges ----------
  let passSpeed = 0;
  function detectChanges(state) {
    const {unlocks, bodies, top, cards} = data;
    passSpeed = momentPaused || host.speed();
    if (prevUnlocks) {
      for (const [key, on] of Object.entries(unlocks)) {
        if (!on || prevUnlocks[key]) continue;
        const target = {ruleBook: 'rules', people: 'people', tensions: 'tensions', overlays: 'map', places: 'places'}[key];
        if (target) fresh.add(target);
        if (UNLOCK_NAMES[key]) {
          notices.nudge(`New: ${UNLOCK_NAMES[key]}`, {icon: 'spark', onClick: () => target && target !== 'map' && (layout === 'phone' ? setPhoneTab(target) : setDrawer(target))});
        }
      }
    }
    prevUnlocks = {...unlocks};

    if (prevEra != null && top.era > prevEra) {
      showMoment({eyebrow: `A new age · ${ERA_NAMES[top.era]}`, title: `Hearthvale is a ${top.eraName?.toLowerCase() ?? 'new place'} now`, text: lastMoment(state) ?? 'The town has grown into a new age.', icon: 'spark', sound: 'fanfare', camera: true});
    }
    prevEra = top.era;

    const ids = bodies.map((b) => b.id);
    if (prevBodies) {
      for (const b of bodies) {
        if (prevBodies.includes(b.id)) continue;
        fresh.add(`body:${b.id}`);
        showMoment({eyebrow: 'A new body', title: `${cap(theName(b.name))} sits for the first time`, text: b.explainer?.join(' ') ?? 'It will bring you its own plans to rule on.', icon: ctx.bodyIcon(b.id), sound: 'fanfare'});
      }
    }
    prevBodies = ids;


    if (prevYear != null && top.year > prevYear) {
      const entry = [...data.chronicle].reverse().find((e) => e.kind === 'year');
      const text = entry?.text?.replace(/^Year \d+ ends\.\s*/, '') ?? '';
      notices.banner(`Year ${prevYear} ends`, text || `Year ${top.year} begins.`, {key: 'year', icon: 'scroll'});
      if (top.era >= 2) audio?.play('bell', Math.max(1, top.era));
    }
    prevYear = top.year;

    // Major disasters arrive as active events.
    const eventIds = new Set(data.events.map((e) => e.id));
    if (seenEvents) {
      for (const ev of data.events) {
        // The sim marks which events deserve a title card; older sims fall back to a list.
        if (seenEvents.has(ev.id) || !(ev.titleCard ?? MAJOR_EVENTS.has(ev.event))) continue;
        const line = [...data.chronicle].reverse().find((e) => e.kind !== 'year');
        showMoment({eyebrow: 'Hard times', title: ev.title, text: line?.text ?? '', icon: 'bell'});
      }
    }
    seenEvents = eventIds;

    const cardIds = cards.map((c) => c.id);
    if (seenCards) {
      const added = cards.filter((c) => !seenCards.has(c.id));
      if (added.length) {
        audio?.play('chime');
        announce(added);
        if (host.speed() >= 3 && prefs.get('pauseOnSession') && !moments.isOpen) {
          host.setSpeed(0);
          notices.toast('Paused for new requests. Press Space to go on.');
        }
      }
    }
    seenCards = new Set(cardIds);
  }

  // New cards never open a panel or take focus. A petitioner chip slides out
  // of the dock unless the open panel already shows the card's docket (then
  // the card simply animates in); on phone a pill sits above the peek.
  function announce(added) {
    const first = added[0];
    const name = ctx.bodyName(first.from);
    const more = added.length > 1 ? added.length - 1 : 0;
    const open = () => openCard(first);
    const inView = !docked && (activeBody === 'moot' || activeBody === first.from);
    if (layout !== 'phone' && !inView) {
      notices.nudge('', {
        key: 'docket', host: petitionHost, ms: 8000, onClick: open,
        render: () => {
          const chip = h('button.petition.paper', {type: 'button'});
          chip.innerHTML = `<span class="seal-icon">${icon(ctx.bodyIcon(first.from))}</span><span class="petition-text"><b>${esc(cap(name))} asks</b><span>${esc(first.title)}</span></span>${more ? `<span class="badge">+${more}</span>` : ''}`;
          return chip;
        },
        onExpire: async (chip) => {
          chip.classList.add('is-tucking');
          await new Promise((r) => setTimeout(r, reducedMs(260)));
          chip.remove();
          (dockUI.tile(first.from) ?? dockUI.tile('moot'))?.animate?.([{transform: 'scale(1)'}, {transform: 'scale(1.18)'}, {transform: 'scale(1)'}], {duration: reducedMs(420)});
        },
      });
    } else if (layout === 'phone' && !(phoneTab === 'moot' && sheet.index > 0)) {
      notices.nudge(`${cap(name)} asks: ${first.title}${more ? ` (+${more})` : ''}`, {key: 'docket', icon: 'seal', onClick: open});
    }
  }

  function openCard(card) {
    const at = (frameView?.attention ?? []).find((a) => a.bodyId === card.from) ?? card.place;
    if (at && Number.isFinite(at.x)) world?.focus?.({x: at.x, z: at.z}, 900);
    focusDocket(card.id);
  }

  function lastMoment(state) {
    const e = [...data.chronicle].reverse().find((x) => x.kind === 'moment');
    return e?.text;
  }

  function showMoment(m) {
    const mode = prefs.get('moments');
    const blocking = moments.isOpen || mode === 'always' || (mode === 'fast' && passSpeed >= 3);
    audio?.play(m.sound ?? 'chime');
    if (blocking) moments.push(m);
    else notices.banner(m.title, m.text, {icon: m.icon, ms: 7000});
  }

  // World name labels hide in clean view and behind title cards and dialogs.
  let labelsShown = null;
  function syncLabels() {
    const on = !clean && !moments.isOpen && !settings.isOpen && !confirmLayer;
    if (on === labelsShown || typeof world?.setLabelsVisible !== 'function') return;
    labelsShown = on;
    world.setLabelsVisible(on);
  }

  // ---------- insets, theme ----------
  let insetSig = '';
  function updateInsets() {
    if (!world?.setSceneInsets) return;
    if (clean) {
      const zero = JSON.stringify({top: 0, right: 0, bottom: 0, left: 0});
      if (insetSig !== zero) { insetSig = zero; world.setSceneInsets({top: 0, right: 0, bottom: 0, left: 0}); }
      return;
    }
    const W = innerWidth, H = innerHeight;
    const tb = topbar.el.getBoundingClientRect();
    const insets = {top: Math.round(tb.bottom), right: 0, bottom: 0, left: 0};
    if (layout === 'phone') {
      insets.bottom = Math.round(sheet.peekHeight);
    } else {
      const st = strip.getBoundingClientRect();
      insets.bottom = Math.round(H - st.top);
      const rr = rail.getBoundingClientRect();
      insets.left = rail.hidden ? 0 : Math.round(rr.right);
      // An open desk drawer reframes the scene too.
      if (layout === 'desk' && activeDrawer) insets.left = Math.round(drawer.offsetLeft + drawer.offsetWidth);
      // The desk panel reframes the scene; the tablet one floats over it.
      // offsetLeft ignores the slide transform, so the camera moves once.
      const d = dock.getBoundingClientRect();
      if (layout === 'desk' && !docked) insets.right = Math.round(W - binder.offsetLeft);
      else insets.right = d.width ? Math.round(W - d.left) : 0;
    }
    const sig = JSON.stringify(insets);
    if (sig === insetSig) return;
    insetSig = sig;
    world.setSceneInsets(insets);
  }

  const darkMedia = matchMedia('(prefers-color-scheme: dark)');
  let nightBeat = false;
  function applyTheme() {
    const pref = prefs.get('theme');
    const night = pref === 'night' || (pref === 'auto' && (darkMedia.matches || nightBeat));
    document.documentElement.dataset.theme = night ? 'night' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', night ? '#1f2622' : '#f6f7ef');
  }
  darkMedia.addEventListener?.('change', applyTheme);

  function applyPrefs(key) {
    if (!key || key === 'motion') setReducedMotion(prefs.get('motion') === 'reduced');
    if (!key || key === 'textSize') document.documentElement.dataset.text = prefs.get('textSize');
    if (!key || key === 'theme') applyTheme();
    if (!key || key === 'quality') world?.setQuality?.(prefs.get('quality'));
    if (!key || key === 'dayCycle') world?.setDayCycle?.(prefs.get('dayCycle'));
    if (key === 'muted') refresh(true);
  }
  prefs.onChange(applyPrefs);
  applyPrefs();

  // ---------- refresh ----------
  let lastRefresh = -Infinity, frameView = null, refreshing = false, again = false;

  // Moments pause the town, and setSpeed asks for a refresh; never nest one
  // refresh inside another (change detection would run twice).
  function refresh(force) {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      doRefresh(force);
    } finally {
      refreshing = false;
    }
    if (again) {
      again = false;
      queueMicrotask(() => refresh(true));
    }
  }

  function doRefresh(force) {
    const now = performance.now();
    if (!force && now - lastRefresh < REFRESH_MS) return;
    lastRefresh = now;
    const state = host.state();
    if (!state) return;
    const top = M.top(safe(() => V.selectTopBar(state), data.top ?? {}));
    const unlocks = safe(() => V.selectUnlocks(state), {chronicle: true, docket: true});
    const cards = (safe(() => V.selectDocket(state), []) ?? []).map(M.card);
    const bodies = (safe(() => V.selectBodies(state), []) ?? []).filter((b) => b.status !== 'dissolved').map(M.body);
    if (!bodies.some((b) => b.id === 'moot')) bodies.unshift({id: 'moot', kind: 'moot', name: 'The Council', metrics: [], rules: []});
    const eraRaw = safe(() => V.selectEraProgress(state), null);
    const era = M.era(eraRaw && {...eraRaw, year: eraRaw.year ?? top.year, floorYear: eraRaw.floorYear ?? (Number.isFinite(eraRaw.yearsToFloor) && eraRaw.yearsToFloor > 0 ? top.year + eraRaw.yearsToFloor : undefined)});
    const chronicle = M.chronicle(safe(() => V.selectChronicle(state, {limit: 200}), []) ?? []);
    const events = safe(() => V.selectEvents?.(state), []) ?? [];
    const centres = safe(() => V.selectCentres?.(state), null);
    const liveCentres = (centres?.centres ?? []).filter((c) => !c.mergedInto);
    if (unlocks.places == null) unlocks.places = liveCentres.length >= 2;
    bodyNames = Object.fromEntries(bodies.map((b) => [b.id, b.name]));
    if (now - factionsAt > 2000) {
      factionsAt = now;
      factionNames = Object.fromEntries((safe(() => V.selectFactions(state), []) ?? []).map((f) => [f.id, f.name]));
    }
    data = {top, unlocks, cards, bodies, era, chronicle, events, centres, here: liveCentres.length >= 2 ? centreUnderCamera(liveCentres) : null};
    if (!bodies.some((b) => b.id === activeBody)) activeBody = 'moot';

    detectChanges(state);
    topbar.update(top, unlocks, data.here ? liveCentres.find((c) => c.id === data.here) : null);
    const timeData = {speed: host.speed(), top, era, muted: prefs.get('muted')};
    if (layout === 'phone') peekTime.update(timeData); else stripTime.update(timeData);
    renderDock();
    feed.update(chronicle);
    renderRail();
    renderNav();
    updateViews(state);
    inspector.refresh();
    const uNight = world?.internals?.grade?.uniforms?.uNight?.value;
    nightBeat = prefs.get('dayCycle') !== 'off' && (Number.isFinite(uNight) ? uNight > 0.5 : (frameView?.time?.yearT ?? 0) > 0.965);
    applyTheme();
    updateInsets();
    syncLabels();
    audio?.update({
      season: top.season, night: nightBeat ? 1 : 0, wind: Math.hypot(...(state.weather?.wind ?? [0.3, 0])),
      population: top.people, festival: (state.worldEvents ?? []).some((e) => e.kind === 'festival' || e.kind === 'market'),
      building: (state.projects ?? []).length, running: host.speed() > 0,
    });
  }

  function updateViews(state) {
    const phone = layout === 'phone';
    const visible = phone ? [phoneTab] : [activeBody, activeDrawer].filter(Boolean);
    let ruleBook = null;
    const needRules = visible.includes('rules') || (data.unlocks.ruleBook && visible.some((v) => bodyViews.has(v) || data.bodies.some((b) => b.id === v)));
    // The Rule Book view lists rules in force; standing orders need every open category.
    let allCats = [];
    if (needRules) {
      const raw = safe(() => V.selectRuleBook(state), []) ?? [];
      ruleBook = M.ruleBook(raw);
      allCats = raw.filter((c) => c.open !== false).map((c) => ({id: c.id, name: c.name ?? c.title}));
    }
    const ruleIndex = {};
    for (const cat of ruleBook ?? []) for (const p of cat.policies ?? []) ruleIndex[p.id] = p;
    for (const id of visible) {
      if (id === 'inspect') continue;
      if (id === 'rules') views.rules.update(ruleBook);
      else if (id === 'people') views.people.update(data.top, safe(() => V.selectFactions(state), []) ?? [], {show: data.unlocks.compass, compass: data.unlocks.compass ? safe(() => V.selectCompass?.(state), null) : null});
      else if (id === 'chronicle') views.chronicle.update(data.chronicle, {show: data.unlocks.endPreview, summary: data.unlocks.endPreview ? safe(() => V.selectEndPreview?.(state), null) : null, centres: (data.centres?.centres ?? []).filter((c) => !c.mergedInto).map((c) => ({id: c.id, name: c.name}))});
      else if (id === 'tensions') views.tensions.update(M.tensions(safe(() => V.selectTensions(state), [])));
      else if (id === 'places') views.places.update(data.centres, data.here);
      else {
        const body = data.bodies.find((b) => b.id === id);
        const purse = id === 'moot' && data.unlocks.budget ? safe(() => V.selectBudget?.(state), null) : null;
        const categories = allCats;
        if (body) bodyView(id).update(body, {cards: data.cards, unlocks: data.unlocks, ruleIndex, phone, purse, categories});
      }
    }
  }

  // ---------- input ----------
  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (clean) return setClean(false);
      if (moments.isOpen || settings.isOpen) return;
      closePopover();
      if (confirmLayer) return closeConfirm();
      if (inspector.open) return inspector.hide();
      if (activeDrawer) return setDrawer(null);
      if (layout === 'tablet' && !docked) return setDocked(true);
      if (layout === 'phone' && sheet.index > 0) return sheet.snapTo(0);
      return;
    }
    if (typing || settings.isOpen || moments.isOpen || confirmLayer) return;
    if (clean && !/^[hH ]$/.test(e.key) && e.code !== 'Space') return;
    if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      host.setSpeed(host.speed() ? 0 : host.lastSpeed());
    } else if (e.key === '1') host.setSpeed(1);
    else if (e.key === '2') host.setSpeed(3);
    else if (e.key === '3') host.setSpeed(8);
    else if (e.key === 'h' || e.key === 'H') setClean(!clean);
    else if ((e.key === 'f' || e.key === 'F') && fsSupported) toggleFullscreen();
    else if (e.key === 'c' || e.key === 'C') {
      if (layout === 'phone') focusDocket();
      else setDocked(!docked);
    }
    else return;
    refresh(true);
  });

  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      closePopover();
      if (detectLayout()) refresh(true);
      updateInsets();
    });
  };
  addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);

  // Picks carry state ids: {personId} or {buildingId}.
  function normalisePick(pick) {
    return pick.personId != null ? {personId: pick.personId} : {buildingId: pick.buildingId};
  }

  function onInspectorChange(open) {
    // The renderer highlights the selection (a brighter building, a marker).
    world?.select?.(open ? inspector.target : null);
    if (!open) world?.follow?.(null);
    if (layout === 'phone') {
      if (open && phoneTab !== 'inspect') {
        prevPhoneTab = phoneTab;
        phoneTab = 'inspect';
        mountViews();
        sheet.snapTo(1);
      } else if (!open && phoneTab === 'inspect') {
        phoneTab = prevPhoneTab;
        mountViews();
        sheet.snapTo(0);
      }
      renderNav();
    }
    updateInsets();
  }

  // A styled confirm. actions: [{id, label, kind: 'ghost'|'secondary'|'danger', run}]
  let confirmLayer = null;
  function confirmDialog({title, text, actions}) {
    closeConfirm();
    settings.close();
    confirmLayer = h('div.confirm-layer', {role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-text'});
    const kinds = {ghost: 'btn-ghost', secondary: 'btn-secondary', danger: 'btn-primary btn-start'};
    confirmLayer.innerHTML = `<div class="confirm-card paper">
      <h2 id="confirm-title">${esc(title)}</h2>
      <p id="confirm-text">${esc(text)}</p>
      <div class="btn-row">${[{id: 'cancel', label: 'Cancel', kind: 'ghost'}, ...actions].map((a) => `<button class="btn ${kinds[a.kind] ?? 'btn-secondary'}" data-act="${a.id}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>
    </div>`;
    confirmLayer.addEventListener('click', (e) => {
      const id = e.target.closest('[data-act]')?.dataset.act;
      if (e.target === confirmLayer || id === 'cancel') return closeConfirm();
      const action = actions.find((a) => a.id === id);
      if (!action) return;
      if (action.keepOpen) action.run();
      else { closeConfirm(); action.run(); }
    });
    root.append(confirmLayer);
    syncLabels();
    requestAnimationFrame(() => confirmLayer?.querySelector('[data-act="cancel"]').focus());
  }

  // "Start a new town", with a way to keep the old one first.
  function confirmNewTown(opts = {}) {
    confirmDialog({
      title: 'Start a new town?',
      text: `${opts.seed ? `A new valley grows from the seed ${opts.seed}. ` : ''}Your town will be gone for good. Export it first if you want to keep it.`,
      actions: [
        {id: 'export', label: 'Export', icon: 'save', kind: 'secondary', keepOpen: true, run: () => host.exportSave()},
        {id: 'start', label: 'Start new', kind: 'danger', run: () => host.newTown(opts)},
      ],
    });
  }

  function confirmDissolve(bodyId) {
    const body = data.bodies.find((b) => b.id === bodyId);
    if (!body) return;
    const name = theName(body.name);
    confirmDialog({
      title: `Dissolve ${name}?`,
      text: `It will stop bringing you plans. Its rules stay in force.${body.power >= 0.5 ? ' It has many backers, and they will be angry.' : ''}`,
      actions: [{id: 'dissolve', label: 'Dissolve it', kind: 'danger', run: () => {
        const result = host.act('dissolveBody', bodyId);
        if (result === false || result?.ok === false) return notices.toast(M.actionError(result));
        notices.toast(`${cap(name)} is no more.`);
        setActiveBody('moot');
        refresh(true);
      }}],
    });
  }

  function setStandingOrder(bodyId, order) {
    const result = host.act('setStandingOrder', bodyId, order);
    if (result === false || result?.ok === false) return notices.toast(M.actionError(result));
    audio?.play('tick');
    refresh(true);
  }

  function closeConfirm() {
    confirmLayer?.remove();
    confirmLayer = null;
    syncLabels();
  }

  // ---------- full screen and clean view ----------
  const fsSupported = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  function toggleFullscreen() {
    if (!fsSupported) return;
    const el = document.documentElement;
    if (fsElement()) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
    else (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  }
  const onFullscreen = () => {
    renderRail();
    world?.resize?.();
    insetSig = '';
    requestAnimationFrame(updateInsets);
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);

  // Clean view hides every paper layer, for screenshots or just watching.
  const cleanLayer = h('div.clean-layer', {hidden: true});
  cleanLayer.innerHTML = `<p class="clean-hint">Press H to show</p><button class="restore-btn paper" type="button" aria-label="Show the controls">${icon('eye')}<span>Show</span></button>`;
  document.body.append(cleanLayer);
  let clean = false, restoreTimer = 0;
  cleanLayer.querySelector('.restore-btn').addEventListener('click', () => setClean(false));
  function setClean(on) {
    if (clean === Boolean(on)) return;
    clean = Boolean(on);
    closePopover();
    toggleClass(root, 'clean', clean);
    cleanLayer.hidden = !clean;
    cleanLayer.classList.remove('show-restore');
    if (clean) {
      const hint = cleanLayer.querySelector('.clean-hint');
      hint.textContent = matchMedia('(hover: none)').matches ? 'Tap the screen to show the controls' : 'Press H to show';
      hint.classList.remove('is-gone');
      setTimeout(() => hint.classList.add('is-gone'), 2000);
    }
    insetSig = '';
    updateInsets();
    syncLabels();
  }
  function offerRestore() {
    if (!clean) return;
    cleanLayer.classList.add('show-restore');
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => cleanLayer.classList.remove('show-restore'), 3000);
  }
  addEventListener('pointerdown', (e) => { if (clean && e.pointerType !== 'mouse') offerRestore(); }, true);
  addEventListener('pointermove', (e) => {
    if (!clean || e.pointerType !== 'mouse') return;
    const edge = 48;
    if (e.clientX < edge || e.clientY < edge || e.clientX > innerWidth - edge || e.clientY > innerHeight - edge) offerRestore();
  });

  function bindWorld() {
    world?.onPick?.((pick) => {
      if (pick && (pick.buildingId != null || pick.personId != null)) {
        inspector.show(normalisePick(pick));
        audio?.play('tick');
      } else inspector.hide();
    });
    world?.setOverlay?.(overlay);
  }
  bindWorld();

  detectLayout();
  sheet.snapTo(0, false);

  return {
    root,
    update(state, now, view) {
      frameView = view ?? frameView;
      refresh(false);
    },
    refresh: () => refresh(true),
    setWorld(next) {
      world = next;
      labelsShown = null;
      bindWorld();
      applyPrefs();
      insetSig = '';
      updateInsets();
    },
    notices,
    focusDocket,
    get layout() { return layout; },
    get docked() { return docked; },
    setDocked,
    setClean,
    get clean() { return clean; },
    toggleFullscreen,
    inspector,
    confirmNewTown,
    openView: (id) => (layout === 'phone' ? setPhoneTab(id) : DRAWER_VIEWS.some((d) => d.id === id) ? setDrawer(id) : setActiveBody(id)),
    sheet,
    settings,
  };
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v ?? fallback;
  } catch (err) {
    if (!safe.warned) { safe.warned = true; console.warn('[hearthvale] selector failed', err); }
    return fallback;
  }
}

function titleCase(id = '') {
  return String(id).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}


function reducedMs(ms) {
  return reduced() ? 0 : ms;
}
