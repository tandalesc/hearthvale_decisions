// Shared town pages (E9): a finished town's end-page summary, kept in R2 and
// shown read-only at /t/<id>.
//
//   POST /api/towns   {page, image?} -> {id, url}   (same origin; 20 a day per IP)
//   GET  /t/<id>      a small HTML page drawn here from the stored JSON
//
// Everything stored is cleaned to a fixed shape first, and everything shown
// is escaped. The page runs no scripts.
import {reserve} from './account.js';
import {digest} from './auth.js';

export const TOWN_PAGE_PREFIX = 'town-pages/v1/';
export const TOWN_ID = /^[a-z2-9]{10}$/;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 letters: an unbiased byte & 31
const MAX_BODY = 256 * 1024;
const MAX_IMAGE = 180_000;
const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

const json = (status, body) => Response.json(body, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const cap = (env, name, fallback) => { const n = Number(env[name] ?? fallback); return Number.isSafeInteger(n) && n >= 0 ? n : 0; };

export function townId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

// ---------------------------------------------------------------------------
// Cleaning: only these fields, these lengths, these counts.

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max) : '');
const int = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
const unit = (v) => (Number.isFinite(v) ? Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100 : 0);
const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter(Boolean) : []);
const named = (b) => (str(b?.name, 80) ? {name: str(b.name, 80), year: int(b.year, 0, 100000)} : null);

export function cleanTownPage(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw Object.assign(new Error('Invalid town page'), {status: 400});
  const c = p.compass ?? {};
  const page = {
    townName: str(p.townName, 60) || 'Hearthvale',
    year: int(p.year, 0, 100000) ?? 0,
    eraName: str(p.eraName, 40),
    archetypeName: str(p.archetypeName, 60),
    lead: str(p.lead, 300),
    arc: list(p.arc, 12, named),
    sentences: list(p.sentences, 6, (s) => str(s, 400) || null),
    highlights: list(p.highlights, 12, (h) => (str(h?.text, 300) ? {year: int(h.year, 0, 100000), text: str(h.text, 300)} : null)),
    compass: {
      from: int(c.from, 0, 100000), to: int(c.to, 0, 100000),
      axes: list(c.axes, 4, (a) => ({
        id: str(a?.id, 20), low: str(a?.low, 20), high: str(a?.high, 20),
        points: list(a?.points, 60, (pt) => (Array.isArray(pt) && Number.isFinite(pt[0]) ? [int(pt[0], 0, 100000), unit(pt[1])] : null)),
      })),
    },
    bodies: {
      founded: list(p.bodies?.founded, 40, named),
      dissolved: list(p.bodies?.dissolved, 40, named),
      refused: list(p.bodies?.refused, 20, named),
    },
    rulings: Object.fromEntries(['approved', 'refused', 'lapsed', 'total'].map((k) => [k, int(p.rulings?.[k], 0, 1e7) ?? 0])),
    people: int(p.people, 0, 1e8) ?? 0,
    rules: int(p.rules, 0, 10000) ?? 0,
    centres: list(p.centres, 12, (x) => (str(x?.line, 300) ? {name: str(x.name, 60), line: str(x.line, 300)} : null)),
  };
  if (!page.highlights.length && !page.sentences.length) throw Object.assign(new Error('Invalid town page'), {status: 400});
  return page;
}

// ---------------------------------------------------------------------------
// POST /api/towns (the caller has already checked the origin).

