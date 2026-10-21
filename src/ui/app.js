// App shell. Mounts the paper layers over the canvas, routes view models
// from the sim's selectors into components, and grows the interface as
// selectUnlocks opens new surfaces (design-visual §8.2, design-systems §9.2).
//
// Layouts (data-layout on .ui):
//   desk   ≥ 1000 px: top bar, left rail + drawer, the Council button at the
//          right edge, time strip. The Council opens as a HUD panel over the
//          main area (between the rail or drawer and the dock, above the
//          time strip); it is not a dialog, so the top bar and time strip
//          stay in reach. The inspector sits at the bottom left.
//   tablet 720–999 px (or short landscape): the same, a little tighter.
//   phone  < 720 px: bottom sheet with snap points holds every view, the
//          Council among them; its peek carries the time controls and a
//          strip of every unlocked view. A selected thing shows as a card
//          above the peek.
// Notices share one stack below the top bar (top left; full width on
// phones): requests and other news that wants you linger, the town's
// happenings fade in a few seconds. Opening and closing panels never moves
// the camera: the scene's insets follow only the fixed chrome.
import './tokens.css';
import './layout.css';
import './components.css';
import {esc, h, setText, toggleClass} from './dom.js';
import {bodyIcon, icon, mountSprite} from './icons.js';
import {ERA_NAMES, cap, signed, theName} from './format.js';
import {reduced, setReducedMotion} from './motion.js';
import {createSheet} from './sheet.js';
import {createTopbar} from './components/topbar.js';
import {createTime} from './components/time.js';
import {createBodyView} from './components/body-view.js';
import {createRuleBook} from './components/rulebook.js';
import {createCouncil} from './components/council.js';
import {createTensions} from './components/tensions.js';
import {createPeople} from './components/people.js';
import {createChronicle} from './components/chronicle.js';
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
// The Chronicle view's lines, a page at a time; the notice stack needs only the latest.
const CHRONICLE_PAGE = 60;
const RECENT_LINES = 40;
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
// Phone strip order after the Council, and the snap each view opens at.
const NAV_VIEWS = ['rules', 'people', 'tensions', 'chronicle', 'places'];
const NAV_SNAP = {council: 2, rules: 2, chronicle: 2};
const UNLOCK_NAMES = {places: 'Places', ruleBook: 'The Rule Book', people: 'People', tensions: 'Tensions', overlays: 'The map', bodies: 'Body dashboards', debates: 'Debates', approval: 'Approval'};

