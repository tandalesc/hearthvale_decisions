// Moment title cards: era changes, a body founded, a major disaster.
// Blocking only when the caller says so (at 3× and 8×, or when the player
// asked for them); the caller pauses the sim while one is open.
import {esc, h} from '../dom.js';
import {animate, EASE} from '../motion.js';

export function createMoments(ctx) {
  const queue = [];
  let open = null;

  function show(m) {
    const el = h('div.moment-layer', {role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'moment-title'});
    el.innerHTML = `<div class="moment-card">
      <div class="eyebrow">${esc(m.eyebrow ?? 'A moment')}</div>
      <h2 id="moment-title">${esc(m.title)}</h2>
      <div class="rule-line"></div>
      ${m.text ? `<p>${esc(m.text)}</p>` : ''}
      ${m.items?.length ? `<ul>${m.items.slice(0, 3).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      <button class="btn btn-primary" type="button">Continue</button>
    </div>`;
    const btn = el.querySelector('button');
    const close = async () => {
      if (open !== el) return;
      el.classList.add('is-leaving');
      await animate(el, [{opacity: 1}, {opacity: 0}], {duration: 200, easing: EASE.in, fill: 'forwards'});
      el.remove();
      open = null;
      ctx.onMomentClosed?.();
      if (queue.length) show(queue.shift());
    };
    btn.addEventListener('click', close);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } });
    open = el;
    open.__close = close;
    ctx.root.append(el);
    ctx.onMomentOpened?.(m);
    requestAnimationFrame(() => btn.focus({preventScroll: true}));
  }

  return {
    push(m) {
      if (open) queue.push(m); else show(m);
    },
    get isOpen() { return Boolean(open); },
    close() { open?.__close(); },
  };
}
