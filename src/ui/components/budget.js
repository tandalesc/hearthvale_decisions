// Budgets in the Council (docs/design/governance-budgets-advisors.md §3.8, §8):
// the budget card (its lines, with plans you can strike, and the whole-budget
// answers), the season summary beside the cards (asked against the town's
// room, "Approve the rest", "Trim all to fit", every body's ask), the strip
// that sums the season up on phones, and a body's "Its budget" section.
//
// Answers go through ctx.onRule(card, option) like any card; striking a line
// through ctx.onBudget('strikeBudgetLine', card.id, lineId, on); the season's
// buttons through ctx.onBudget('approveAllBudgets' | 'trimAllToFit').
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {inMonths, num, short, signed, theName} from '../format.js';
import {adviceBanner, bindAdvice} from './advisers.js';

const TRIMS = [['trim90', '90%'], ['trim75', '75%'], ['trim50', 'Half']];
const deltaChip = (d) => (Number.isFinite(d) && d !== 0 ? `<span class="chip ${d > 0 ? 'gold' : 'up'}">${signed(d)}%</span>` : '');

// The full budget card. Same contract as card.js createCard: an element with
// __update(card) and __reopen().
export function createBudgetCard(card, ctx) {
  const el = h('article.card.budget-card', {'data-kind': 'budget', 'aria-labelledby': `t-${card.id}`});
  let latest = card, sig = '';
  const option = (key) => latest.options.find((o) => o.key === key) ?? {key};

  bindAdvice(el, ctx, () => latest);
  el.addEventListener('click', (e) => {
    const strike = e.target.closest('[data-strike]');
    if (strike) {
      const on = strike.getAttribute('aria-pressed') !== 'true';
      ctx.onBudget?.('strikeBudgetLine', latest.id, strike.dataset.strike, on);
      return;
    }
    const answer = e.target.closest('[data-option]');
    if (answer && !answer.disabled) ctx.onRule(latest, option(answer.dataset.option), el);
  });

  function render() {
    const c = latest, b = c.budget;
    if (!b) return;
    const next = JSON.stringify([b, c.expiresInMonths, c.advice]);
    if (next === sig) return;
    sig = next;
    const name = ctx.bodyName(c.from);
    const lines = b.lines.map((l) => {
      const label = `<span class="bud-label">${esc(l.label)}${l.askFirst ? ' <small>(asks you first)</small>' : ''}</span><span class="bud-cost">${num(l.cost)}</span>`;
      if (l.kind !== 'plan') return `<li class="bud-line" data-kind="${l.kind}">${label}</li>`;
      const what = l.struck ? `Put back: ${l.label}` : `Strike: ${l.label}`;
      return `<li class="bud-line is-plan${l.struck ? ' is-struck' : ''}"><button type="button" class="bud-strike" data-strike="${esc(l.id)}" aria-pressed="${l.struck}" aria-label="${esc(what)}" title="${l.struck ? 'Put this plan back' : 'Strike this plan: it waits three years'}">${icon(l.struck ? 'refresh' : 'close')}</button>${label}</li>`;
    }).join('');
    const outcomes = (b.outcomes ?? []).filter((o) => Number.isFinite(o.from) && Number.isFinite(o.to))
      .map((o) => `${esc(o.label)} ${short(o.from)} → ${short(o.to)}`).join(' · ');
    const last = b.last.first
      ? `Its purse brought about ${num(b.last.granted)} last year.`
      : `Last year ${num(b.last.granted)} granted, ${num(b.last.spent)} spent${b.last.returned ? `, ${num(b.last.returned)} returned` : ''}.`;
    const trims = TRIMS.map(([key, label]) => `<button type="button" class="bud-trim" data-option="${key}" title="${esc(b.tradeoffs?.[key] ?? '')}">${label}<small>${num(b.grants?.[key])}</small></button>`).join('');
    el.classList.toggle('is-advised', !!c.advice?.act);
    el.classList.remove('is-changing');
    el.innerHTML = `
      <h3 class="card-title" id="t-${esc(c.id)}">Budget for year ${b.year}</h3>
      <div class="card-meta">
        <span class="card-from">${icon(ctx.bodyIcon(c.from))}<span>${esc(name)}</span></span>
      </div>
      <div class="bud-ask"><span>Asks <b>${num(b.asked)}</b></span>${deltaChip(b.delta)}</div>
      <p class="bud-last">${esc(last)}</p>
      <ul class="bud-lines" aria-label="What it asks for">${lines}</ul>
      ${b.lines.some((l) => l.kind === 'plan') ? `<p class="bud-hint">Strike a plan to leave it out. It may pay for small things under ${num(b.small)} without asking.</p>` : `<p class="bud-hint">It may pay for small things under ${num(b.small)} without asking.</p>`}
      ${outcomes ? `<p class="bud-note">${icon('details')}<span>Over the year: ${outcomes}.</span></p>` : ''}
      ${b.done?.length ? `<p class="bud-note">${icon('check')}<span>It began: ${esc(b.done.join(', ').toLowerCase())}.</span></p>` : ''}
      ${b.rules?.length ? `<p class="bud-note">${icon('rules')}<span>It will also ask you for: ${esc(b.rules.map((r) => r.title).join(', '))}. Rules always come to you.</span></p>` : ''}
      ${adviceBanner(c.advice)}
      <div class="options">
        <button type="button" class="option is-primary" data-option="approve"><span class="opt-label">Approve ${num(b.grants?.approve)}</span><span class="opt-go">${icon('arrow-right')}</span><span class="opt-trade">${esc(b.tradeoffs?.approve ?? '')}</span></button>
        <div class="bud-trims" role="group" aria-label="Trim it to"><span class="bud-trims-label">Trim to</span>${trims}</div>
        <button type="button" class="option" data-option="same"><span class="opt-label">Same as last year</span><span class="opt-go">${icon('arrow-right')}</span><span class="opt-trade">${esc(b.tradeoffs?.same ?? '')}</span></button>
      </div>
      <div class="minor-options"><button type="button" class="minor is-refuse" data-option="refuse"><b>Refuse</b><small>${esc(b.tradeoffs?.refuse ?? '')}</small></button></div>
      <div class="card-foot"><span class="expiry">${icon('clock')}<span class="expiry-text">${Number.isFinite(c.expiresInMonths) ? `Unanswered, it keeps last year's figure ${inMonths(c.expiresInMonths)}` : ''}</span></span></div>`;
  }

  el.__update = (next) => {
    latest = next ?? latest;
    render();
  };
  el.__reopen = () => {};
  el.__update(card);
  return el;
}