// host.ui(req) gives a snapshot of the town (src/sim-snapshot.js), host.inspect(target)
// the inspector's bundle and host.act(name, ...args) an action's result: at once when
// the sim runs on this thread, as Promises when it runs in the sim worker. The app
// never reads the state itself.
export function createApp(host) {
  const {prefs, audio} = host;
  let world = host.world;
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
    townName: () => data.townName ?? null,
    reachedSpeed: () => host.reachedSpeed?.() ?? null,
    unlocks: () => data.unlocks,
    sound: (name, arg) => audio?.play(name, arg),
    onRule,
    onBudget,
    onAdviser,
    dismissAdviser: (a) => confirmDismissAdviser(a),
    dissolve: (id) => confirmDissolve(id),
    onMetric,
    openSettings: () => settings.open(),
    setSpeed: (s) => host.setSpeed(s),
    speed: () => host.speed(),
    lastSpeed: () => host.lastSpeed(),
    toggleMute: () => prefs.set('muted', !prefs.get('muted')),
    openEraPopover: (anchor, place = 'above') => openPopover(anchor, eraContent(data.era), {label: 'Toward the next age', place}),
    focusDocket,
    // The inspector's bundle for a pick: {model, facts, peek}, or a Promise of it.
    loadInspect: (pick) => {
      const b = host.inspect(pick);
      return typeof b?.then === 'function' ? b.then(inspectOf, () => null) : inspectOf(b);
    },
    // The bundle the last refresh brought for this pick, or null.
    inspected: (pick) => (data.inspect && sameTarget(data.inspect.target, pick) ? inspectOf(data.inspect) : null),
    focusWorld: (at) => world?.focus?.(at, 900),
    openBody: (id) => openCouncil({page: id}),
    openPlaces: () => (layout === 'phone' ? setPhoneTab('places') : setDrawer('places')),
    openRuleBook: (category) => openRuleBook(category),
    openDocket: (opts) => openDocket(opts),
    shortName: (b) => shortName(b),
    moreChronicle: () => { chronicleLimit += CHRONICLE_PAGE * 2; refresh(true); },
    onInspectorChange: (open) => onInspectorChange(open),
    narrator: host.narrator ?? null,
    notes: host.notes ?? null,
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

  // Live reframing while the drawer is dragged wider or narrower is gone:
  // panels never move the camera. The drawer still resizes.
  const drawerResize = createResize({root, panel: drawer, prefs, prefKey: 'drawerWidth', varName: '--drawer-user', edge: 'right', controls: 'drawer', label: 'View width'});
  drawer.append(drawerResize.el);

  // The dock: the Council's crest, always at the right edge.
  const dockUI = createRailColumn({cls: 'dock', label: 'Council', key: 'body', tileClass: 'dock-btn', tipSide: 'left', tip, onPick: () => council.toggle()});
  const dock = dockUI.el;

  const strip = h('footer.timestrip.paper');
  const stripTime = createTime(ctx, 'strip');
  strip.append(stripTime.el);

  const inspector = createInspector(ctx);
  const notices = createNotices({phone: () => layout === 'phone'});
  const moments = createMoments({
    root,
    onMomentOpened: () => { setClean(false); momentPaused = host.speed(); if (momentPaused) host.setSpeed(0); syncLabels(); },
    onMomentClosed: () => { if (momentPaused && !moments.isOpen) host.setSpeed(momentPaused); momentPaused = 0; syncLabels(); },
  });
  let momentPaused = 0;
  // The Council. The town keeps its pace while it is open; the time controls
  // stay in reach for a player who wants to stop and think.
  const council = createCouncil({
    ...ctx,
    bodyView: (id) => bodyView(id),
    onPage: () => refresh(true),
    onOpen: () => {
      closePopover();
      notices.stack.querySelector('[data-key="request"]')?.remove();
      // Notices wait, hidden, while the Council is open, and come back after.
      if (layout !== 'phone') notices.setHeld(true);
      toggleClass(root, 'council-open', true);
      audio?.play('slide');
      if (layout === 'phone' && (phoneTab !== 'council' || sheet.index === 0)) setPhoneTab('council', NAV_SNAP.council);
      // Open on what the app has now; the snapshot asked for next (from the worker,
      // a moment later) brings the Rule Book's areas and anything newer.
      feedCouncil();
      refresh(true);
    },
    onClose: () => {
      notices.setHeld(false);
      toggleClass(root, 'council-open', false);
      if (layout !== 'phone') audio?.play('tick');
      refresh(true);
    },
  });
  const settings = createSettings({
    root, prefs,
    decisionSettings: () => host.decisions.settings(),
    configureDecisions: (s) => host.decisions.configure(s),
    decisionStats: () => host.decisions.stats(),
    modelEnabled: () => host.decisions.enabled(),
    setModelEnabled: (on) => host.decisions.setEnabled(on),
    renderStats: () => safe(() => world?.stats?.(), null),
    power: () => safe(() => world?.power?.(), null),
    simMs: () => host.simMs(),
    getIndividualCap: () => data.individualCap ?? 2000,
    setIndividualCap: (v) => host.setIndividualCap(v),
    save: (manual) => host.save(manual),
    exportSave: () => host.exportSave(),
    importSave: (file) => host.importSave(file),
    newTown: (opts) => confirmNewTown(opts),
    toMenu: () => host.toMenu?.(),
    seedCode: () => host.seedCode?.(),
    hideInterface: () => { settings.close(); setClean(true); },
  });

  const sheet = createSheet({onSnap: (i, peekPx) => {
    root.style.setProperty('--peek', `${Math.round(peekPx)}px`);
    // The selected thing's card sits above the peek: a raised sheet would
    // cover it, so it closes.
    if (layout === 'phone' && i > 0 && inspector.open) inspector.hide();
    if (layout === 'phone' && phoneTab === 'council') {
      if (i > 0 && !council.isOpen) council.open();
      else if (i === 0 && council.isOpen) council.close();
    }
    updateInsets();
    closePopover();
  }});
  const peekTime = createTime(ctx, 'peek');
  sheet.peek.append(peekTime.el);
  const nav = createPhoneNav({onPick: onNav});
  sheet.tabs.append(nav.el);

  root.append(vignette, inspector.el, topbar.el, rail, drawer, council.el, dock, strip, ...notices.hosts, sheet.scrim, sheet.el);

  // ---------- views ----------
  const bodyViews = new Map();
  const views = {
    chronicle: createChronicle(ctx),
    people: createPeople(ctx),
    rules: createRuleBook(ctx),
    tensions: createTensions(ctx),
    places: createPlaces(ctx),
  };
  // phoneTab: the view in the phone sheet.
  let activeDrawer = null, phoneTab = 'council', overlay = 'none', chronicleLimit = CHRONICLE_PAGE;
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
    if (inspector.el.parentNode !== root) root.append(inspector.el);
    // Notices wait while the desk Council covers the main area (not on phones).
    notices.setHeld(layout !== 'phone' && council.isOpen);
    if (layout === 'phone') {
      const view = viewFor(phoneTab);
      if (sheet.body.firstChild !== view.el) sheet.body.replaceChildren(view.el);
      council.el.hidden = false;
      drawerBody.replaceChildren();
    } else {
      if (council.el.parentNode !== root) root.insertBefore(council.el, dock);
      council.el.hidden = !council.isOpen;
      if (activeDrawer) {
        const dv = views[activeDrawer];
        if (drawerBody.firstChild !== dv.el) drawerBody.replaceChildren(dv.el);
      }
      sheet.body.replaceChildren();
    }
  }

  function viewFor(id) {
    return id === 'council' ? council : views[id] ?? council;
  }

  // The Rule Book drawer (or phone tab), opened at one area when asked.
  function openRuleBook(category) {
    if (!data.unlocks.ruleBook) return;
    if (layout === 'phone') setPhoneTab('rules', 2);
    else if (activeDrawer !== 'rules') setDrawer('rules');
    views.rules.showArea(category ?? 'all');
  }

  // The Council at a body's page, or at the card asked for. opts: {page, cardId}
  function openCouncil(opts) {
    council.open(opts);
  }
  // Older callers name a page as a filter: {filter: 'body:<id>', cardId}.
  function openDocket(opts = {}) {
    const [kind, id] = String(opts.filter ?? '').split(':');
    openCouncil({page: kind === 'body' ? id : opts.page, cardId: opts.cardId});
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

  // On phones the Council is open while its tab shows in the raised sheet.
  function setPhoneTab(id, snap = 1) {
    if (id !== 'council' && phoneTab === 'council' && council.isOpen) {
      phoneTab = id;
      council.close();
    }
    phoneTab = id;
    fresh.delete(id);
    mountViews();
    sheet.body.scrollTop = 0;
    if (sheet.index < snap) sheet.snapTo(snap);
    else if (id === 'council' && !council.isOpen) council.open();
    renderNav();
    nav.reveal();
    audio?.play('tick');
    refresh(true);
  }

  // The dock holds one crest: the Council, with every request it waits on.
  function renderDock() {
    if (layout === 'phone') return;
    const isNew = data.bodies.some((b) => fresh.has(`body:${b.id}`));
    dockUI.update([{items: [{id: 'council', name: 'The Council (C)', tip: 'Council', icon: 'seal', count: countByKind(data.cards), fresh: isNew, pressed: council.isOpen, controls: 'council'}]}]);
  }

  function countByKind(cards) {
    return cards.filter((c) => c.kind !== 'report').length;
  }

  // People, scrolled to its Approval section.
  function openApproval() {
    if (layout === 'phone') setPhoneTab('people', 2);
    else if (activeDrawer !== 'people') setDrawer('people');
    refresh(true);
    requestAnimationFrame(() => views.people.showApproval());
  }

  function focusDocket(cardId) {
    openCouncil(cardId ? {cardId} : undefined);
  }

  function onMetric(key) {
    if (key === 'approval' && data.unlocks.approval) return openApproval();
    if (key === 'people' || key === 'wellbeing') {
      if (data.unlocks.people) return layout === 'phone' ? setPhoneTab('people') : setDrawer('people');
    }
    if (key === 'food' && data.bodies.some((b) => b.id === 'agri-council')) return openCouncil({page: 'agri-council'});
    focusDocket();
  }

  // ---------- rail ----------
  function renderRail() {
    const u = data.unlocks;
    const views = layout === 'phone' ? [] : DRAWER_VIEWS.filter((d) => u[d.unlock]).map((d) => ({id: d.id, name: d.label, icon: d.icon, pressed: activeDrawer === d.id, fresh: fresh.has(d.id), controls: 'drawer'}));
    const tools = [];
    // On phones the map lives in the sheet's view strip.
    if (u.overlays && layout !== 'phone') tools.push({id: 'map', name: 'Map', icon: 'layers', pressed: overlay !== 'none', fresh: fresh.has('map')});
    railUI.update([{items: views, scroll: true}, {items: tools}]);
  }

  function pickRail(id, el) {
    if (id === 'map') openMap(el);
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

  // Phone view strip: the Council (every body inside it), then the drawer
  // views and the map.
  function renderNav() {
    if (layout !== 'phone') return;
    const isNew = data.bodies.some((b) => fresh.has(`body:${b.id}`));
    const items = [{id: 'council', label: 'Council', icon: 'seal', count: countByKind(data.cards), fresh: isNew}];
    for (const id of NAV_VIEWS) {
      const d = DRAWER_VIEWS.find((v) => v.id === id);
      if (data.unlocks[d.unlock]) items.push({id, label: d.label, icon: d.icon, fresh: fresh.has(id)});
    }
    if (data.unlocks.overlays) items.push({id: 'map', label: 'Map', icon: 'layers', fresh: fresh.has('map'), pressed: overlay !== 'none'});
    if (!items.some((i) => i.id === phoneTab && i.id !== 'map')) {
      phoneTab = 'council';
      mountViews();
    }
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
    if (id === 'council' && phoneTab === 'council' && council.isOpen) return sheet.snapTo(NAV_SNAP.council);
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
  // An action runs where the town is, and its result may come back later. The same
  // action is not sent again while one is on its way, so a fast double click cannot
  // rule twice.
  const inFlight = new Set();
  function act(name, args, then) {
    const key = JSON.stringify([name, ...args]);
    if (inFlight.has(key)) return;
    const result = host.act(name, ...args);
    if (typeof result?.then !== 'function') return then(result);
    inFlight.add(key);
    result.then((r) => { inFlight.delete(key); then(r); }, (err) => {
      inFlight.delete(key);
      console.warn('[hearthvale] action failed', err);
      then({ok: false, text: 'That could not be done just now.'});
    });
  }

  // Budgets: strike a plan line, or answer the whole season at once.
  function onBudget(name, ...args) {
    act(name, args, (result) => {
      if (result && result.ok === false) {
        notices.toast(M.actionError(result));
        return;
      }
      audio?.play(name === 'strikeBudgetLine' ? 'tick' : 'chime');
      refresh(true);
    });
  }

  // Advisers: hire, mode, see others, let an answer stand.
  function onAdviser(name, ...args) {
    act(name, args, (result) => {
      if (result && result.ok === false) {
        notices.toast(M.actionError(result));
        return;
      }
      audio?.play(name === 'setAdviserMode' ? 'tick' : 'chime');
      refresh(true);
    });
  }

  function confirmDismissAdviser(adviser) {
    if (!adviser) return;
    confirmDialog({
      title: `Dismiss ${adviser.name}?`,
      text: `They are paid half a year's salary (${Math.round(adviser.salary / 2)} coin). The answers they have staged come back to you, and a new slate is drawn.${adviser.standing >= 60 ? ` They are well thought of: the ${adviser.trade === 'farm' ? 'farmers' : 'people of their trade'} will be sore.` : ''}`,
      actions: [{id: 'dismiss', label: 'Dismiss them', kind: 'danger', run: () => act('dismissAdviser', [adviser.id], (result) => {
        if (result?.ok === false) return notices.toast(M.actionError(result));
        notices.toast(`${adviser.name} is dismissed.`);
        refresh(true);
      })}],
    });
  }

  function onRule(card, option) {
    act('rule', [card.id, option.key], (result) => {
      if (result && result.ok === false) {
        notices.toast(M.actionError(result));
        return;
      }
      audio?.play(card.kind === 'report' ? 'tick' : 'chime');
      refresh(true);
    });
  }

  // ---------- growth, moments, nudges ----------
  let passSpeed = 0;
  function detectChanges() {
    const {unlocks, bodies, top, cards} = data;
    passSpeed = momentPaused || host.speed();
    if (prevUnlocks) {
      for (const [key, on] of Object.entries(unlocks)) {
        if (!on || prevUnlocks[key]) continue;
        const target = {ruleBook: 'rules', people: 'people', tensions: 'tensions', overlays: 'map', places: 'places', approval: 'people'}[key];
        if (target) fresh.add(target);
        if (key === 'approval') notices.nudge(`New: ${UNLOCK_NAMES[key]}`, {icon: 'hand', onClick: openApproval});
        else if (UNLOCK_NAMES[key]) {
          notices.nudge(`New: ${UNLOCK_NAMES[key]}`, {icon: 'spark', onClick: () => target && target !== 'map' && (layout === 'phone' ? setPhoneTab(target) : setDrawer(target))});
        }
      }
    }
    prevUnlocks = {...unlocks};

    if (prevEra != null && top.era > prevEra) {
      showMoment({eyebrow: `A new age · ${ERA_NAMES[top.era]}`, title: `Hearthvale is a ${top.eraName?.toLowerCase() ?? 'new place'} now`, text: lastMoment() ?? 'The town has grown into a new age.', icon: 'spark', sound: 'fanfare', camera: true});
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
      // From Borough the year's end also says where your standing is.
      const ap = unlocks.approval && Number.isFinite(top.approval)
        ? `Approval ${top.approval}%${Number.isFinite(top.approvalChange) ? ` (${top.approvalChange === 0 ? '±0' : signed(top.approvalChange)})` : ''}.` : '';
      notices.banner(`Year ${prevYear} ends`, [text || `Year ${top.year} begins.`, ap].filter(Boolean).join(' '),
        {key: 'year', icon: 'scroll', onClick: ap ? openApproval : undefined});
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
        // New requests never pause the town: they wait in the Council.
        announce(added);
      }
    }
    seenCards = new Set(cardIds);
    announceSeason(data.season);
    announceSlate(data.advisers);
  }

  // New cards never open a panel or take focus: a request notice lingers in
  // the stack (one at a time, "+2" for the rest) unless the Council is open
  // already (then the card simply animates in). It opens the Council at the
  // new card. The camera stays where the player left it.
  // Budget season opens with every body's card at once: one notice for the
  // season (it opens the season's page), never one per budget, so the
  // stack's other news is not pushed out.
  let seasonSaid = null;
  function announceSeason(season) {
    if (!season?.open || seasonSaid === season.year) return;
    seasonSaid = season.year;
    const n = season.total;
    notices.major({key: 'budget-season', icon: 'coin', title: `Budget season: ${n === 1 ? 'one body brings its budget' : `${n} bodies bring their budgets`}`,
      text: `For year ${season.year}. Unanswered, each keeps last year's figure.`, onClick: () => openCouncil({page: 'budgets'})});
  }

  // The bench: one notice when a seat opens or a slate is ready (it opens the
  // Advisers page), with what emptied the seat if one was left.
  let slateSaid = null;
  function announceSlate(adv) {
    const key = adv?.slate ? `${adv.slate.seatId}:${adv.slate.year}:${adv.slate.candidates.map((c) => c.id).join()}` : null;
    if (!key || key === slateSaid) return;
    // The bench opens at a year's turn: it waits until the year's notice has gone,
    // so the two never push each other (or anything else) out of the stack.
    if (notices.stack.querySelector('.notice-major[data-key="year"]:not([data-leaving])')) return;
    const first = slateSaid == null && !adv.seats.some((x) => x.adviser);
    slateSaid = key;
    const gone = adv.gone?.at(-1);
    const why = gone && gone.year >= (data.top?.year ?? 0) - 1 && !first ? `${gone.name} has ${gone.why === 'dismissed' ? 'been dismissed' : gone.why}. ` : '';
    notices.major({key: 'advisers', icon: 'quill', eyebrow: first ? 'Advisers' : 'The advisers\' bench',
      title: first ? 'The council takes on advisers' : 'A seat on the bench is open',
      text: `${why}Choose from ${adv.slate.candidates.length} townsfolk.`, onClick: () => openCouncil({page: 'advisers'})});
  }

  function announce(added) {
    // Budgets have their season's notice; cards an adviser will answer wait in the Council.
    added = added.filter((c) => c.kind !== 'budget' && !c.advice?.act);
    if (!added.length) return;
    if (council.isOpen && layout !== 'phone') return;
    if (council.isOpen && layout === 'phone' && sheet.index > 0) return;
    const first = added[0];
    const name = ctx.bodyName(first.from);
    const more = added.length > 1 ? added.length - 1 : 0;
    notices.major({key: 'request', icon: ctx.bodyIcon(first.from), eyebrow: `${cap(name)} asks`, title: first.title, badge: more ? `+${more}` : '', onClick: () => openCard(first)});
  }

  function openCard(card) {
    focusDocket(card.id);
  }

  // The town's happenings: each new chronicle line passes through the stack
  // as a short-lived note. Year ends and moments have notices of their own.
  let seenLine = null;
  function passHappenings(chronicle) {
    const key = (e) => e?.key ?? `${e?.year}|${e?.text}`;
    const last = key(chronicle.at(-1));
    if (seenLine == null || !chronicle.length) { seenLine = last ?? ''; return; }
    if (last === seenLine) return;
    let i = chronicle.length - 1;
    while (i >= 0 && key(chronicle[i]) !== seenLine) i--;
    // The last line seen has scrolled out of the window: show only the newest.
    const added = i < 0 ? chronicle.slice(-1) : chronicle.slice(i + 1);
    seenLine = last;
    // Event lines a council is already raising as a card, and lines that only
    // repeat a lingering notice (a year's end, a moment), are not shown twice.
    const raised = new Set();
    for (const c of data.cards) {
      if (String(c.templateId ?? '').startsWith('event:')) raised.add(c.templateId.slice(6));
      for (const s of c.subjects ?? []) if (String(s).startsWith('event:')) raised.add(s.slice(6));
      if (c.data?.event) raised.add(c.data.event);
    }
    for (const e of added.slice(-3)) {
      if (e.kind === 'year' || e.kind === 'moment') continue;
      if (e.refs?.event && raised.has(e.refs.event)) continue;
      // Budgets: the season has its own notice, your answers fold their cards
      // away, and the year's lapses are many at once: only a body's own
      // spending passes through as news.
      if (e.refs?.budgetSeason || (e.refs?.budget && (e.kind === 'decision' || e.refs.lapsed))) continue;
      // An adviser's answer passes only when you would otherwise miss it (the Council closed).
      if (e.refs?.adviserAnswer && council.isOpen) continue;
      if (e.refs?.advisers === 'unlocked' || e.refs?.advisers === 'hired') continue;
      if (notices.echoes(e.text)) continue;
      notices.minor({kind: e.kind, text: e.text, onClick: () => (layout === 'phone' ? setPhoneTab('chronicle', NAV_SNAP.chronicle) : activeDrawer !== 'chronicle' && setDrawer('chronicle'))});
    }
  }

  function lastMoment() {
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
    // Only the chrome that is always there frames the scene, so opening,
    // closing or resizing a panel never moves the camera.
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
      const d = dock.getBoundingClientRect();
      insets.right = d.width ? Math.round(W - d.left) : 0;
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
    if (!key || key === 'batterySaver') world?.setBatterySaver?.(prefs.get('batterySaver'));
    if (!key || key === 'dayCycle') world?.setDayCycle?.(prefs.get('dayCycle'));
    if (!key || key === 'peopleShadows') world?.setPeopleShadows?.(prefs.get('peopleShadows'));
    if (!key || key === 'treeShadows') world?.setTreeShadows?.(prefs.get('treeShadows'));
    if (key === 'muted') refresh(true);
  }
  prefs.onChange(applyPrefs);
  applyPrefs();

  // ---------- refresh ----------
  // A refresh asks the host for a snapshot of everything it shows (host.ui) and draws
  // it: at once on the inline host, when it comes from the sim worker. One request is
  // out at a time; a forced refresh asked for meanwhile follows it.
  let lastRefresh = -Infinity, frameView = null, refreshing = false, again = false;
  let asking = false, askAgain = false;
  // Waiting for the next drawn snapshot (app.refresh()'s Promise).
  let drawWaiters = [];
  function nextDraw() {
    if (!asking && !askAgain && !refreshing) return Promise.resolve();
    return new Promise((resolve) => drawWaiters.push(resolve));
  }
  function settleDraw() {
    if (asking || askAgain) return;
    const w = drawWaiters;
    drawWaiters = [];
    for (const fn of w) fn();
  }

  // Moments pause the town, and setSpeed asks for a refresh; never nest one
  // refresh inside another (change detection would run twice).
  function refresh(force) {
    exclusive(() => doRefresh(force));
  }

  function exclusive(fn) {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      fn();
    } finally {
      refreshing = false;
    }
    if (again) {
      again = false;
      queueMicrotask(() => refresh(true));
    } else settleDraw();
  }

  function doRefresh(force) {
    const now = performance.now();
    if (asking) {
      if (force) askAgain = true;
      return;
    }
    if (!force && now - lastRefresh < REFRESH_MS) return;
    lastRefresh = now;
    const factions = now - factionsAt > 2000;
    if (factions) factionsAt = now;
    const req = {recent: RECENT_LINES, factions, want: wantedViews(), chronicleLimit, inspect: inspector.open ? inspector.target : null};
    const reply = host.ui(req);
    if (typeof reply?.then !== 'function') {
      if (reply) draw(reply);
      return;
    }
    asking = true;
    reply.then((snap) => {
      asking = false;
      if (snap) exclusive(() => draw(snap));
      if (askAgain) {
        askAgain = false;
        refresh(true);
      }
      settleDraw();
    }, (err) => {
      asking = false;
      settleDraw();
      if (!safe.warned) { safe.warned = true; console.warn('[hearthvale] the town did not answer', err); }
    });
  }

  // The views on screen, for the snapshot: the drawer's (or the sheet's), the Council's
  // page, and the Rule Book's categories while the Council or the Rule Book is shown.
  function wantedViews() {
    const phone = layout === 'phone';
    const visible = phone ? [phoneTab] : [activeDrawer].filter(Boolean);
    const councilShown = council.isOpen || (phone && phoneTab === 'council');
    if (councilShown && council.page) visible.push(council.page);
    if (councilShown && !visible.includes('rules')) visible.push('rules');
    return visible;
  }

  function draw(snap) {
    const now = performance.now();
    const top = M.top(snap.top ?? data.top ?? {});
    const unlocks = snap.unlocks ?? {chronicle: true, docket: true};
    const cards = (snap.docket ?? []).map(M.card);
    const bodies = (snap.bodies ?? []).filter((b) => b.status !== 'dissolved').map(M.body);
    if (!bodies.some((b) => b.id === 'moot')) bodies.unshift({id: 'moot', kind: 'moot', name: 'The Council', metrics: [], rules: []});
    const eraRaw = snap.eraProgress ?? null;
    const era = M.era(eraRaw && {...eraRaw, year: eraRaw.year ?? top.year, floorYear: eraRaw.floorYear ?? (Number.isFinite(eraRaw.yearsToFloor) && eraRaw.yearsToFloor > 0 ? top.year + eraRaw.yearsToFloor : undefined)});
    const chronicle = M.chronicle(snap.chronicle ?? []);
    const events = snap.events ?? [];
    const centres = snap.centres ?? null;
    const liveCentres = (centres?.centres ?? []).filter((c) => !c.mergedInto);
    if (unlocks.places == null) unlocks.places = liveCentres.length >= 2;
    bodyNames = Object.fromEntries(bodies.map((b) => [b.id, b.name]));
    if ('factions' in snap) factionNames = Object.fromEntries((snap.factions ?? []).map((f) => [f.id, f.name]));
    const season = unlocks.budgets ? snap.season ?? null : null;
    const advisers = unlocks.advisers ? snap.advisers ?? null : null;
    data = {
      top, unlocks, cards, bodies, era, chronicle, events, centres, season, advisers, here: liveCentres.length >= 2 ? centreUnderCamera(liveCentres) : null,
      townName: snap.townName ?? null, individualCap: snap.individualCap ?? null, inspect: snap.inspect ?? null,
    };

    detectChanges();
    topbar.update(top, unlocks, data.here ? liveCentres.find((c) => c.id === data.here) : null);
    const timeData = {speed: host.speed(), top, era, muted: prefs.get('muted')};
    if (layout === 'phone') peekTime.update(timeData); else stripTime.update(timeData);
    renderDock();
    passHappenings(chronicle);
    renderRail();
    renderNav();
    updateViews(snap);
    inspector.refresh();
    const uNight = world?.internals?.grade?.uniforms?.uNight?.value;
    nightBeat = prefs.get('dayCycle') !== 'off' && (Number.isFinite(uNight) ? uNight > 0.5 : (frameView?.time?.yearT ?? 0) > 0.965);
    applyTheme();
    updateInsets();
    syncLabels();
    const sound = snap.audio ?? {};
    audio?.update({
      season: top.season, night: nightBeat ? 1 : 0, wind: Math.hypot(...(sound.wind ?? [0.3, 0])),
      population: top.people, festival: Boolean(sound.festival),
      building: sound.building ?? 0, running: host.speed() > 0,
      yearT: frameView?.time?.yearT, era: top.era, rain: sound.rain, snow: sound.snow,
      centres: liveCentres, world,
    });
  }

  // Views the snapshot did not bring (opened while it was on its way) keep what they
  // show, and a new snapshot is asked for.
  // The Council's data: the last snapshot's cards and bodies, and the areas with their
  // rules from the last snapshot that brought the Rule Book.
  let councilCats = [];
  function feedCouncil() {
    council.update({
      cards: data.cards,
      bodies: data.bodies,
      cats: councilCats,
      phone: layout === 'phone',
      unlockedRules: Boolean(data.unlocks.ruleBook),
      unlocks: data.unlocks,
      fresh,
      season: data.season,
      advisers: data.advisers,
    });
  }

  function updateViews(snap) {
    const panels = snap.panels ?? {};
    const brought = new Set(snap.want ?? []);
    const phone = layout === 'phone';
    const visible = phone ? [phoneTab] : [activeDrawer].filter(Boolean);
    // The Council shows one body's page at a time (the Town Council's too);
    // on phones it is drawn whenever its tab is the sheet's.
    const councilShown = council.isOpen || (phone && phoneTab === 'council');
    if (councilShown && council.page) visible.push(council.page);
    let rules = null;
    const needRules = visible.includes('rules') || councilShown;
    // The Rule Book view lists rules in force; the Council names every open area.
    let allCats = [];
    if (needRules && brought.has('rules')) {
      const raw = panels.ruleBook ?? [];
      rules = M.ruleBook(raw);
      allCats = raw.filter((c) => c.open !== false).map((c) => ({id: c.id, name: c.name ?? c.title}));
    }
    if (councilShown && brought.has('rules')) {
      // Area names for every category the cards use, with the rules in force.
      const inForce = new Map((rules ?? []).map((c) => [c.id, c]));
      councilCats = allCats.map((c) => ({...c, policies: inForce.get(c.id)?.policies ?? []}));
      feedCouncil();
      fresh.delete(`body:${council.page}`);
    }
    // Closed, the Chronicle starts again from its latest page.
    if (!visible.includes('chronicle')) chronicleLimit = CHRONICLE_PAGE;
    let missing = false;
    for (const id of visible) {
      if (id === 'council') continue;
      if (id !== 'places' && !brought.has(id)) { missing = true; continue; }
      if (id === 'rules') views.rules.update(rules);
      else if (id === 'people') {
        views.people.update(data.top, panels.factions ?? [], {
          show: data.unlocks.compass, compass: data.unlocks.compass ? panels.compass ?? null : null,
          showApproval: Boolean(data.unlocks.approval), approval: data.unlocks.approval ? panels.approval ?? null : null,
        });
      }
      else if (id === 'chronicle') {
        const lines = M.chronicle(panels.chronicle ?? []);
        const total = panels.chronicleTotal ?? lines.length;
        views.chronicle.update(lines, {show: data.unlocks.endPreview, summary: data.unlocks.endPreview ? panels.endPreview ?? null : null, centres: (data.centres?.centres ?? []).filter((c) => !c.mergedInto).map((c) => ({id: c.id, name: c.name})), earlier: total > lines.length});
      }
      else if (id === 'tensions') views.tensions.update(M.tensions(panels.tensions ?? []));
      else if (id === 'places') views.places.update(data.centres, data.here);
      else {
        const body = data.bodies.find((b) => b.id === id);
        const purse = id === 'moot' && data.unlocks.budget ? panels.budget ?? null : null;
        if (body) bodyView(id).update(body, {cards: data.cards, unlocks: data.unlocks, purse});
      }
    }
    if (missing || (needRules && !brought.has('rules'))) queueMicrotask(() => refresh(true));
    if (councilShown) council.fit();
  }

  // ---------- input ----------
  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (clean) return setClean(false);
      // Open dialogs (title cards, settings, the Rule Book) handle Esc
      // themselves; this catches it when focus is somewhere else.
      if (moments.isOpen) return moments.close();
      if (settings.isOpen) return settings.close();
      closePopover();
      if (confirmLayer) return closeConfirm();
      if (inspector.open) return inspector.hide();
      if (council.isOpen && layout !== 'phone') return council.close();
      if (activeDrawer) return setDrawer(null);
      if (layout === 'phone' && sheet.index > 0) return sheet.snapTo(0);
      // With nothing else open, Esc puts away the notices on screen.
      return notices.dismissAll();
    }
    if (typing || settings.isOpen || moments.isOpen || confirmLayer) return;
    if (clean && !/^[hH ]$/.test(e.key) && e.code !== 'Space') return;
    if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      host.setSpeed(host.speed() ? 0 : host.lastSpeed());
    } else if (e.key === '1') host.setSpeed(1);
    else if (e.key === '2') host.setSpeed(3);
    else if (e.key === '3') host.setSpeed(5);
    else if (e.key === '4') host.setSpeed(10);
    else if (e.key === '5') host.setSpeed(20);
    else if (e.key === 'h' || e.key === 'H') setClean(!clean);
    else if ((e.key === 'f' || e.key === 'F') && fsSupported) toggleFullscreen();
    else if (/^[cCdD]$/.test(e.key)) {
      if (layout === 'phone') return phoneTab === 'council' && sheet.index > 0 ? sheet.snapTo(0) : setPhoneTab('council', NAV_SNAP.council);
      return council.toggle();
    }
    else if ((e.key === 'r' || e.key === 'R') && data.unlocks.ruleBook) return layout === 'phone' ? setPhoneTab('rules', 2) : setDrawer('rules');
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
    // On phones the card floats above the peek: lower the sheet to show it.
    if (layout === 'phone' && open && sheet.index > 0) sheet.snapTo(0);
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

  // "Start a new town". The old town stays saved in Your towns on the main menu.
  function confirmNewTown(opts = {}) {
    confirmDialog({
      title: 'Start a new town?',
      text: `${opts.seed ? `A new valley grows from the seed ${opts.seed}. ` : ''}This town is saved first and stays in Your towns on the main menu.`,
      actions: [
        ...(opts.seed ? [] : [{id: 'choose', label: 'Choose a valley', kind: 'secondary', run: () => host.newTown({choose: true})}]),
        {id: 'start', label: opts.seed ? 'Start new' : 'Start in a random valley', kind: 'danger', run: () => host.newTown(opts)},
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
      actions: [{id: 'dissolve', label: 'Dissolve it', kind: 'danger', run: () => act('dissolveBody', [bodyId], (result) => {
        if (result === false || result?.ok === false) return notices.toast(M.actionError(result));
        notices.toast(`${cap(name)} is no more.`);
        council.setPage('moot');
        refresh(true);
      })}],
    });
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

  // A quiet note when the world starts saving power by itself (unplugged
  // with 'On battery', or a low battery), not when the player chose Always.
  let unbindPower = null, wasSaving = false;
  function bindWorld() {
    unbindPower?.();
    wasSaving = safe(() => world?.power?.()?.saving, false);
    unbindPower = world?.onPowerChange?.((p) => {
      if (p.saving && !wasSaving && p.mode !== 'always') {
        notices.toast(p.lowBattery ? 'Battery low: the town draws less to save power.' : 'On battery: Battery saver is on. Change it in Settings → Display.', 6000);
      }
      wasSaving = p.saving;
    }) ?? null;
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
    // Resolves once the town as it is now is drawn (at once on the inline host).
    refresh: () => {
      if (asking) askAgain = true;
      else refresh(true);
      return nextDraw();
    },
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
    setClean,
    get clean() { return clean; },
    toggleFullscreen,
    inspector,
    confirmNewTown,
    openView: (id) => (id === 'docket' || id === 'council' ? openCouncil() : DRAWER_VIEWS.some((d) => d.id === id) ? (layout === 'phone' ? setPhoneTab(id) : setDrawer(id)) : openCouncil({page: id})),
    council,
    docket: council,
    openCouncil,
    openDocket,
    openRuleBook,
    sheet,
    settings,
  };
}

// The inspector's bundle with the selector's model mapped for the header.
function inspectOf(b) {
  return b ? {model: M.inspect(b.model ?? null), facts: b.facts ?? null, peek: b.peek ?? null} : null;
}

function sameTarget(a, b) {
  return Boolean(a && b) && (a.personId ?? null) === (b.personId ?? null) && (a.buildingId ?? null) === (b.buildingId ?? null);
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
