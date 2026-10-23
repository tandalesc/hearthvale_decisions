// The docket: cards that need a ruling. Desktop shows a stack (one open
// card, the rest folded beneath). Phone shows one card at a time with a
// pager and swipe. Cards fold out when ruled and the next one slides up.
import {h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {collapse, enter, fold, animate, T, EASE} from '../motion.js';
import {createCard, createNextCard} from './card.js';

export function createDocket(ctx, {empty = ['Nothing waits for you.', 'The town gets on with its day.'], stuckAbove = () => 0} = {}) {
  const el = h('div.docket');
  const pager = h('div.pager', {hidden: true});
  pager.innerHTML = `<button class="icon-btn prev" aria-label="Previous card">${icon('chevron-left')}</button><span class="pager-count"></span><span class="dots"></span><button class="icon-btn next" aria-label="Next card">${icon('chevron-right')}</button>`;
  const stack = h('div.stack.swipe-track');
  const emptyEl = h('div.empty', h('b', empty[0]), empty[1]);
  el.append(pager, stack, emptyEl);

  const full = new Map();
  const next = new Map();
  let cards = [], active = null, phone = false, lastSig = '', visible = false, requested = null;

  pager.querySelector('.prev').addEventListener('click', () => step(-1));
  pager.querySelector('.next').addEventListener('click', () => step(1));
  bindSwipe(stack, (dir) => phone && step(dir));

  function step(dir) {
    const i = cards.findIndex((c) => c.id === active);
    const j = i + dir;
    if (j < 0 || j >= cards.length) {
      animate(stack, [{transform: 'translateX(0)'}, {transform: `translateX(${-dir * 10}px)`}, {transform: 'translateX(0)'}], {duration: T.base});
      return;
    }
    active = cards[j].id;
    render(dir);
    ctx.sound?.('tick');
  }

  function fullNode(card) {
    let node = full.get(card.id);
    // A node still folding away cannot come back; build it afresh.
    if (node?.dataset.leaving) node = null;
    if (!node) {
      node = createCard(card, ctx);
      node.dataset.id = card.id;
      full.set(card.id, node);
    }
    node.__update(card);
    return node;
  }

  function nextNode(card) {
    let node = next.get(card.id);
    if (node?.dataset.leaving) node = null;
    if (!node) {
      node = createNextCard(card, ctx, (id) => { active = id; render(0); ctx.sound?.('slide'); });
      node.dataset.id = card.id;
      next.set(card.id, node);
    }
    return node;
  }

  function render(dir = 0) {
    const ids = cards.map((c) => c.id);
    if (!ids.includes(active)) active = ids[0] ?? null;
    const current = cards.find((c) => c.id === active);
    if (visible && current && requested !== current.id) {
      requested = current.id;
      Promise.resolve(ctx.requestCardProse?.(current.id)).catch(() => {});
    }
    const others = phone ? [] : cards.filter((c) => c.id !== active);
    const desired = current ? [fullNode(current), ...others.map(nextNode)] : [];
    let leaving = false;
    for (const child of [...stack.children]) {
      if (desired.includes(child) || child.dataset.leaving) continue;
      // A card that still exists is only changing place (open ↔ folded).
      const moved = ids.includes(child.dataset.id);
      if (moved) {
        child.remove();
        continue;
      }
      leaving = true;
      exit(child, dir);
    }
    const anchor = [...stack.children].find((c) => c.dataset.leaving)?.nextSibling ?? null;
    desired.forEach((node, i) => {
      const fresh = !node.isConnected;
      if (fresh) node.__reopen?.();
      if (stack.children[i] !== node) stack.insertBefore(node, i === 0 ? stack.firstChild : desired[i - 1].nextSibling ?? anchor);
      if (fresh && node.classList.contains('is-next') === false) {
        if (dir) animate(node, [{opacity: 0, transform: `translateX(${dir * 28}px)`}, {opacity: 1, transform: 'none'}], {duration: T.base});
        else enter(node, leaving ? 140 : 0);
      } else if (fresh) enter(node, 60 + i * 30);
    });
    // Phones: a ruled card gives way to the next, so bring that card's top
    // into view if the reader had scrolled down to the options.
    if (phone && leaving && current) toTop();
    // Forget nodes for cards that no longer exist.
    for (const map of [full, next]) for (const [id, node] of map) if (!ids.includes(id) && !node.isConnected) map.delete(id);
    emptyEl.hidden = cards.length > 0;
    pager.hidden = !phone || cards.length < 2;
    if (phone) {
      const i = cards.findIndex((c) => c.id === active);
      setText(pager.querySelector('.pager-count'), `${i + 1} of ${cards.length}`);
      pager.querySelector('.dots').innerHTML = cards.map((c) => `<i class="${c.id === active ? 'on' : ''}"></i>`).join('');
      pager.querySelector('.prev').disabled = i <= 0;
      pager.querySelector('.next').disabled = i >= cards.length - 1;
    }
  }

  function toTop() {
    const scroller = el.closest('.panel-body');
    if (!scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - stuckAbove() - 8;
    if (top < scroller.scrollTop) scroller.scrollTo({top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }

  async function exit(node, dir) {
    node.dataset.leaving = '1';
    if (node.classList.contains('is-next') || dir) {
      await animate(node, [{opacity: 1}, {opacity: 0, transform: dir ? `translateX(${-dir * 28}px)` : 'none'}], {duration: 140, easing: EASE.in, fill: 'forwards'});
      if (!dir) await collapse(node);
    } else {
      await fold(node);
      await collapse(node);
    }
    node.remove();
    delete node.dataset.leaving;
    node.style.cssText = '';
    node.getAnimations?.().forEach((a) => a.cancel());
  }

  return {
    el,
    update(nextCards, {phone: isPhone = false} = {}) {
      phone = isPhone;
      cards = nextCards;
      const sig = `${phone}|${active}|${cards.map((c) => c.id).join(',')}|${ctx.unlocks().debates}`;
      if (sig !== lastSig) {
        lastSig = sig;
        render(0);
      } else {
        for (const card of cards) full.get(card.id)?.__update(card);
      }
    },
    focus(id) {
      if (id) active = id;
      lastSig = '';
      render(0);
      stack.querySelector('.card:not(.is-next) .option')?.focus({preventScroll: false});
    },
    setVisible(value) { visible = value; if (!value) { requested = null; ctx.cancelCardProse?.(); } else render(); },
    get count() { return cards.length; },
    get active() { return active; },
    // Show a different set of cards at once (a filter changed): no fold-away
    // for cards that were only filtered out.
    reset() {
      for (const node of stack.children) node.getAnimations?.().forEach((a) => a.cancel());
      stack.replaceChildren();
      full.clear();
      next.clear();
      active = null;
      lastSig = '';
    },
  };
}

// Horizontal swipe with a little resistance; ignores vertical scrolls and
// suppresses the click that would follow a swipe.
function bindSwipe(el, onSwipe) {
  let start = null, suppressUntil = 0;
  el.addEventListener('click', (ev) => {
    if (performance.now() < suppressUntil) { ev.stopPropagation(); ev.preventDefault(); }
  }, {capture: true});
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    start = {x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, lock: null};
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (start.lock == null && Math.hypot(dx, dy) > 8) start.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (start.lock !== 'x') return;
    start.dx = dx;
    const card = el.firstElementChild;
    if (card) card.style.transform = `translateX(${dx * 0.6}px) rotate(${dx * 0.01}deg)`;
  });
  const end = () => {
    if (!start) return;
    const {dx, t, lock} = start;
    start = null;
    const card = el.firstElementChild;
    if (card) card.style.transform = '';
    if (lock !== 'x') return;
    const v = Math.abs(dx) / Math.max(1, performance.now() - t);
    if (Math.abs(dx) > 70 || v > 0.4) {
      suppressUntil = performance.now() + 350;
      onSwipe(dx < 0 ? 1 : -1);
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
