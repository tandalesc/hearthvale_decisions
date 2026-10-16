// Moment title cards: era changes, a body founded, a major disaster.
// Blocking only when the caller says so (at 3× and 5×, or when the player
// asked for them); the caller pauses the sim while one is open.
//
// A moment only tells; it never asks. So it can be put away freely: the
// Continue button, the close button, Esc (or Enter), or a click on the
// tinted backdrop. Its words are already in the chronicle, and any request
// that came with it waits on the docket. A click on the backdrop in the
// first moments after a card appears is ignored, so a click meant for the
// town cannot wave away a card the player has not seen.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {animate, EASE} from '../motion.js';

const BACKDROP_GRACE_MS = 700;

export function createMoments(ctx) {
  const queue = [];
  let open = null, running = false;

  function show(m) {
    const el = h('div.moment-layer', {role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'moment-title', 'aria-describedby': 'moment-text'});
    // The close button sits outside the card: in the screen's corner on desk,
    // just above the sheet on phones.
    el.innerHTML = `<button class="icon-btn moment-close" type="button" aria-label="Close" title="Close (Esc)">${icon('close')}</button>
    <div class="moment-card">
      <div class="eyebrow">${esc(m.eyebrow ?? 'A moment')}</div>
      <h2 id="moment-title">${esc(m.title)}</h2>
      <div class="rule-line"></div>
      ${m.text ? `<p id="moment-text">${esc(m.text)}</p>` : ''}
      ${m.items?.length ? `<ul>${m.items.slice(0, 3).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      <div class="moment-actions">
        <button class="btn btn-primary moment-go" type="button">Continue</button>
        <button class="btn btn-ghost moment-skip" type="button" hidden></button>
      </div>
      <p class="moment-hint">It stays in the Chronicle.</p>
    </div>`;
    const btn = el.querySelector('.moment-go');
    const opened = performance.now();
    const close = async () => {
      if (open !== el || el.dataset.leaving) return;
      el.dataset.leaving = '1';
      el.classList.add('is-leaving');
      await animate(el, [{opacity: 1}, {opacity: 0}], {duration: 200, easing: EASE.in, fill: 'forwards'});
      el.remove();
      open = null;
      if (queue.length) return show(queue.shift());
      running = false;
      ctx.onMomentClosed?.();
    };
    btn.addEventListener('click', close);
    el.querySelector('.moment-close').addEventListener('click', close);
    el.querySelector('.moment-skip').addEventListener('click', () => {
      queue.length = 0;
      close();
    });
    el.addEventListener('click', (e) => {
      if (e.target === el && performance.now() - opened > BACKDROP_GRACE_MS) close();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.target.closest('.moment-skip, .moment-close'))) {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        trap(el, e);
      }
    });
    open = el;
    open.__close = close;
    ctx.root.append(el);
    syncSkip();
    // One pause for a run of queued cards; one resume after the last.
    if (!running) {
      running = true;
      ctx.onMomentOpened?.(m);
    }
    requestAnimationFrame(() => btn.focus({preventScroll: true}));
  }

  // With more title cards waiting, offer to put them all away at once.
  function syncSkip() {
    const skip = open?.querySelector('.moment-skip');
    if (!skip) return;
    skip.hidden = !queue.length;
    skip.textContent = `Skip the other ${queue.length === 1 ? 'card' : `${queue.length}`}`;
  }

  return {
    push(m) {
      if (open) {
        queue.push(m);
        syncSkip();
      } else show(m);
    },
    get isOpen() { return Boolean(open); },
    close() { open?.__close(); },
    closeAll() {
      queue.length = 0;
      open?.__close();
    },
  };
}

function trap(el, e) {
  const items = [...el.querySelectorAll('button')].filter((b) => !b.hidden && b.offsetParent);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
