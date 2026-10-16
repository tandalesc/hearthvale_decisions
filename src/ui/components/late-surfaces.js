// Surfaces that arrive late (design-systems §9.2): the budget sheet and the
// trait compass at City, and the end-of-chronicle preview at Metropolis.
import {esc, h} from '../dom.js';
import {num} from '../format.js';

export function budgetSection() {
  const el = h('section.section.budget', {hidden: true});
  let sig = '';
  return {
    el,
    update(budget, show) {
      el.hidden = !show || !budget;
      if (el.hidden) return;
      const next = JSON.stringify(budget);
      if (next === sig) return;
      sig = next;
      const all = budget.spend?.bodies ?? [];
      const bodies = all.filter((b) => b.coin > 0).sort((a, b) => b.coin - a.coin);
      const max = Math.max(1, budget.spend?.rules ?? 0, ...bodies.map((b) => b.coin));
      const bar = (label, value) => `<div class="budget-row"><span>${esc(label)}</span><span class="bar"><i style="width:${Math.round((Math.max(0, value) / max) * 100)}%"></i></span><b>${num(value)}</b></div>`;
      // With yearly budgets, the bodies' rows are this year's grants (and what is spent of them).
      const grants = (budget.budgets ?? []).filter((b) => b.granted > 0).sort((a, b) => b.granted - a.granted);
      const gmax = Math.max(1, budget.spend?.rules ?? 0, ...grants.map((b) => b.granted));
      const grantRow = (b) => `<div class="budget-row"><span>${esc(b.name)}</span><span class="bar"><i style="width:${Math.round((b.granted / gmax) * 100)}%"></i></span><b>${num(b.granted)}</b></div>`;
      el.innerHTML = grants.length
        ? `<div class="section-head"><h3>This year's budgets</h3><span class="aside">${num(grants.reduce((n, b) => n + b.spent, 0))} spent</span></div>
        <div class="purse"><div><span>Came in last year</span><b>${num(budget.income?.total)}</b></div><div><span>Granted</span><b>${num(grants.reduce((n, b) => n + b.granted, 0))}</b></div></div>
        <div class="budget-rows">${bar('Rules in force', budget.spend?.rules ?? 0)}${grants.map(grantRow).join('')}</div>`
        : `<div class="section-head"><h3>The town's purse</h3><span class="aside">last year</span></div>
        <div class="purse"><div><span>Came in</span><b>${num(budget.income?.total)}</b></div><div><span>Went out</span><b>${num(budget.spend?.total)}</b></div></div>
        <div class="budget-rows">${bar('Rules in force', budget.spend?.rules ?? 0)}${bodies.map((b) => bar(b.name, b.coin)).join('')}</div>
        ${all.length && !bodies.length ? '<p class="purse-note">The bodies spent nothing of their own.</p>' : ''}`;
    },
  };
}

// Each trait runs from −1 (left word) to +1 (right word).
const AXES = [
  ['industry', 'Fields', 'Industry'],
  ['market', 'Commons', 'Markets'],
  ['innovation', 'Old ways', 'New ways'],
  ['authority', 'Freedom', 'Order'],
];

// The four-axis compass, drawn as four two-ended scales: easier to read
// than a radar, and both ends of each axis are named.
export function compassSection() {
  const el = h('section.section.compass', {hidden: true});
  let sig = '';
  return {
    el,
    update(compass, show) {
      el.hidden = !show || !compass?.now;
      if (el.hidden) return;
      const now = compass.now;
      const next = AXES.map(([k]) => (now[k] ?? 0).toFixed(2)).join();
      if (next === sig) return;
      sig = next;
      el.innerHTML = `<div class="section-head"><h3>Which way the town leans</h3></div>` + AXES.map(([k, left, right]) => {
        const v = Math.max(-1, Math.min(1, now[k] ?? 0));
        const lean = Math.abs(v) < 0.1 ? 'balanced' : `leans to ${(v > 0 ? right : left).toLowerCase()}`;
        return `<div class="lean" role="img" aria-label="${esc(`${left} or ${right}: ${lean}`)}">
          <span class="${v < -0.1 ? 'on' : ''}">${esc(left)}</span>
          <span class="lean-track"><i class="mid"></i><i class="dot" style="left:${((v + 1) / 2 * 100).toFixed(1)}%"></i></span>
          <span class="${v > 0.1 ? 'on' : ''}">${esc(right)}</span>
        </div>`;
      }).join('');
    },
  };
}

export function previewSection() {
  const el = h('section.section.preview', {hidden: true});
  let sig = '';
  return {
    el,
    update(summary, show) {
      el.hidden = !show || !summary?.sentences?.length;
      if (el.hidden) return;
      // The narrator's closing replaces the template sentences when it arrives.
      const lines = summary.prose?.closing ? [summary.prose.closing] : summary.sentences;
      const eras = (summary.prose?.eras ?? []).filter((e) => e?.text);
      const next = JSON.stringify([lines, eras]);
      if (next === sig) return;
      sig = next;
      el.innerHTML = `<div class="preview-card"><div class="eyebrow">How will the chronicle read?</div>
        ${eras.map((e) => `<p class="preview-era"><b>${esc(e.name ?? e.title ?? '')}</b> ${esc(e.text)}</p>`).join('')}
        ${lines.map((s) => `<p>${esc(s)}</p>`).join('')}
        <div class="preview-meta">${num(summary.people)} people · ${num(summary.rules)} rules · ${(summary.institutions ?? []).filter((b) => b.status !== 'dissolved').length} bodies</div></div>`;
    },
  };
}
