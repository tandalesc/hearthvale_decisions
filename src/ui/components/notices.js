// Notifications (design-visual §8.6). One stack below the top bar, at the
// top left beside the rail (full width on phones), so the town's news sits
// by the Chronicle it comes from. Two kinds share it:
//   major: what wants you: a body's new request, a year's end, a new
//          surface, a moment you chose not to stop for. Solid paper, a crest,
//          a close button; lingers (about 20 s). One per key: a newer one
//          with the same key takes its place (requests count "+2").
//   minor: the town's happenings, the chronicle lines as they come. Light
//          single-line pills under the majors; gone in a few seconds.
// Majors sit above minors, the newest of each first. Every notice waits
// while the pointer or keyboard focus is on it, and swipes away sideways on
// touch. Toasts (what your own action did) stay apart, at the top centre.
// Nothing here asks for an answer: what a notice says also lands in the
// Chronicle or the Council.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {animate, EASE} from '../motion.js';

const MAJOR_MS = 20000;
const MINOR_MS = 6000;
const PHONE_MINOR_MS = 5000;
const MAX_MAJOR = 2;
const MAX_MINOR = 3;
const PHONE_MAX_MINOR = 2;
const SWIPE_PX = 64;

function closeButton(label) {
  const b = h('button.notice-close', {type: 'button', 'aria-label': label, title: label});
  b.innerHTML = icon('close');
  return b;
}

// A timer that stops while the notice is hovered or focused, then runs
// out its remaining time.
// Notices held all together (the stack hidden while the Council is open):
// each live timer's sync, so a hold or release reaches every one at once.
const held = {on: false, syncs: new Set()};

function holdTimer(el, ms, done) {
  let left = ms, started = performance.now(), id = setTimeout(done, ms), over = false, focused = false, stopped = false;
  const sync = () => {
    if (stopped) return;
    const isHeld = over || focused || held.on;
    if (isHeld && id) {
      clearTimeout(id);
      id = 0;
      left = Math.max(1500, left - (performance.now() - started));
    } else if (!isHeld && !id) {
      started = performance.now();
      id = setTimeout(done, left);
    }
  };
  held.syncs.add(sync);
  if (held.on) sync();
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { over = true; sync(); } });
  el.addEventListener('pointerleave', () => { over = false; sync(); });
  el.addEventListener('focusin', () => { focused = true; sync(); });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) { focused = false; sync(); } });
  return () => { stopped = true; clearTimeout(id); id = 0; held.syncs.delete(sync); };
}

// Swipe a notice sideways to put it away (touch and pen only).
export function swipeAway(el, onAway) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    start = {x: e.clientX, y: e.clientY, dx: 0, lock: null, id: e.pointerId};
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (start.lock == null && Math.hypot(dx, dy) > 8) {
      start.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (start.lock === 'x') {
        try { el.setPointerCapture?.(e.pointerId); } catch { /* the pointer is gone */ }
      }
    }
    if (start.lock !== 'x') return;
    start.dx = dx;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220));
  });
  const end = () => {
    if (!start) return;
    const {dx, lock} = start;
    start = null;
    if (lock === 'x' && Math.abs(dx) > SWIPE_PX) {
      el.dataset.swiped = '1';
      // Swallow the click that may follow the swipe.
      el.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, {capture: true, once: true});
      setTimeout(() => delete el.dataset.swiped, 400);
      animate(el, [{transform: `translateX(${dx}px)`, opacity: el.style.opacity}, {transform: `translateX(${Math.sign(dx) * 320}px)`, opacity: 0}], {duration: 160, easing: EASE.in, fill: 'forwards'})
        .then(() => onAway());
      return;
    }
    el.style.transform = '';
    el.style.opacity = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