// A folded budget card in the desktop stack.
export function budgetNextText(card, ctx) {
  const b = card.budget;
  return {from: ctx.bodyName(card.from), title: b ? `Asks ${num(b.asked)}${Number.isFinite(b.delta) && b.delta ? ` (${signed(b.delta)}%)` : ''}` : card.title};
}

// The season beside the cards: asked against room, the chest, the two
// whole-season answers, and every body's ask.
export function seasonSummary(ctx) {
  const el = h('section.section.bud-season');
  let sig = '';
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-season]');
    if (act) return ctx.onBudget?.(act.dataset.season);
    const row = e.target.closest('[data-card]');
    if (row) ctx.focusCard?.(row.dataset.card);
  });
  return {
    el,
    update(s) {
      el.hidden = !s;
      if (!s) return;
      const next = JSON.stringify(s);
      if (next === sig) return;
      sig = next;
      const asked = s.asked + s.granted;
      const max = Math.max(1, asked, s.room);
      const bar = (label, value, cls = '') => `<div class="bud-bar ${cls}"><span>${label}</span><span class="bar"><i style="width:${Math.round((Math.max(0, value) / max) * 100)}%"></i></span><b>${num(value)}</b></div>`;
      el.innerHTML = `<div class="section-head"><h3>The season</h3><span class="aside">${s.answered} of ${s.total} answered</span></div>
        ${bar('Asked', asked, s.over > 0 ? 'is-over' : '')}${bar('Room', s.room)}
        <p class="bud-chest">${icon('coin')}<span>The chest holds ${num(s.chest)}.</span></p>
        ${(s.advisers ?? []).map((t) => `<p class="bud-adv">${icon('quill')}<span>${esc(t)}</span></p>`).join('')}
        ${s.over > 0 ? `<p class="bud-warn">Approving all draws ${num(s.over)} from the chest.</p>` : s.open ? '<p class="bud-fine">Every ask fits this season\'s room.</p>' : ''}
        ${s.open ? `<div class="bud-actions">
          <button type="button" class="btn btn-primary" data-season="approveAllBudgets">Approve the rest as asked</button>
          ${s.over > 0 ? '<button type="button" class="btn" data-season="trimAllToFit">Trim all to fit</button>' : ''}
        </div>` : ''}
        <div class="section-head bud-by"><h3>By body</h3></div>
        <ul class="bud-rows">${s.rows.map((r) => `<li>${r.cardId ? `<button type="button" class="bud-row" data-card="${esc(r.cardId)}">` : '<div class="bud-row is-done">'}
          <span class="bud-row-name">${esc(theName(r.name).replace(/^the /i, ''))}</span>
          <span class="bud-row-num">${num(r.answered ? r.granted : r.asked)}</span>
          ${r.answered ? `<span class="chip up">${icon('check')}${esc(CHOICE[r.choice] ?? 'Answered')}</span>` : deltaChip(r.delta)}
        ${r.cardId ? '</button>' : '</div>'}</li>`).join('')}</ul>`;
    },
  };
}
const CHOICE = {approve: 'Approved', trim90: 'Trimmed', trim75: 'Trimmed', trim50: 'Cut', trim: 'Trimmed', same: 'Kept', refuse: 'Refused', lapsed: 'Kept'};

