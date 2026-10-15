// Inspector for a tapped person or building. The header comes at once from
// the sim (selectInspect and the narrator's fact sheet); then a short note,
// written by the narrator model, types in as it streams. "Why?" lists the
// facts the note used. The stream is aborted when the selection changes.
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
  const el = h('aside.inspector.paper', {hidden: true, 'aria-label': 'Selected', 'aria-live': 'polite'});
  el.innerHTML = `<header><div><h3></h3><p class="sub"></p></div>
      <button class="icon-btn locate" aria-label="Centre the view here" title="Centre here">${icon('locate')}</button>
      <button class="icon-btn close" aria-label="Close">${icon('close')}</button></header>
    <div class="chips head-chips"></div>
    <blockquote class="note" hidden><button class="icon-btn note-stale" type="button" disabled aria-label="Update the note" title="Nothing new yet">${icon('refresh')}</button><p class="note-text"></p><div class="shimmer" aria-hidden="true"><i></i><i></i></div><p class="note-when" hidden></p></blockquote>
    <details class="why" hidden><summary>Why?</summary><ul></ul></details>
    <dl class="details"></dl>
    <div class="btn-row actions"><button class="btn btn-secondary follow" hidden>${icon('people')}Follow</button></div>`;
  const $ = (s) => el.querySelector(s);
  $('.close').addEventListener('click', () => hide());
  $('.locate').addEventListener('click', () => model?.at && ctx.focusWorld(model.at));
  $('.follow').addEventListener('click', () => target && ctx.follow?.(target));
  $('.note-stale').addEventListener('click', () => narrate(true));

  let target = null, model = null, facts = null, key = null, sig = '';
  let controller = null, shown = '', goal = '', typing = 0;

  function renderHeader() {
    const head = headerOf(model, facts);
    const next = JSON.stringify([head, model?.rows]);
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
    $('.locate').hidden = !model?.at;
    $('.follow').hidden = target?.personId == null || !ctx.canFollow?.();
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
      $('.why').hidden = true;
      return;
    }
    const state = ctx.state();
    const peek = n.peekNote ? safePeek(n, state, target) : null;
    if (peek?.facts) facts = peek.facts;
    key = peek?.key ?? noteKey(facts);
    const lines = safeLines(n, facts);
    $('.why').hidden = !lines.length;
    $('.why ul').innerHTML = lines.slice(0, 6).map((l) => `<li>${esc(l)}</li>`).join('');
    $('.note').hidden = false;
    if (peek?.saved && !regenerate) {
      setGoal(peek.saved.text, true);
      setWhen(capWord(peek.saved.when ?? ''));
      setStale(peek.status === 'changed');
      n.noteFor?.(state, target, {peek}).catch?.(() => {});
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
    const onToken = (delta, soFar) => {
      if (mine.signal.aborted || reduced()) return;
      streamed = soFar ?? streamed + delta;
      setGoal(streamed);
    };
    const ask = n.noteFor && peek
      ? n.noteFor(state, target, {peek, signal: mine.signal, onToken, regenerate: true}).then((r) => r?.text)
      : n.narrate(facts, {signal: mine.signal, onToken});
    ask.then((text) => {
      if (mine.signal.aborted || !text) return;
      setGoal(text, !streamed);
    }).catch(() => {});
  }

  function setWhen(text) {
    const w = $('.note-when');
    setText(w, text);
    w.hidden = !text;
  }

  // The refresh icon sits quietly in the note's corner; it only lights up
  // when there is something new to say.
  function setStale(on) {
    const b = $('.note-stale');
    if (b.disabled === !on) return;
    b.disabled = !on;
    b.title = on ? 'Something has changed. Update the note' : 'Nothing new yet';
  }

  function noteKey(f) {
    if (!f || !ctx.narrator) return null;
    return (ctx.narrator.materialKey ?? ctx.narrator.factsKey)(f);
  }

  function load(pick) {
    model = ctx.inspect(pick);
    facts = ctx.narrator ? safeFacts(ctx.narrator, ctx.state(), pick) : null;
    return model || facts;
  }

  function hide() {
    controller?.abort();
    cancelAnimationFrame(typing);
    typing = 0;
    target = null;
    el.hidden = true;
    sig = '';
    ctx.onInspectorChange?.(false);
  }

  return {
    el,
    show(pick) {
      const same = target && JSON.stringify(target) === JSON.stringify(pick);
      target = pick;
      if (!load(pick)) return hide();
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
    },
    // At the panel's 4 Hz: refresh the header only. The note never changes
    // under the reader; a meaningful change offers an "update" link instead.
    refresh() {
      if (!target || el.hidden) return;
      if (!load(target)) return hide();
      renderHeader();
      const peek = ctx.narrator?.peekNote ? safePeek(ctx.narrator, ctx.state(), target) : null;
      setStale(Boolean(facts) && (peek ? peek.status === 'changed' || peek.key !== key : noteKey(facts) !== key));
    },
    hide,
    get open() { return Boolean(target) && !el.hidden; },
    get target() { return target; },
  };
}

function safeFacts(n, state, pick) {
  try { return n.facts(state, pick); } catch { return null; }
}

function safePeek(n, state, pick) {
  try { return n.peekNote(state, pick); } catch { return null; }
}

function safeLines(n, facts) {
  try { return n.whyLines(facts, {limit: 6}) ?? []; } catch { return []; }
}
