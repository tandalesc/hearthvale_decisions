// Notifications (design-visual §8.6). Never more than one toast visible.
// Nudges are queued and shown at most once per 20 s of real time; banners
// carry the non-blocking year-end and moment lines.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {animate, EASE} from '../motion.js';

const NUDGE_GAP_MS = 20000;
const NUDGE_SHOW_MS = 6000;
const BANNER_SHOW_MS = 6000;

export function createNotices() {
  const nudgeHost = h('div.nudge-host');
  const bannerHost = h('div.banner-host', {'aria-live': 'polite'});
  const toastHost = h('div.toasts', {'aria-live': 'polite'});
  const queue = [];
  let lastNudge = -Infinity, nudgeTimer = null, banners = [], bannerTimer = null, toastTimer = null;

  async function dismiss(el) {
    if (!el?.isConnected) return;
    el.classList.add('is-leaving');
    await animate(el, [{opacity: 1}, {opacity: 0}], {duration: 180, easing: EASE.in, fill: 'forwards'});
    el.remove();
  }

  function pumpNudges() {
    clearTimeout(nudgeTimer);
    if (!queue.length) return;
    const wait = lastNudge + NUDGE_GAP_MS - performance.now();
    if (wait > 0 || nudgeHost.firstChild || document.querySelector('.petition')) {
      nudgeTimer = setTimeout(pumpNudges, Math.max(500, wait));
      return;
    }
    const item = queue.shift();
    lastNudge = performance.now();
    // Items may bring their own element and host (the dock's petitioner chip).
    const el = item.render ? item.render() : h('button.nudge', {type: 'button'});
    if (!item.render) el.innerHTML = `${icon(item.iconName ?? 'bell')}<span>${esc(item.text)}</span>`;
    el.addEventListener('click', () => { item.onClick?.(); dismiss(el); });
    (item.host ?? nudgeHost).append(el);
    setTimeout(() => (item.onExpire ? item.onExpire(el) : dismiss(el)), item.ms ?? NUDGE_SHOW_MS);
    nudgeTimer = setTimeout(pumpNudges, NUDGE_GAP_MS);
  }

  function pumpBanners() {
    if (bannerHost.firstChild || !banners.length) return;
    const b = banners.shift();
    const el = h('div.banner.paper', {role: 'status'});
    el.innerHTML = `<span class="seal-icon">${icon(b.icon ?? 'scroll')}</span><div><b>${esc(b.title)}</b>${b.text ? `<span>${esc(b.text)}</span>` : ''}</div>`;
    bannerHost.append(el);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(async () => { await dismiss(el); pumpBanners(); }, b.ms ?? BANNER_SHOW_MS);
  }

  return {
    hosts: [nudgeHost, bannerHost, toastHost],
    // Replace a queued nudge with the same key (e.g. docket counts) rather than stacking.
    nudge(text, {onClick, key, icon: iconName, render, host, ms, onExpire} = {}) {
      const i = key ? queue.findIndex((q) => q.key === key) : -1;
      const item = {text, onClick, key, iconName, render, host, ms, onExpire};
      if (i >= 0) queue[i] = item; else queue.push(item);
      pumpNudges();
    },
    banner(title, text, opts = {}) {
      banners = banners.filter((b) => b.key == null || b.key !== opts.key);
      banners.push({title, text, ...opts});
      if (banners.length > 3) banners.shift();
      pumpBanners();
    },
    toast(text, ms = 3600) {
      clearTimeout(toastTimer);
      toastHost.replaceChildren(h('div.toast', text));
      toastTimer = setTimeout(() => dismiss(toastHost.firstChild), ms);
    },
    clear() { queue.length = 0; banners.length = 0; nudgeHost.replaceChildren(); bannerHost.replaceChildren(); },
  };
}
