// Motion tokens (design-visual §8.8) and Web Animations helpers that honour
// both the OS reduced-motion setting and the in-game Motion preference.

export const T = {fast: 120, base: 220, slow: 360, moment: 900};
export const EASE = {
  out: 'cubic-bezier(.2,.8,.2,1)',
  in: 'cubic-bezier(.4,0,.8,.4)',
  back: 'cubic-bezier(.34,1.3,.64,1)',
};

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let forced = false;

export function setReducedMotion(on) {
  forced = Boolean(on);
  document.documentElement.dataset.motion = reduced() ? 'reduced' : 'full';
}

export function reduced() {
  return forced || Boolean(media?.matches);
}

media?.addEventListener?.('change', () => setReducedMotion(forced));

// Resolves when the animation ends (or at once with reduced motion, where
// only opacity changes are kept and run instantly).
export function animate(el, keyframes, {duration = T.base, easing = EASE.out, delay = 0, fill = 'none'} = {}) {
  if (!el?.animate) return Promise.resolve();
  if (reduced()) {
    const last = keyframes[keyframes.length - 1] ?? {};
    if (fill !== 'none' && 'opacity' in last) el.style.opacity = last.opacity;
    return Promise.resolve();
  }
  const anim = el.animate(keyframes, {duration, easing, delay, fill});
  return anim.finished.catch(() => {});
}

// Card enter: rise and settle. Card exit: fold (scaleY .96) and fade.
export const enter = (el, delay = 0) =>
  animate(el, [{opacity: 0, transform: 'translateY(14px) scale(.985)'}, {opacity: 1, transform: 'none'}], {duration: T.base, delay});

export const fold = (el) =>
  animate(el, [{opacity: 1, transform: 'none'}, {opacity: 0, transform: 'scaleY(.96) translateY(-4px)'}], {duration: 180, easing: EASE.in, fill: 'forwards'});

export const reveal = (el, delay = 0) =>
  animate(el, [{opacity: 0, transform: 'translateX(18px)'}, {opacity: 1, transform: 'none'}], {duration: 280, easing: EASE.out, delay});

// Collapse height to zero after a fold so siblings slide up smoothly.
export async function collapse(el) {
  if (reduced() || !el.animate) return;
  const height = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  await animate(el, [{height: `${height}px`, marginBottom: getComputedStyle(el).marginBottom}, {height: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px'}], {duration: T.base, easing: EASE.out, fill: 'forwards'});
}
