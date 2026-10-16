// One body's page in the Council (design-visual §8.2), beside its cards: a
// dashboard of up to six sparklines, its rules, and the way to dissolve it.
// The Council's head names the body; this view's own head shows only where
// the page stands alone.
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {pct, short, theName} from '../format.js';
import {sparkline} from './sparkline.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {budgetSection} from './late-surfaces.js';
import {bodyBudgetSection} from './budget.js';


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
  const dash = h('section.section.dash');
  const rules = h('section.section.body-rules');
  const budget = budgetSection();
  // A body on a yearly budget: its grant, spending and plans.
  const own = bodyBudgetSection();
  const future = h('section.section.future');
  el.append(head, notes, dash, own.el, budget.el, rules, future);

  let headSig = '', dashSig = '', rulesSig = '', notesSig = '', futureSig = '';

  function renderFuture(body) {
    const show = bodyId !== 'moot';
    future.hidden = !show;
    if (!show || futureSig === body.name) return;
    futureSig = body.name;
    future.innerHTML = `<button class="btn btn-ghost btn-danger dissolve-btn">${icon('close')}Dissolve ${esc(theName(body.name))}</button>`;
    future.querySelector('.dissolve-btn').addEventListener('click', () => ctx.dissolve(bodyId));
  }

  function renderHead(body) {
    const sig = `${body.name}|${body.founded}|${body.status}`;
    if (sig === headSig) return;
    headSig = sig;
    const since = bodyId === 'moot' ? 'Speaks for the whole town' : `Sits since year ${body.founded ?? '–'}`;
    const chips = [];
    if (body.status === 'waning') chips.push('<span class="chip down">Losing heart</span>');
    if (body.status === 'petitioning') chips.push('<span class="chip river">Asking to form</span>');
    head.innerHTML = `<span class="seal-icon">${icon(ctx.bodyIcon(bodyId))}</span><div><h2>${esc(body.name)}</h2><p>${since}</p>${chips.length ? `<div class="chips" style="margin-top:6px">${chips.join('')}</div>` : ''}</div>`;
  }

  function renderNotes(body, unlocks) {
    const sig = `${unlocks.bodies}`;
    if (sig === notesSig) return;
    notesSig = sig;
    notes.replaceChildren();
    const lines = bodyId === 'moot' ? ['The Council speaks for the whole town.', 'Its numbers show how the town is going.'] : body.explainer ?? ['This body watches its own part of town.', 'It will bring you its own plans to rule on.'];
    const first = explainer(ctx, `body:${bodyId}`, lines);
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
    rules.innerHTML = `<div class="section-head"><h3>Its rules</h3><span class="count">${items.length}</span><button type="button" class="link-btn book-open">${icon('rules')}Rule Book</button></div>` + (items.length
      ? items.map((p) => `<div class="rule"><div class="rule-top"><span class="rule-title">${esc(p.title)}</span>${pips(p)}</div><p>${esc(p.summary ?? '')}</p></div>`).join('')
      : '<div class="empty">No rules of its own yet.</div>');
    rules.querySelector('.book-open').addEventListener('click', () => ctx.openRuleBook?.());
  }

  return {
    el,
    update(body, {unlocks, ruleIndex, purse}) {
      renderFuture(body);
      budget.update(purse, bodyId === 'moot' && unlocks.budget);
      own.update(bodyId !== 'moot' ? body.budget ?? null : null);
      renderHead(body);
      renderNotes(body, unlocks);
      renderDash(body, unlocks);
      renderRules(body, unlocks, ruleIndex);
    },
  };
}

export function pips(p) {
  const max = p.maxLevel ?? 3;
  if (max <= 1) return '';
  let out = '';
  for (let i = 1; i <= max; i++) out += `<i class="${i <= p.level ? 'on' : ''}"></i>`;
  return `<span class="pips" role="img" aria-label="Level ${p.level} of ${max}" title="Level ${p.level} of ${max}">${out}</span>`;
}