export async function createTownPage(request, env, readText) {
  if (request.method !== 'POST') return json(405, {error: 'Method not allowed'});
  if (!env.STUDENT_ARTIFACTS) return json(503, {error: 'Sharing unavailable'});
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json(415, {error: 'JSON required'});
  const ip = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
  if (!await reserve(env, 'town-pages:' + ip, 'town-page', 1, cap(env, 'TOWN_PAGES_PER_IP_DAILY', 20))) return json(429, {error: 'Too many town pages today. Please try again tomorrow.'});
  if (!await reserve(env, 'global', 'town-page', 1, cap(env, 'TOWN_PAGES_DAILY_CAP', 5000))) return json(429, {error: 'Too many town pages today. Please try again tomorrow.'});
  let body;
  try { body = JSON.parse(await readText(request, MAX_BODY)); } catch (error) {
    if (error.status === 413) return json(413, {error: 'Request too large'});
    return json(400, {error: 'Invalid town page'});
  }
  let page;
  try { page = cleanTownPage(body?.page); } catch { return json(400, {error: 'Invalid town page'}); }
  const image = typeof body?.image === 'string' && body.image.length <= MAX_IMAGE && IMAGE.test(body.image) ? body.image : null;
  const record = {v: 1, created: new Date().toISOString(), page, ...(image ? {image} : {})};
  for (let tries = 0; tries < 4; tries++) {
    const id = townId(), key = `${TOWN_PAGE_PREFIX}${id}.json`;
    if (await env.STUDENT_ARTIFACTS.head(key)) continue;
    await env.STUDENT_ARTIFACTS.put(key, JSON.stringify(record), {httpMetadata: {contentType: 'application/json'}});
    return json(201, {id, url: `/t/${id}`});
  }
  return json(503, {error: 'Sharing unavailable'});
}

// ---------------------------------------------------------------------------
// GET /t/<id>

const ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);
const e = escapeHtml;
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-GB') : '0');

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export async function townPage(request, env, id) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status: 405, headers: {...PAGE_HEADERS, 'Cache-Control': 'no-store'}});
  let record = null;
  if (TOWN_ID.test(id) && env.STUDENT_ARTIFACTS) {
    const blob = await env.STUDENT_ARTIFACTS.get(`${TOWN_PAGE_PREFIX}${id}.json`);
    try { record = blob ? JSON.parse(await blob.text()) : null; } catch { record = null; }
  }
  if (!record?.page) return new Response(shell('Town not found', '<h1>Town not found</h1><p>No town is kept at this link.</p>'), {status: 404, headers: {...PAGE_HEADERS, 'Cache-Control': 'no-store'}});
  // Stored pages were cleaned on the way in; clean again so an old or odd record still draws safely.
  let page;
  try { page = cleanTownPage(record.page); } catch { page = null; }
  if (!page) return new Response(shell('Town not found', '<h1>Town not found</h1><p>No town is kept at this link.</p>'), {status: 404, headers: {...PAGE_HEADERS, 'Cache-Control': 'no-store'}});
  const image = typeof record.image === 'string' && IMAGE.test(record.image) ? record.image : null;
  return new Response(request.method === 'HEAD' ? null : shell(`${page.townName}, a Hearthvale town`, renderPage(page, image)),
    {status: 200, headers: {...PAGE_HEADERS, 'Cache-Control': 'public, max-age=300'}});
}

export function renderPage(p, image = null) {
  const roll = (title, items) => (items.length ? `<div><h3>${e(title)}</h3><ul>${items.map((b) => `<li>${e(b.name)}${b.year != null ? ` <span class="yr">Yr ${e(b.year)}</span>` : ''}</li>`).join('')}</ul></div>` : '');
  const t = p.rulings;
  return `<p class="kicker">Year ${e(p.year)}${p.eraName ? ` · ${e(p.eraName)}` : ''}</p>
<h1>${e(p.townName)}</h1>
${p.lead ? `<p class="lead">${e(p.lead)}</p>` : ''}
${p.arc.length > 1 ? `<p class="meta">${p.arc.map((a) => `Yr ${e(a.year)} ${e(a.name)}`).join(' → ')}</p>` : ''}
${image ? `<img class="town" src="${e(image)}" alt="A view of ${e(p.townName)}">` : ''}
${p.sentences.map((s) => `<p>${e(s)}</p>`).join('\n')}
<p class="meta">${fmt(p.people)} people · ${fmt(p.rules)} rules · ${fmt(p.bodies.founded.length)} bodies founded</p>
${compass(p.compass)}
${p.highlights.length ? `<h2>Moments to remember</h2><ol>${p.highlights.map((h) => `<li><span class="yr">Yr ${e(h.year)}</span> ${e(h.text)}</li>`).join('')}</ol>` : ''}
${roll('Founded', p.bodies.founded) || roll('Dissolved', p.bodies.dissolved) || roll('Refused', p.bodies.refused) ? `<h2>The bodies</h2><div class="rolls">${roll('Founded', p.bodies.founded)}${roll('Dissolved', p.bodies.dissolved)}${roll('Refused', p.bodies.refused)}</div>` : ''}
${t.total ? `<h2>The rulings</h2><p>${fmt(t.total)} requests were ruled on: ${fmt(t.approved)} approved, ${fmt(t.refused)} refused, ${fmt(t.lapsed)} lapsed.</p>` : ''}
${p.centres.length ? `<h2>The valley</h2>${p.centres.map((c) => `<p>${e(c.line)}</p>`).join('')}` : ''}`;
}

