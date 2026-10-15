// Phone navigation: a strip of icons with labels in the sheet's peek, so
// every view is one thumb tap away. It scrolls sideways with edge fades
// when the town has more views than fit. Items keep their nodes, so a view
// unlocked while playing slides in with the gold sweep once.
import {h, setAttr, setText, toggleClass, watchFades} from '../dom.js';
import {icon} from '../icons.js';

export function createPhoneNav({onPick}) {
  const el = h('nav.sheet-nav', {'aria-label': 'Views'});
  const fades = watchFades(el, 'x');
  const items = new Map();
  let booted = false;

  function item(it) {
    let b = items.get(it.id);
    if (b) return b;
    b = h('button.nav-item', {type: 'button', 'data-view': it.id});
    b.innerHTML = `<span class="nav-icon">${icon(it.icon)}<span class="badge"></span><span class="dot" hidden></span></span><span class="nav-label"></span>`;
    b.addEventListener('click', () => onPick(it.id, b));
    if (booted && it.fresh) {
      b.classList.add('is-new');
      const done = () => b.classList.remove('is-new');
      b.addEventListener('animationend', (e) => { if (e.animationName === 'sweep') done(); });
      setTimeout(done, 2000);
      requestAnimationFrame(() => b.scrollIntoView?.({inline: 'nearest', block: 'nearest', behavior: 'smooth'}));
    }
    items.set(it.id, b);
    return b;
  }

  return {
    el,
    // list: [{id, label, icon, count, fresh, pressed}]
    update(list, selected) {
      const ids = new Set(list.map((i) => i.id));
      for (const [id, b] of items) if (!ids.has(id)) { b.remove(); items.delete(id); }
      for (const it of list) {
        const b = item(it);
        setText(b.querySelector('.nav-label'), it.label);
        setText(b.querySelector('.badge'), it.count ? String(it.count) : '');
        b.querySelector('.dot').hidden = !it.fresh || Boolean(it.count);
        setAttr(b, 'aria-label', `${it.label}${it.count ? `, ${it.count} waiting` : ''}`);
        setAttr(b, 'aria-current', it.id === selected ? 'true' : null);
        setAttr(b, 'aria-pressed', it.pressed == null ? null : String(it.pressed));
        toggleClass(b, 'is-selected', it.id === selected);
      }
      const want = list.map((i) => items.get(i.id));
      if (want.length !== el.children.length || want.some((b, i) => el.children[i] !== b)) el.replaceChildren(...want);
      fades();
      booted = true;
    },
    // Keep the selected item in view.
    reveal() {
      const b = el.querySelector('.is-selected');
      if (!b) return;
      const pad = 24;
      if (b.offsetLeft - pad < el.scrollLeft) el.scrollLeft = Math.max(0, b.offsetLeft - pad);
      else if (b.offsetLeft + b.offsetWidth + pad > el.scrollLeft + el.clientWidth) el.scrollLeft = b.offsetLeft + b.offsetWidth + pad - el.clientWidth;
    },
  };
}
