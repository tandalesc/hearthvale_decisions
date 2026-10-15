// Hover and focus labels for icon-only buttons. One floating label lives on
// the .ui root, so scrolling rails do not clip it. The text comes from the
// button's data-tip; side says where the label sits.
import {h} from '../dom.js';

export function createTip(root) {
  const el = h('div.tip', {'aria-hidden': 'true', hidden: true});
  root.append(el);
  let owner = null;

  function show(target, side) {
    const text = target.dataset.tip;
    if (!text || !target.isConnected) return hide();
    owner = target;
    el.textContent = text;
    el.hidden = false;
    el.dataset.side = side;
    const r = target.getBoundingClientRect();
    el.style.top = `${Math.round(r.top + r.height / 2)}px`;
    if (side === 'left') {
      el.style.left = '';
      el.style.right = `${Math.round(innerWidth - r.left + 10)}px`;
    } else {
      el.style.right = '';
      el.style.left = `${Math.round(r.right + 10)}px`;
    }
  }

  function hide(target) {
    if (target && target !== owner) return;
    owner = null;
    el.hidden = true;
  }

  return {
    attach(target, side = 'right') {
      target.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(target, side); });
      target.addEventListener('pointerleave', () => hide(target));
      target.addEventListener('focus', () => { if (target.matches(':focus-visible')) show(target, side); });
      target.addEventListener('blur', () => hide(target));
      target.addEventListener('click', () => hide(target));
    },
    hide: () => hide(),
  };
}
