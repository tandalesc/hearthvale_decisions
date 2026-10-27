// The end page (E9): the town's story at year 150, full screen. It opens
// once, when the chronicle closes, and again from the Chronicle's "Read the
// town's story". Its content is the sim's selectEndPage (src/sim/view.js),
// asked for only while it is open (the snapshot's panels.endPage).
//
// It only tells. Continue, the close button and Esc put it away, and play
// goes on past 150. The caller pauses the town while it is open, as for a
// title card. "Share this town" posts the summary to the Worker, which keeps
// a read-only page at /t/<id>.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {num} from '../format.js';
import {animate, EASE} from '../motion.js';

if (typeof document !== 'undefined') import('./endpage.css');

// The share request carries a picture of the town only when it is small.
const MAX_IMAGE_CHARS = 180_000;

export function createEndPage(ctx) {
  let layer = null, page = null, sig = '', sharing = false, shared = null, lastFocus = null;

  function open() {
    if (layer) return;
    lastFocus = document.activeElement;
    layer = h('div.endpage-layer', {role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'endpage-title'});
    layer.innerHTML = `<button class="icon-btn endpage-x" type="button" aria-label="Close" title="Close (Esc)">${icon('close')}</button>
      <article class="endpage"><div class="endpage-body"></div>
        <div class="endpage-actions">
          <button class="btn btn-primary endpage-go" type="button">Continue</button>
          <button class="btn btn-ghost endpage-share" type="button" hidden>Share this town</button>
        </div>
        <p class="endpage-status" role="status" aria-live="polite"></p>
        <p class="endpage-hint">Play goes on. The story stays in the Chronicle.</p>
      </article>`;
    layer.querySelector('.endpage-go').addEventListener('click', close);
    layer.querySelector('.endpage-x').addEventListener('click', close);
    layer.querySelector('.endpage-share').addEventListener('click', share);
    layer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') trap(layer, e);
    });
    sig = '';
    ctx.root.append(layer);
    render();
    ctx.onOpened?.();
    requestAnimationFrame(() => layer?.querySelector('.endpage-go')?.focus({preventScroll: true}));
  }

  async function close() {
    const el = layer;
    if (!el || el.dataset.leaving) return;
    el.dataset.leaving = '1';
    await animate(el, [{opacity: 1}, {opacity: 0}], {duration: 200, easing: EASE.in, fill: 'forwards'});
    el.remove();
    if (layer === el) layer = null;
    ctx.onClosed?.();
    if (lastFocus?.isConnected) lastFocus.focus?.({preventScroll: true});
    lastFocus = null;
  }

  function render() {
    if (!layer) return;
    const body = layer.querySelector('.endpage-body');
    const next = page ? JSON.stringify(page) : '';
    if (next === sig && body.childElementCount) return;
    sig = next;
    layer.querySelector('.endpage-share').hidden = !page;
    body.innerHTML = page ? pageHtml(page) : `<header class="endpage-head"><h2 id="endpage-title">The town's story</h2><p class="endpage-lead">Reading the chronicle.</p></header>`;
    syncShare();
  }

  function syncShare() {
    if (!layer) return;
    const btn = layer.querySelector('.endpage-share');
    const status = layer.querySelector('.endpage-status');
    btn.disabled = sharing;
    if (shared?.url) {
      btn.textContent = 'Copy the link';
      status.innerHTML = `Your town's page: <a href="${esc(shared.url)}" target="_blank" rel="noopener">${esc(shared.url)}</a>${shared.copied ? ' (copied)' : ''}`;
    } else {
      btn.textContent = sharing ? 'Making a link' : 'Share this town';
      status.textContent = shared?.error ?? '';
    }
  }

  async function share() {
    if (!page || sharing) return;
    if (shared?.url) return copy(shared.url);
    sharing = true;
    syncShare();
    try {
      const image = await thumbnail(ctx);
      const res = await fetch('/api/towns', {
        method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({page, ...(image ? {image} : {})}),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && typeof body?.url === 'string') {
        shared = {url: new URL(body.url, location.href).href};
        await copy(shared.url);
      } else {
        shared = {error: res.status === 429 ? 'That is enough links for today. Try again tomorrow.'
          : res.status === 404 || res.status === 405 ? 'Sharing works in the hosted game.' : 'The link could not be made. Try again later.'};
      }
    } catch {
      shared = {error: 'The link could not be made. Check your connection.'};
    } finally {
      sharing = false;
      syncShare();
    }
  }

  async function copy(url) {
    try {
      await navigator.clipboard?.writeText(url);
      if (shared) shared.copied = true;
    } catch {
      // The link is on the page to copy by hand.
    }
    syncShare();
  }

  return {
    open,
    close,
    get isOpen() { return Boolean(layer); },
    // The selector's summary, or null while it is on its way.
    update(next) {
      if (next && JSON.stringify(next) !== JSON.stringify(page)) {
        page = next;
        shared = null;
      }
      render();
    },
  };
}