function compass(c) {
  const axes = c.axes.filter((a) => a.points.length >= 2);
  if (!axes.length || c.from == null || c.to == null) return '';
  const span = Math.max(1, c.to - c.from), W = 300, H = 44, mid = H / 2;
  const row = (a) => {
    const d = a.points.map(([y, v], i) => `${i ? 'L' : 'M'}${(((y - c.from) / span) * W).toFixed(1)} ${(mid - v * (mid - 4)).toFixed(1)}`).join(' ');
    return `<div class="axis"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${e(`${a.low} or ${a.high}`)}"><line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#cfd7bd" stroke-dasharray="3 3"/><path d="${d}" fill="none" stroke="#526d42" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><span class="ends"><span>${e(a.high)}</span><span>${e(a.low)}</span></span></div>`;
  };
  return `<h2>Which way it leaned</h2><p class="years"><span>Yr ${e(c.from)}</span><span>Yr ${e(c.to)}</span></p>${axes.map(row).join('')}`;
}

function shell(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:light dark;--paper:#fafbf2;--ink:#2f3f2f;--muted:#66705c;--gold:#c9a24a;--green:#526d42}
@media (prefers-color-scheme:dark){:root{--paper:#1d241d;--ink:#e8ecdc;--muted:#a9b39c;--green:#9fc08a}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Georgia,'Iowan Old Style',serif;overflow-wrap:anywhere}
main{max-width:640px;margin:0 auto;padding:40px 16px 48px}h1{font-size:40px;line-height:1.1;margin:0;text-align:center}
h2{font-size:22px;margin:32px 0 10px}h3{font:600 13px/1.4 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 6px}
.kicker,.meta,.years{font:600 13px/1.4 system-ui,sans-serif;color:var(--muted);text-align:center}.kicker{text-transform:uppercase;letter-spacing:.06em}
.lead{text-align:center;font-size:18px;border-bottom:1.5px solid var(--gold);padding-bottom:16px}
.years{display:flex;justify-content:space-between;margin:0 72px 4px 0}.axis{display:grid;grid-template-columns:minmax(0,1fr) 64px;gap:8px;margin-bottom:8px}
.axis svg{width:100%;height:44px;display:block}.ends{display:flex;flex-direction:column;justify-content:space-between;font:12px system-ui,sans-serif;color:var(--muted)}
ol,ul{padding:0;list-style:none}li{margin:0 0 8px}.yr{font:13px system-ui,sans-serif;color:var(--muted)}
.rolls{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}img.town{width:100%;height:auto;border-radius:12px;margin:12px 0}
footer{margin-top:40px;text-align:center;font:14px system-ui,sans-serif}a{color:var(--green)}
</style></head>
<body><main>
${inner}
<footer><p>A town grown in <a href="/">Hearthvale</a>, a game of a small town and its long life.</p><p><a href="/">Play Hearthvale</a></p></footer>
</main></body></html>`;
}
