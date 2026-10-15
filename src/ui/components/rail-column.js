// A slim paper column of icon tiles, used for both screen edges on desk and
// tablet: the left rail (views and tools) and the right dock (the docket and
// every body). Pressed tiles fill green; counts sit in badges; a gold dot
// marks something new until it is visited. Tiles keep their nodes between
// refreshes, so a reveal (slide in, gold sweep) plays once. Each group is a
// stack; a scrolling group gets edge fades.
import {h, setAttr, setText, toggleClass, watchFades} from '../dom.js';
import {icon} from '../icons.js';

export function createRailColumn({tag = 'nav', cls, label, key = 'view', tileClass, tipSide, tip, onPick}) {
  const el = h(`${tag}.crest-rail.${cls}.paper`, {'aria-label': label});
  const tiles = new Map();
  let groups = [], booted = false;

  function tile(item) {
    let b = tiles.get(item.id);
    if (b) return b;
    b = h(`button.crest-btn.${tileClass}`, {type: 'button', [`data-${key}`]: item.id});
    b.innerHTML = `<span class="crest-icon"></span><span class="badge"></span><span class="dot" hidden></span>`;
    b.addEventListener('click', () => onPick(item.id, b));
    tip.attach(b, tipSide);
    if (booted && item.fresh) {
      b.classList.add('is-new');
      requestAnimationFrame(() => b.scrollIntoView?.({block: 'nearest'}));
    }
    tiles.set(item.id, b);
    return b;
  }

  function group(i, scroll) {
    if (groups[i]) return groups[i];
    const g = {el: h('div.crest-group'), sep: i ? h('i.crest-sep', {'aria-hidden': 'true'}) : null};
    if (scroll) {
      g.el.classList.add('is-scroll', `${cls}-list`);
      g.fades = watchFades(g.el, 'y');
      g.el.addEventListener('scroll', () => tip.hide(), {passive: true});
    }
    groups[i] = g;
    el.append(...[g.sep, g.el].filter(Boolean));
    return g;
  }

  return {
    el,
    // sections: [{items: [{id, name, tip, icon, count, fresh, pressed, quiet, controls}], scroll}]
    update(sections) {
      const ids = new Set(sections.flatMap((s) => s.items.map((i) => i.id)));
      for (const [id, b] of tiles) if (!ids.has(id)) { b.remove(); tiles.delete(id); }
      let shown = 0;
      sections.forEach((s, i) => {
        const g = group(i, s.scroll);
        for (const item of s.items) {
          const b = tile(item);
          if (item.icon !== b.dataset.icon) {
            b.dataset.icon = item.icon;
            b.querySelector('.crest-icon').innerHTML = icon(item.icon);
          }
          setAttr(b, 'aria-pressed', item.pressed == null ? null : String(item.pressed));
          setAttr(b, 'aria-controls', item.controls ?? null);
          setAttr(b, 'aria-label', `${item.name}${item.count ? `, ${item.count} waiting` : ''}`);
          b.dataset.tip = item.tip ?? item.name;
          setText(b.querySelector('.badge'), item.count ? String(item.count) : '');
          b.querySelector('.dot').hidden = !item.fresh || Boolean(item.count);
          toggleClass(b, 'is-quiet', Boolean(item.quiet));
          if (!item.fresh) toggleClass(b, 'is-new', false);
        }
        const want = s.items.map((it) => tiles.get(it.id));
        if (want.length !== g.el.children.length || want.some((b, j) => g.el.children[j] !== b)) g.el.replaceChildren(...want);
        g.el.hidden = !want.length;
        if (g.sep) g.sep.hidden = !want.length || !shown;
        shown += want.length;
        g.fades?.();
      });
      el.hidden = !shown;
      booted = true;
    },
    tile: (id) => tiles.get(id) ?? null,
  };
}