function pageHtml(p) {
  const tally = p.rulings ?? {};
  const n = (x) => (x ? num(x) : 'none');
  const roll = (title, items) => (items?.length ? `<div class="endpage-roll"><h4>${esc(title)}</h4><ul>${items.map((b) => `<li><span class="nm">${esc(b.name)}</span>${Number.isFinite(b.year) ? `<span class="yr">Yr ${esc(b.year)}</span>` : ''}</li>`).join('')}</ul></div>` : '');
  const bodies = [roll('Founded', p.bodies?.founded), roll('Dissolved', p.bodies?.dissolved), roll('Refused', p.bodies?.refused)].join('');
  return `<header class="endpage-head">
      <p class="endpage-kicker">Year ${esc(p.year)}${p.eraName ? ` · ${esc(p.eraName)}` : ''}</p>
      <h2 id="endpage-title">${esc(p.townName)}</h2>
      ${p.lead ? `<p class="endpage-lead">${esc(p.lead)}</p>` : ''}
      ${(p.arc ?? []).length > 1 ? `<ol class="endpage-arc" aria-label="What the town was, year by year">${p.arc.map((a) => `<li><span class="yr">Yr ${esc(a.year)}</span> ${esc(a.name)}</li>`).join('')}</ol>` : ''}
      <div class="rule-line" aria-hidden="true"></div>
    </header>
    ${(p.sentences ?? []).length ? `<section class="endpage-closing">${p.sentences.map((s) => `<p>${esc(s)}</p>`).join('')}</section>` : ''}
    <p class="endpage-meta">${num(p.people)} people · ${num(p.rules)} rules · ${num(p.bodies?.founded?.length ?? 0)} bodies founded</p>
    ${compassHtml(p.compass)}
    ${(p.highlights ?? []).length ? `<section class="endpage-section endpage-highlights"><h3>Moments to remember</h3>
      <ol>${p.highlights.map((x) => `<li><span class="yr">Yr ${esc(x.year)}</span><span class="txt">${esc(x.text)}</span></li>`).join('')}</ol></section>` : ''}
    ${bodies ? `<section class="endpage-section endpage-bodies"><h3>The bodies</h3><div class="endpage-rolls">${bodies}</div></section>` : ''}
    <section class="endpage-section endpage-rulings"><h3>Your rulings</h3>
      <p>${tally.total ? `You ruled on ${num(tally.total)} ${tally.total === 1 ? 'request' : 'requests'}.` : 'No ruling came to you.'}</p>
      ${tally.total ? `<p class="endpage-tally"><b>${n(tally.approved)}</b> approved · <b>${n(tally.refused)}</b> refused · <b>${n(tally.lapsed)}</b> lapsed</p>` : ''}
    </section>
    ${(p.centres ?? []).length ? `<section class="endpage-section endpage-centres"><h3>The valley</h3>${p.centres.map((c) => `<p>${esc(c.line)}</p>`).join('')}</section>` : ''}`;
}

// The compass path: one small line per trait, up for the high word.
function compassHtml(c) {
  const axes = (c?.axes ?? []).filter((a) => a.points?.length >= 2);
  if (!axes.length) return '';
  const span = Math.max(1, (c.to ?? 0) - (c.from ?? 0));
  const W = 300, H = 44, mid = H / 2;
  const row = (a) => {
    const d = a.points.map(([year, v], i) => `${i ? 'L' : 'M'}${(((year - c.from) / span) * W).toFixed(1)} ${(mid - v * (mid - 4)).toFixed(1)}`).join(' ');
    const end = a.points.at(-1)[1];
    const lean = Math.abs(end) < 0.1 ? 'balanced at the end' : `leaned to ${(end > 0 ? a.high : a.low).toLowerCase()} at the end`;
    return `<div class="endpage-axis" role="img" aria-label="${esc(`${a.low} or ${a.high}: ${lean}`)}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${mid}" x2="${W}" y2="${mid}" class="mid"/><path d="${d}"/></svg>
      <span class="ends"><span class="${end > 0.1 ? 'on' : ''}">${esc(a.high)}</span><span class="${end < -0.1 ? 'on' : ''}">${esc(a.low)}</span></span>
    </div>`;
  };
  return `<section class="endpage-section endpage-compass"><h3>Which way it leaned</h3>
    <p class="endpage-years" aria-hidden="true"><span>Yr ${esc(c.from)}</span><span>Yr ${esc(c.to)}</span></p>
    ${axes.map(row).join('')}</section>`;
}

// The save's picture of the town, as a data URL, when the host has one.
async function thumbnail(ctx) {
  try {
    const t = await ctx.thumbnail?.();
    if (!t) return null;
    const url = typeof t === 'string' ? t : await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => resolve(null);
      r.readAsDataURL(t);
    });
    return /^data:image\/(jpeg|png|webp);base64,/.test(url ?? '') && url.length <= MAX_IMAGE_CHARS ? url : null;
  } catch {
    return null;
  }
}

function trap(el, e) {
  const items = [...el.querySelectorAll('button, a[href]')].filter((b) => !b.hidden && !b.disabled && b.offsetParent);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}
