// Inspector for a tapped person or building. The header comes from the sim's
// bundle for the pick (ctx.loadInspect: selectInspect, the narrator's fact sheet
// and the kept note, from wherever the town runs); then a short note,
// written by the narrator model, types in as it streams. The actions row at
// the foot holds Follow (people) or Locate (buildings), Why? (the facts the
// note used) and Refresh (write the note again), on one line. The stream is aborted when the selection
// changes.
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {enter, reduced} from '../motion.js';
import {num} from '../format.js';

const TRADES = {
  trade: 'Merchant', craft: 'Maker', farm: 'Farmer', labour: 'Labourer', clerical: 'Clerk',
  clergy: 'Clergy', gentry: 'Gentry', none: 'Neighbour',
};
const TYPE_WORDS = {home: 'Home', farm: 'Farm', workshop: 'Workshop', mill: 'Mill', shop: 'Shop', market: 'Market', inn: 'Inn', chapel: 'Chapel', school: 'School'};
const CHARS_PER_SECOND = 70;
const WHY_ID = 'inspector-why';

function capWord(s = '') {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Header model: title, subtitle and chips, from facts when we have them.
function headerOf(model, facts) {
  const title = facts?.name ?? model?.title ?? 'Here';
  const chips = [];
  let subtitle = model?.subtitle ?? null;
  if (facts?.kind === 'person') {
    subtitle = [TRADES[facts.who?.trade] ?? capWord(facts.who?.trade), facts.who?.district].filter(Boolean).join(' · ');
    if (facts.now?.mood) chips.push(['mood', capWord(facts.now.mood), /angry|unhappy|uneasy/.test(facts.now.mood) ? 'down' : 'up']);
    if (facts.now?.wealth) chips.push(['wealth', capWord(facts.now.wealth), facts.now.wealthTrend === 'falling' ? 'down' : '']);
    if (facts.now?.doing) chips.push(['doing', capWord(facts.now.doing), '']);
  } else if (facts?.kind === 'building' && facts.building) {
    const b = facts.building;
    subtitle = [capWord(b.variant ?? TYPE_WORDS[b.type] ?? b.type), facts.who?.district].filter(Boolean).join(' · ');
    if (b.tier) chips.push(['tier', `Tier ${b.tier}`, '']);
    if (Number.isFinite(b.age)) chips.push(['age', `${num(b.age)} years old`, '']);
    if (facts.residents?.people) chips.push(['people', `${num(facts.residents.people)} live here`, '']);
    if (b.condition) chips.push(['condition', capWord(b.condition), /poor|falling|shabby/.test(b.condition) ? 'down' : '']);
  }
  return {title, subtitle, chips};
}

export function createInspector(ctx) {
  const el = h('aside.inspector.paper', {hidden: true, 'aria-label': 'Selected'});
  // One actions row at the foot of the popup: every per-thing action in one
  // place, same style, 44 px targets. Close stays in the corner.
  el.innerHTML = `<header><div><h3></h3><p class="sub"></p></div>
      <button class="icon-btn close" aria-label="Close" title="Close (Esc)">${icon('close')}</button></header>
    <div class="chips head-chips"></div>
    <p class="objective" hidden></p>
    <span class="sr-only note-status" role="status" aria-live="polite"></span>
    <blockquote class="note" hidden><p class="note-text"></p><div class="shimmer" aria-hidden="true"><span class="note-loading">Loading…</span><i></i><i></i></div><p class="note-when" hidden></p></blockquote>
    <dl class="details"></dl>
    <div class="why" id="${WHY_ID}" hidden><h4>Why they say so</h4><ul></ul></div>
    <div class="inspector-actions" role="toolbar" aria-label="Actions">
      <button class="btn btn-secondary act-btn" type="button" data-act="locate" hidden>${icon('locate')}<span>Locate</span></button>
      <button class="btn btn-secondary act-btn" type="button" data-act="follow" hidden>${icon('people')}<span>Follow</span></button>
      <button class="btn btn-secondary act-btn" type="button" data-act="why" aria-expanded="false" aria-controls="${WHY_ID}" hidden>${icon('info')}<span>Why?</span></button>
      <button class="btn btn-secondary act-btn" type="button" data-act="refresh" disabled hidden title="Nothing new yet">${icon('refresh')}<span>Refresh</span></button>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const act = (name) => el.querySelector(`[data-act="${name}"]`);
  $('.close').addEventListener('click', () => hide());
  act('locate').addEventListener('click', () => model?.at && ctx.focusWorld(model.at));
  act('follow').addEventListener('click', () => target && ctx.follow?.(target));
  act('why').addEventListener('click', () => {
    const open = act('why').getAttribute('aria-expanded') !== 'true';
    setWhyOpen(open);
    if (open) $('.why').scrollIntoView?.({block: 'nearest'});
  });
  act('refresh').addEventListener('click', () => narrate(true));

  function setWhyOpen(open) {
    act('why').setAttribute('aria-expanded', String(open));
    $('.why').hidden = !open || act('why').hidden;
  }

  let target = null, model = null, facts = null, peek = null, key = null, sig = '';
  let controller = null, shown = '', goal = '', typing = 0;

  function renderHeader() {
    const head = headerOf(model, facts);
    const next = JSON.stringify([head, model?.rows, model?.objective]);
    if (next === sig) return;
    sig = next;
    setText($('h3'), head.title);
    setText($('.sub'), head.subtitle ?? '');
    $('.sub').hidden = !head.subtitle;
    $('.head-chips').innerHTML = head.chips.map(([k, text, tone]) => `<span class="chip ${tone}" data-chip="${k}">${esc(text)}</span>`).join('');
    // With a fact sheet the chips already say it; rows are the fallback.
    const rows = facts ? [] : (model?.rows ?? []).slice(0, 6);
    $('.details').innerHTML = rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join('');
    $('.details').hidden = !rows.length;
    // A person who can be followed gets Follow (it brings the camera along
    // too); Locate is for buildings and for people the renderer cannot follow.
    const follow = target?.personId != null && Boolean(ctx.canFollow?.());
    act('follow').hidden = !follow;
    // What a person is up to, under the chips: flavour text only.
    const obj = model?.objective;
    $('.objective').hidden = !obj?.text;
    setText($('.objective'), obj?.text ?? '');
    act('locate').hidden = !model?.at || follow;
  }

  // Typewriter: reveal the goal text a few characters per frame.
  function tick() {
    typing = 0;
    if (shown.length >= goal.length || !goal.startsWith(shown)) {
      shown = goal;
    } else {
      shown = goal.slice(0, Math.min(goal.length, shown.length + Math.max(1, Math.round(CHARS_PER_SECOND / 60))));
    }
    setText($('.note-text'), shown);
    if (shown !== goal) typing = requestAnimationFrame(tick);
  }

  function setGoal(text, instant) {
    goal = text;
    $('.note').classList.toggle('is-waiting', !text);
    if (instant || reduced()) {
      cancelAnimationFrame(typing);
      typing = 0;
      shown = goal;
      setText($('.note-text'), shown);
    } else if (!typing) typing = requestAnimationFrame(tick);
  }

  // Kept notes (narrator's peekNote/noteFor). A saved note shows at once,
  // as written, even if things have changed since: the refresh icon lights
  // up instead, and only a click asks for a new note. With no note saved,
  // a shimmer waits and the new note types in. The text never changes under
  // the reader on its own.
  function narrate(regenerate = false) {
    controller?.abort();
    const n = ctx.narrator;
    if (!n || !facts) {
      $('.note').hidden = true;
      act('why').hidden = true;
      act('refresh').hidden = true;
      setWhyOpen(false);
      return;
    }
    act('refresh').hidden = false;
    if (peek?.facts) facts = peek.facts;
    key = peek?.key ?? noteKey(facts);
    const lines = safeLines(n, facts);
    act('why').hidden = !lines.length;
    setWhyOpen(act('why').getAttribute('aria-expanded') === 'true');
    $('.why ul').innerHTML = lines.slice(0, 6).map((l) => `<li>${esc(l)}</li>`).join('');
    $('.note').hidden = false;
    if (peek?.saved && !regenerate) {
      setGoal(peek.saved.text, true);
      setWhen(capWord(peek.saved.when ?? ''));
      setStale(peek.status === 'changed');
      n.noteFor?.(null, target, {peek, notes: ctx.notes}).catch?.(() => {});
      return;
    }
    controller = new AbortController();
    const mine = controller;
    setStale(false);
    setWhen('');
    shown = '';
    goal = '';
    setText($('.note-text'), '');
    $('.note').classList.add('is-waiting');
    let streamed = '';
    $('.note').setAttribute('aria-busy', 'true');
    setText($('.note-status'), '');
    const onToken = (delta, soFar) => {
      if (mine.signal.aborted) return;
      streamed = soFar ?? streamed + delta;
      setGoal(streamed, true);
    };
    const ask = n.noteFor && peek
      ? n.noteFor(null, target, {peek, notes: ctx.notes, signal: mine.signal, onToken, regenerate: true}).then((r) => r?.text)
      : n.narrate(facts, {signal: mine.signal, onToken});
    ask.then((text) => {
      if (mine.signal.aborted || !text) return;
      setGoal(text, true);
      $('.note').removeAttribute('aria-busy');
      setText($('.note-status'), 'Town note ready.');
    }).catch(() => {});
  }

  function setWhen(text) {
    const w = $('.note-when');
    setText(w, text);
    w.hidden = !text;
  }

  // Refresh waits, dimmed, until there is something new to say.
  function setStale(on) {
    const b = act('refresh');
    if (b.disabled === !on) return;
    b.disabled = !on;
    b.title = on ? 'Something has changed. Write the note again' : 'Nothing new yet';
    b.setAttribute('aria-label', on ? 'Refresh the note: something has changed' : 'Refresh the note (nothing new yet)');
  }

  function noteKey(f) {
    if (!f || !ctx.narrator) return null;
    return (ctx.narrator.materialKey ?? ctx.narrator.factsKey)(f);
  }

  // Takes a bundle ({model, facts, peek}); false when the thing is gone.
  function load(bundle) {
    model = bundle?.model ?? null;
    facts = ctx.narrator ? bundle?.facts ?? null : null;
    peek = ctx.narrator?.peekNote ? bundle?.peek ?? null : null;
    return Boolean(model || facts);
  }

  function hide() {
    showing++;
    controller?.abort();
    cancelAnimationFrame(typing);
    typing = 0;
    target = null;
    el.hidden = true;
    setWhyOpen(false);
    sig = '';
    ctx.onInspectorChange?.(false);
  }

  // The bundle may come later (the sim worker): the pick shows when it lands, unless
  // another pick or a close came first.
  let showing = 0;
  function show(pick) {
    const ticket = ++showing;
    const bundle = ctx.loadInspect(pick);
    if (typeof bundle?.then === 'function') bundle.then((b) => { if (ticket === showing) showBundle(pick, b); });
    else showBundle(pick, bundle);
  }

  function showBundle(pick, bundle) {
    const same = target && JSON.stringify(target) === JSON.stringify(pick);
    target = pick;
    if (!load(bundle)) return hide();
    if (!same) setWhyOpen(false);
    renderHeader();
    const nextKey = noteKey(facts);
    if (!same || nextKey !== key) {
      key = nextKey;
      narrate();
    }
    if (el.hidden) {
      el.hidden = false;
      enter(el);
      ctx.onInspectorChange?.(true);
    }
  }

  return {
    el,
    show,
    // At the panel's 4 Hz: refresh the header only. The note never changes
    // under the reader; a meaningful change offers an "update" link instead.
    refresh() {
      if (!target || el.hidden) return;
      // Only a refresh that brought this pick's bundle has anything new.
      const bundle = ctx.inspected(target);
      if (!bundle) return;
      if (!load(bundle)) return hide();
      renderHeader();
      setStale(Boolean(facts) && (peek ? peek.status === 'changed' || peek.key !== key : noteKey(facts) !== key));
    },
    hide,
    get open() { return Boolean(target) && !el.hidden; },
    get target() { return target; },
  };
}

function safeLines(n, facts) {
  try { return n.whyLines(facts, {limit: 6}) ?? []; } catch { return []; }
}
