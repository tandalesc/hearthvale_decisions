// Phone bottom sheet (design-visual §8.1): snap points at the peek (the
// head: grip, time controls and the view strip), 55 % and 92 % of the
// viewport, plus the bottom safe area. Drag the grip or
// header; a release faster than 0.4 px/ms moves to the next snap in that
// direction. The scene is blocked by a scrim while the sheet is above peek.
import {h} from './dom.js';
import {reduced} from './motion.js';

const PEEK = 116; // fallback before the head has been laid out
const VELOCITY = 0.4;

export function createSheet({onSnap} = {}) {
  const el = h('section.sheet.paper', {'aria-label': 'Town ledger'});
  const grip = h('button.sheet-grip', {type: 'button', 'aria-label': 'Expand or collapse the ledger'}, h('i'));
  const head = h('div.sheet-head');
  const peek = h('div.sheet-peek');
  const tabs = h('div.sheet-tabs');
  const body = h('div.panel-body');
  head.append(grip, peek, tabs);
  el.append(head, body);
  const scrim = h('div.sheet-scrim');

  let index = 0, visible = 0, drag = null, suppressClick = 0;

  // env() cannot be read from a custom property; measure it on a probe.
  const probe = h('div', {'aria-hidden': 'true', style: 'position:fixed;bottom:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)'});
  el.append(probe);
  const safeBottom = () => parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  const vh = () => window.visualViewport?.height ?? innerHeight;
  const sheetHeight = () => el.getBoundingClientRect().height || vh() * 0.92;
  const snaps = () => [(head.offsetHeight || PEEK) + safeBottom(), Math.round(vh() * 0.55), Math.round(vh() * 0.92)];

  function apply(px, animated) {
    visible = px;
    const H = sheetHeight();
    el.style.transition = animated && !reduced() ? 'transform var(--t-slow) var(--ease-out)' : 'none';
    el.style.transform = `translateY(${Math.max(0, H - px)}px)`;
  }

  function snapTo(i, animated = true) {
    index = Math.max(0, Math.min(2, i));
    apply(snaps()[index], animated);
    const root = el.closest('.ui');
    if (root) root.dataset.sheet = String(index);
    onSnap?.(index, snaps()[0]);
  }

  head.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    drag = {y: e.clientY, start: visible, t: performance.now(), lastY: e.clientY, lastT: performance.now(), v: 0, moved: false, id: e.pointerId};
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      head.setPointerCapture?.(e.pointerId);
    }
    const now = performance.now();
    drag.v = (e.clientY - drag.lastY) / Math.max(1, now - drag.lastT);
    drag.lastY = e.clientY;
    drag.lastT = now;
    const [lo, , hi] = snaps();
    let px = drag.start - dy;
    if (px > hi) px = hi + (px - hi) * 0.25;
    if (px < lo) px = lo - (lo - px) * 0.25;
    apply(px, false);
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const {moved, v} = drag;
    drag = null;
    if (!moved) return;
    suppressClick = performance.now() + 300;
    const points = snaps();
    let target;
    if (Math.abs(v) > VELOCITY) {
      // Moving up (negative v) picks the next higher snap.
      target = v < 0 ? points.findIndex((p) => p > visible + 4) : findLastIndex(points, (p) => p < visible - 4);
      if (target < 0) target = v < 0 ? 2 : 0;
    } else {
      target = points.reduce((best, p, i) => (Math.abs(p - visible) < Math.abs(points[best] - visible) ? i : best), 0);
    }
    snapTo(target);
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  head.addEventListener('click', (e) => {
    if (performance.now() < suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  grip.addEventListener('click', () => snapTo(index === 0 ? 1 : index === 1 ? 2 : 0));
  scrim.addEventListener('click', () => snapTo(0));
  addEventListener('resize', () => { if (el.isConnected) snapTo(index, false); });

  return {
    el, scrim, peek, tabs, body,
    snapTo,
    get index() { return index; },
    get peekHeight() { return snaps()[0]; },
  };
}

function findLastIndex(list, fn) {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) return i;
  return -1;
}
