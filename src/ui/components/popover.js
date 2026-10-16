// Small anchored popovers: the map overlays menu and era progress.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';

let current = null;

export function closePopover() {
  if (!current) return;
  current.el.remove();
  current.anchor?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', current.outside, true);
  current = null;
}

export function openPopover(anchor, content, {label = 'Details', place = 'auto'} = {}) {
  const same = current?.anchor === anchor;
  closePopover();
  if (same) return null;
  const el = h('div.pop.paper', {role: 'dialog', 'aria-label': label});
  el.append(content);
  document.querySelector('.ui').append(el);
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, ht = el.offsetHeight;
  let x, y;
  if (place === 'right' || (place === 'auto' && r.right + w + 12 < innerWidth && r.width < 80)) {
    x = r.right + 10;
    y = Math.min(innerHeight - ht - 12, Math.max(12, r.top));
  } else if (place === 'below') {
    x = Math.min(innerWidth - w - 12, Math.max(12, r.left));
    y = Math.min(innerHeight - ht - 12, r.bottom + 10);
  } else {
    x = Math.min(innerWidth - w - 12, Math.max(12, r.left));
    y = r.top - ht - 10 > 12 ? r.top - ht - 10 : r.bottom + 10;
  }
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  document.addEventListener('pointerdown', outside, true);
  current = {el, anchor, outside};
  return el;
}

export function eraContent(era) {
  const wrap = h('div');
  if (!era || era.final) {
    wrap.innerHTML = '<h4>The last age</h4><p>Hearthvale has grown as far as it will. The chronicle keeps going.</p>';
    return wrap;
  }
  wrap.innerHTML = `<h4>Toward ${esc(era.nextName)}</h4>
    <p>A new age comes when the town is ready${Number.isFinite(era.floorYear) ? `, and not before year ${era.floorYear}` : ''}.${Number.isFinite(era.ceilingYear) ? ` It comes by year ${era.ceilingYear} at the latest.` : ''}</p>
    <ul class="conds">${(era.conditions ?? []).map((c) => `<li class="${c.met ? 'met' : ''}">${icon(c.met ? 'check' : 'clock')}<span>${esc(c.label)}</span><span class="bar"><i style="width:${Math.round(Math.min(1, c.progress ?? (c.met ? 1 : 0)) * 100)}%"></i></span></li>`).join('')}</ul>`;
  return wrap;
}

export const OVERLAYS = [
  ['none', 'The town', 'As it looks'],
  ['roads', 'Worn paths', 'Where people walk'],
  ['value', 'Land value', 'Where homes cost most'],
  ['health', 'Health', 'Where people fall sick'],
];

export function overlayContent(currentMode, onPick) {
  const wrap = h('div');
  wrap.innerHTML = `<h4>Map</h4><div class="pop-list" role="menu">${OVERLAYS.map(([id, label, hint]) => `<button class="pop-item" role="menuitemradio" aria-checked="${id === currentMode}" data-mode="${id}">${esc(label)}<small>${esc(hint)}</small></button>`).join('')}</div>`;
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) { onPick(b.dataset.mode); closePopover(); }
  });
  return wrap;
}