export function createNotices({phone = () => false} = {}) {
  const stack = h('div.notice-stack', {'aria-live': 'polite', 'aria-label': 'News'});
  const majors = h('div.notice-majors');
  const minors = h('div.notice-minors');
  stack.append(majors, minors);
  const toastHost = h('div.toasts', {'aria-live': 'polite'});
  let stopToast = null;
  // What the lingering notices said lately, so a happening that only repeats
  // one of them (a year's end, a moment) is not shown twice.
  const said = [];
  const SAID_MS = 20000;
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stops = new WeakMap();

  async function dismiss(el) {
    if (!el?.isConnected || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    stops.get(el)?.();
    el.classList.add('is-leaving');
    if (!el.dataset.swiped) await animate(el, [{opacity: 1}, {opacity: 0}], {duration: 220, easing: EASE.in, fill: 'forwards'});
    el.remove();
  }

  const live = (host) => [...host.children].filter((c) => !c.dataset.leaving);

  function place(host, el, ms, max) {
    host.prepend(el);
    animate(el, [{opacity: 0, transform: 'translateY(-6px)'}, {opacity: 1, transform: 'none'}], {duration: 260, easing: EASE.out});
    stops.set(el, holdTimer(el, ms, () => dismiss(el)));
    // Too many: the oldest goes first.
    const items = live(host);
    for (const old of items.slice(max)) dismiss(old);
  }

  // {key, icon, eyebrow, title, text, badge, ms, onClick}
  function major(m) {
    said.push({at: performance.now(), text: norm(`${m.title ?? ''} ${m.text ?? ''}`)});
    if (said.length > 12) said.shift();
    if (m.key) for (const old of live(majors)) if (old.dataset.key === m.key) { stops.get(old)?.(); old.remove(); }
    const el = h('div.notice.notice-major.paper', {role: 'status', 'data-key': m.key ?? ''});
    const main = h('button.notice-main', {type: 'button'});
    main.innerHTML = `<span class="seal-icon">${icon(m.icon ?? 'bell')}</span><span class="notice-text">${m.eyebrow ? `<b class="notice-eyebrow">${esc(m.eyebrow)}</b>` : ''}<span class="notice-title">${esc(m.title ?? '')}</span>${m.text ? `<span class="notice-body">${esc(m.text)}</span>` : ''}</span>${m.badge ? `<span class="badge">${esc(m.badge)}</span>` : ''}`;
    if (!m.onClick) main.disabled = true;
    const away = () => dismiss(el);
    main.addEventListener('click', () => { m.onClick?.(); away(); });
    const close = closeButton('Dismiss');
    close.addEventListener('click', (e) => { e.stopPropagation(); away(); });
    el.append(main, close);
    swipeAway(el, away);
    place(majors, el, m.ms ?? MAJOR_MS, MAX_MAJOR);
    return el;
  }

  // {kind, text, onClick}
  function minor(m) {
    const el = h('button.notice.notice-minor.paper', {type: 'button', 'data-kind': m.kind ?? 'line'});
    el.innerHTML = `<span>${esc(m.text)}</span>`;
    const away = () => dismiss(el);
    el.addEventListener('click', () => { m.onClick?.(); away(); });
    swipeAway(el, away);
    place(minors, el, phone() ? PHONE_MINOR_MS : MINOR_MS, phone() ? PHONE_MAX_MINOR : MAX_MINOR);
    return el;
  }

  // True when a lingering notice said this lately (one text contains the other).
  function echoes(text) {
    const t = norm(text);
    if (!t) return false;
    const now = performance.now();
    return said.some((s) => now - s.at < SAID_MS && s.text && (s.text.includes(t) || t.includes(s.text)));
  }

  return {
    hosts: [stack, toastHost],
    stack,
    major,
    minor,
    echoes,
    // Hold every notice (timers stop) and hide the stack, or let them go on.
    // The Council does this while it is open; what was showing comes back after.
    setHeld(on) {
      if (held.on === Boolean(on)) return;
      held.on = Boolean(on);
      stack.classList.toggle('is-held', held.on);
      for (const sync of held.syncs) sync();
    },
    // A short pill: a new surface and the like.
    nudge(text, {onClick, key, icon: iconName, ms} = {}) {
      return major({title: text, onClick, key, icon: iconName ?? 'spark', ms});
    },
    // A line with a heading: the year's end, a moment.
    banner(title, text, opts = {}) {
      return major({title, text, key: opts.key, icon: opts.icon ?? 'scroll', ms: opts.ms, onClick: opts.onClick});
    },
    toast(text, ms = 3600) {
      stopToast?.();
      const el = h('div.toast', {role: 'status'});
      const away = () => { stopToast?.(); dismiss(el); };
      const close = closeButton('Dismiss');
      close.addEventListener('click', away);
      el.append(h('span.toast-text', text), close);
      swipeAway(el, away);
      toastHost.replaceChildren(el);
      stopToast = holdTimer(el, ms, () => dismiss(el));
    },
    // Put away every notice on screen.
    dismissAll() {
      stopToast?.();
      for (const el of [...toastHost.children, ...majors.children, ...minors.children]) dismiss(el);
    },
    clear() { majors.replaceChildren(); minors.replaceChildren(); },
  };
}
