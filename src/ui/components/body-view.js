// One binder tab per body (design-visual §8.2): its docket, a dashboard of
// up to six sparklines, its rules, and delegation once that unlocks.
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {num, pct, short, theName} from '../format.js';
import {sparkline} from './sparkline.js';
import {createDocket} from './docket.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {budgetSection} from './late-surfaces.js';

const CAPS = [400, 800, 1500, 3000];

function metricValue(m) {
  const v = m.value ?? m.series?.[m.series.length - 1];
  if (!Number.isFinite(v)) return '–';
  if (m.unit === '%') return `${Math.round(v)}%`;
  if (m.unit === 'ratio') return pct(v);
  if (m.unit?.trim()) return `${short(v)}${m.unit}`;
  return short(v);
}

function deltaChip(d) {
  if (!Number.isFinite(d) || Math.abs(d) < 0.005) return `<span class="chip delta">${icon('flat')}0%</span>`;
  const up = d > 0;
  return `<span class="chip delta ${up ? 'up' : 'down'}">${up ? '+' : '−'}${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%</span>`;
}

export function createBodyView(ctx, bodyId) {
  const el = h('div.view.body-view', {'data-body': bodyId});
  const head = h('header.view-head');
  const notes = h('div.notes');
  const docketSec = h('section.section.docket-sec');
  docketSec.innerHTML = '<div class="section-head"><h3>Needs your ruling</h3><span class="count"></span></div>';
  const docket = createDocket(ctx, bodyId === 'moot'
    ? {empty: ['Nothing waits for you.', 'The town gets on with its day. New requests come each season.']}
    : {empty: ['Nothing from this body just now.', 'It will bring you its plans when they are ready.']});
  docketSec.append(docket.el);
  const dash = h('section.section.dash');
  const rules = h('section.section.body-rules');
  const deleg = h('section.section.delegation');
  const budget = budgetSection();
  const orders = h('section.section.orders');
  const future = h('section.section.future');
  el.append(head, notes, docketSec, dash, budget.el, rules, deleg, orders, future);

  let headSig = '', dashSig = '', rulesSig = '', delegSig = '', notesSig = '', ordersSig = '', futureSig = '';

  // Standing orders settle common requests without asking: "Always approve
  // street works up to 400 coin", "Always refuse a new tithe".
  function renderOrders(body, unlocks, categories) {
    const show = unlocks.standingOrders && categories?.length;
    orders.hidden = !show;
    if (!show) return;
    const list = body.standingOrders ?? [];
    const sig = JSON.stringify([list, categories.map((c) => c.id)]);
    if (sig === ordersSig) return;
    ordersSig = sig;
    const catName = (id) => categories.find((c) => c.id === id)?.name ?? 'all';
    const words = (o) => `${o.action === 'refuse' ? 'Always refuse' : 'Always approve'} ${o.match?.category ? `${catName(o.match.category).toLowerCase()} requests` : 'its requests'}${o.action !== 'refuse' && Number.isFinite(o.maxCost) ? ` up to ${num(o.maxCost)} coin` : ''}.`;
    orders.innerHTML = `<div class="section-head"><h3>Standing orders</h3><span class="count">${list.length || ''}</span></div>
      <p class="section-note">Settle common requests without asking you each time.</p>
      ${list.map((o) => `<div class="order" data-order="${esc(o.id)}"><span>${esc(words(o))}</span><button class="icon-btn" data-remove="${esc(o.id)}" aria-label="Remove this order">${icon('close')}</button></div>`).join('')}
      <div class="order-form">
        <select data-f="action" aria-label="Approve or refuse"><option value="approve">Always approve</option><option value="refuse">Always refuse</option></select>
        <select data-f="category" aria-label="Which requests">${categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
        <select data-f="cap" aria-label="Up to what cost"><option value="">at any cost</option>${[200, 400, 800, 1500].map((c) => `<option value="${c}">up to ${num(c)} coin</option>`).join('')}</select>
        <button class="btn btn-secondary" data-add>Add order</button>
      </div>`;
    orders.querySelector('[data-add]').addEventListener('click', () => {
      const f = (k) => orders.querySelector(`[data-f="${k}"]`).value;
      const cap = Number(f('cap'));
      ctx.setStandingOrder(bodyId, {match: {category: f('category')}, action: f('action'), ...(cap ? {maxCost: cap} : {})});
    });
    orders.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => ctx.setStandingOrder(bodyId, {id: b.dataset.remove, remove: true})));
  }

  function renderFuture(body) {
    const show = bodyId !== 'moot';
    future.hidden = !show;
    if (!show || futureSig === body.name) return;
    futureSig = body.name;
    future.innerHTML = `<button class="btn btn-ghost btn-danger dissolve-btn">${icon('close')}Dissolve ${esc(theName(body.name))}</button>`;
    future.querySelector('.dissolve-btn').addEventListener('click', () => ctx.dissolve(bodyId));
  }

  function renderHead(body) {
    const sig = `${body.name}|${body.founded}|${body.delegated}|${body.status}`;
    if (sig === headSig) return;
    headSig = sig;
    const since = bodyId === 'moot' ? 'Speaks for the whole town' : `Sits since year ${body.founded ?? '–'}`;
    const chips = [];
    if (body.delegated) chips.push('<span class="chip gold">Runs its own affairs</span>');
    if (body.status === 'waning') chips.push('<span class="chip down">Losing heart</span>');
    if (body.status === 'petitioning') chips.push('<span class="chip river">Asking to form</span>');
    head.innerHTML = `<span class="seal-icon">${icon(ctx.bodyIcon(bodyId))}</span><div><h2>${esc(body.name)}</h2><p>${since}</p>${chips.length ? `<div class="chips" style="margin-top:6px">${chips.join('')}</div>` : ''}</div>`;
  }

  function renderNotes(body, unlocks) {
    const sig = `${unlocks.bodies}|${unlocks.delegation}`;
    if (sig === notesSig) return;
    notesSig = sig;
    notes.replaceChildren();
    const lines = bodyId === 'moot' ? EXPLAINERS.docket : body.explainer ?? ['This body watches its own part of town.', 'It will bring you its own plans to rule on.'];
    const first = explainer(ctx, bodyId === 'moot' ? 'docket' : `body:${bodyId}`, lines);
    if (first) notes.append(first);
  }

  function renderDash(body, unlocks) {
    const show = unlocks.bodies && body.metrics?.length;
    dash.hidden = !show;
    if (!show) return;
    const sig = body.metrics.map((m) => `${m.id}:${m.series?.length}:${m.value}:${m.series?.[m.series.length - 1]}`).join('|') + `|${body.power?.toFixed(2)}|${body.patience?.toFixed(2)}`;
    if (sig === dashSig) return;
    dashSig = sig;
    const rows = body.metrics.slice(0, 6).map((m) => `<div class="metric-row"><span class="m-label">${esc(m.label)}</span><span class="m-value">${metricValue(m)}</span>${sparkline(m.series)}${deltaChip(m.change)}</div>`).join('');
    const meters = bodyId === 'moot' || !Number.isFinite(body.power) ? '' : `<div class="meters">
      <div class="meter" title="How much weight it carries in town"><span>Sway · ${pct(body.power)}</span><div class="bar"><i style="width:${pct(body.power)}"></i></div></div>
      <div class="meter ${body.patience < 0.3 ? 'is-low' : ''}" title="How long it will wait for you"><span>Patience · ${pct(body.patience)}</span><div class="bar"><i style="width:${pct(body.patience)}"></i></div></div>
    </div>`;
    dash.innerHTML = `<div class="section-head"><h3>How it is going</h3><span class="aside">last five years</span></div><div class="metric-rows">${rows}</div>${meters}`;
  }

  function renderRules(body, unlocks, ruleIndex) {
    const show = unlocks.ruleBook && bodyId !== 'moot';
    rules.hidden = !show;
    if (!show) return;
    const items = (body.rules ?? []).map((r) => ({...ruleIndex[r.id], ...r, maxLevel: r.maxLevel ?? ruleIndex[r.id]?.maxLevel})).filter((r) => r.title);
    const sig = items.map((r) => r.id + r.level).join(',');
    if (sig === rulesSig) return;
    rulesSig = sig;
    rules.innerHTML = `<div class="section-head"><h3>Its rules</h3><span class="count">${items.length}</span></div>` + (items.length
      ? items.map((p) => `<div class="rule"><div class="rule-top"><span class="rule-title">${esc(p.title)}</span>${pips(p)}</div><p>${esc(p.summary ?? '')}</p></div>`).join('')
      : '<div class="empty">No rules of its own yet.</div>');
  }

  function renderDelegation(body, unlocks) {
    const show = unlocks.delegation && bodyId !== 'moot' && body.canDelegate !== false;
    deleg.hidden = !show;
    if (!show) return;
    const sig = `${body.delegated}|${body.cap}`;
    if (sig === delegSig) return;
    delegSig = sig;
    const cap = body.cap || 800;
    deleg.innerHTML = `<div class="section-head"><h3>Its affairs</h3></div>
      <div class="delegate">
        <b>Let them run their own affairs</b>
        <button class="switch" role="switch" aria-checked="${Boolean(body.delegated)}" aria-label="Let ${esc(theName(body.name))} run its own affairs"></button>
        <p>${body.delegated ? `It decides for itself and spends up to ${num(cap)} coin a year. You get a yearly report.` : 'It would decide its own requests within a yearly cap and send you a report instead.'}</p>
        <label class="field" style="grid-column:1/-1;border:0;padding:0"><span>Yearly cap</span><select class="cap">${CAPS.map((c) => `<option value="${c}" ${c === cap ? 'selected' : ''}>${num(c)} coin</option>`).join('')}</select></label>
      </div>`;
    const note = explainer(ctx, 'delegation', EXPLAINERS.delegation);
    if (note) deleg.prepend(note);
    const sw = deleg.querySelector('.switch');
    const capSel = deleg.querySelector('.cap');
    sw.addEventListener('click', () => ctx.setDelegated(bodyId, sw.getAttribute('aria-checked') !== 'true', Number(capSel.value)));
    capSel.addEventListener('change', () => { if (body.delegated) ctx.setDelegated(bodyId, true, Number(capSel.value)); });
  }

  return {
    el,
    docket,
    update(body, {cards, unlocks, ruleIndex, phone, purse, categories}) {
      renderOrders(body, unlocks, categories);
      renderFuture(body);
      budget.update(purse, bodyId === 'moot' && unlocks.budget);
      renderHead(body);
      renderNotes(body, unlocks);
      const mine = bodyId === 'moot' ? cards : cards.filter((c) => c.from === bodyId);
      setText(docketSec.querySelector('h3'), body.delegated ? 'Reports' : 'Needs your ruling');
      setText(docketSec.querySelector('.count'), mine.length ? String(mine.length) : '');
      docket.update(mine, {phone});
      renderDash(body, unlocks);
      renderRules(body, unlocks, ruleIndex);
      renderDelegation(body, unlocks);
    },
  };
}

export function pips(p) {
  const max = p.maxLevel ?? 3;
  if (max <= 1) return '';
  let out = '';
  for (let i = 1; i <= max; i++) out += `<i class="${i <= p.level ? 'on' : ''}"></i>`;
  return `<span class="pips" title="Level ${p.level} of ${max}">${out}</span>`;
}