// Phones: one line over the cards with the season's sums and "Trim to fit".
export function seasonStrip(ctx) {
  const el = h('div.bud-strip', {hidden: true});
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-season]');
    if (act) ctx.onBudget?.(act.dataset.season);
  });
  let sig = '';
  return {
    el,
    update(s, show) {
      el.hidden = !show || !s;
      if (el.hidden) return;
      const next = JSON.stringify([s.asked, s.granted, s.room, s.over, s.open]);
      if (next === sig) return;
      sig = next;
      el.innerHTML = `<span class="bud-strip-text"><b>Asked ${short(s.asked + s.granted)}</b> · Room ${short(s.room)}</span>${s.over > 0 && s.open ? '<button type="button" class="btn" data-season="trimAllToFit">Trim to fit</button>' : ''}`;
    },
  };
}

// A body's page: "Its budget" (this year's grant, spent so far, its plans,
// and five years of grant against spend).
export function bodyBudgetSection() {
  const el = h('section.section.bud-body', {hidden: true});
  let sig = '';
  return {
    el,
    update(b) {
      el.hidden = !b;
      if (!b) return;
      const next = JSON.stringify(b);
      if (next === sig) return;
      sig = next;
      const spent = b.spent.running + b.spent.plans + b.spent.other;
      const w = (x) => `${Math.round((Math.max(0, x) / Math.max(1, b.granted, spent)) * 100)}%`;
      const max = Math.max(1, ...b.history.flatMap((x) => [x.granted, x.spent]));
      el.innerHTML = `<div class="section-head"><h3>Its budget</h3><span class="aside">year ${b.year} · granted ${num(b.granted)}</span></div>
        <div class="bud-spent" role="img" aria-label="${esc(`Spent ${num(spent)} of ${num(b.granted)}`)}"><i class="run" style="width:${w(b.spent.running)}"></i><i class="plan" style="width:${w(b.spent.plans)}"></i><i class="other" style="width:${w(b.spent.other)}"></i></div>
        <p class="bud-spent-text">Spent ${num(spent)}: running ${num(b.spent.running)} · plans ${num(b.spent.plans)} · other ${num(b.spent.other)}</p>
        ${b.lines.length ? `<ul class="bud-plans">${b.lines.map((l) => `<li class="${l.started ? 'is-started' : ''}">${icon(l.started ? 'check' : 'clock')}<span>${esc(l.label)}</span><b>${num(l.cost)}</b></li>`).join('')}</ul>` : ''}
        ${b.history.length ? `<div class="bud-years" aria-label="Granted and spent, last years">${b.history.map((x) => `<span title="${esc(`Year ${x.y}: granted ${num(x.granted)}, spent ${num(x.spent)}`)}"><i class="g" style="height:${Math.round((x.granted / max) * 100)}%"></i><i class="s" style="height:${Math.round((x.spent / max) * 100)}%"></i></span>`).join('')}</div>` : ''}
        ${b.next ? `<p class="bud-spent-text">Next year: ${num(b.next.granted)} granted.</p>` : ''}`;
    },
  };
}

export {setText};
