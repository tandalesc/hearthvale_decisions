// Drag handle on a panel's inner edge, desk and tablet: the binder's left
// edge and the drawer's right edge. Pointer or touch drag, double-click to
// reset, arrow keys ±16 px (Home and End jump to the limits). The width
// lives in a custom property on the .ui root (--binder-user, --drawer-user)
// and CSS clamps it to the layout's limits; the clamped width persists.
import {h, setAttr, toggleClass} from '../dom.js';

const STEP = 16;

export function createResize({root, panel, prefs, onChange, prefKey = 'binderWidth', varName = '--binder-user', edge = 'left', controls = 'binder', label = 'Panel width'}) {
  const el = h('div.panel-resize', {
    role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-controls': controls, 'data-edge': edge,
    'aria-label': label, title: 'Drag to resize. Double-click to reset.',
  });
  // Moving toward the scene widens the panel.
  const grow = edge === 'left' ? -1 : 1;
  el.innerHTML = '<i aria-hidden="true"></i>';
  let drag = null, raf = 0, pending = null;

  const width = () => Math.round(panel.getBoundingClientRect().width);

  function set(px) {
    if (px == null) root.style.removeProperty(varName);
    else root.style.setProperty(varName, `${Math.round(px)}px`);
  }

  // The limits come from the CSS clamp: measure the panel at both extremes.
  function limits() {
    const saved = root.style.getPropertyValue(varName);
    set(0);
    const min = width();
    set(100000);
    const max = width();
    if (saved) root.style.setProperty(varName, saved); else set(null);
    return {min, max};
  }

  function describe(lim = limits()) {
    setAttr(el, 'aria-valuemin', lim.min);
    setAttr(el, 'aria-valuemax', lim.max);
    setAttr(el, 'aria-valuenow', width());
  }

  function commit() {
    prefs.set(prefKey, width());
    describe();
  }

  function apply(px, lim) {
    set(Math.max(lim.min, Math.min(lim.max, px)));
    onChange?.();
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    el.setPointerCapture?.(e.pointerId);
    drag = {id: e.pointerId, x: e.clientX, w: width(), lim: limits()};
    toggleClass(root, 'is-resizing', true);
    toggleClass(el, 'is-dragging', true);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    pending = drag.w + (e.clientX - drag.x) * grow;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      if (drag && pending != null) apply(pending, drag.lim);
    });
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    cancelAnimationFrame(raf);
    raf = 0;
    if (pending != null) apply(pending, drag.lim);
    const moved = pending != null;
    drag = null;
    pending = null;
    toggleClass(root, 'is-resizing', false);
    toggleClass(el, 'is-dragging', false);
    if (moved) commit();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('dblclick', () => reset());
  el.addEventListener('focus', () => describe());
  el.addEventListener('keydown', (e) => {
    const lim = limits();
    const w = width();
    const next = {ArrowLeft: w - STEP * grow, ArrowRight: w + STEP * grow, Home: lim.min, End: lim.max}[e.key];
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    apply(next, lim);
    commit();
  });

  function reset() {
    set(null);
    prefs.set(prefKey, null);
    onChange?.();
    describe();
  }

  const saved = Number(prefs.get(prefKey));
  if (saved > 0) set(saved);

  return {el, reset, get width() { return width(); }};
}
