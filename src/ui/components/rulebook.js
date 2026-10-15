// The Rule Book: every rule in force, by category. Rules change only through
// proposals, so there are no toggles here; just what stands and who set it.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {pips} from './body-view.js';

export function createRuleBook(ctx) {
  const el = h('div.view.rulebook');
  const head = h('header.view-head');
  head.innerHTML = `<span class="seal-icon">${icon('rules')}</span><div><h2>The Rule Book</h2><p class="sub"></p></div>`;
  const filters = h('div.filter-row', {role: 'toolbar', 'aria-label': 'Filter rules'});
  const body = h('div.rule-list');
  el.append(head);
  const note = explainer(ctx, 'rules', EXPLAINERS.rules);
  if (note) el.append(note);
  el.append(filters, body);
  let filter = 'all', sig = '', data = [];

  filters.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    filter = b.dataset.cat;
    sig = '';
    render();
  });

  function render() {
    const cats = data.filter((c) => c.policies.length);
    const total = cats.reduce((n, c) => n + c.policies.length, 0);
    const next = `${filter}|${cats.map((c) => c.id + c.policies.map((p) => p.id + p.level + p.tensions?.length).join('')).join('|')}`;
    if (next === sig) return;
    sig = next;
    head.querySelector('.sub').textContent = total ? `${total} ${total === 1 ? 'rule stands' : 'rules stand'} in ${cats.length} ${cats.length === 1 ? 'area' : 'areas'}.` : 'No rules yet.';
    filters.hidden = cats.length < 3;
    filters.innerHTML = [['all', 'All'], ...cats.map((c) => [c.id, c.name])]
      .map(([id, name]) => `<button class="filter" data-cat="${esc(id)}" aria-pressed="${filter === id}">${esc(name)}</button>`).join('');
    const titles = Object.fromEntries(cats.flatMap((c) => c.policies.map((p) => [p.id, p.title])));
    const shown = filter === 'all' ? cats : cats.filter((c) => c.id === filter);
    body.innerHTML = shown.length ? shown.map((c) => `
      <section class="rule-cat">
        <div class="section-head"><h3>${esc(c.name)}</h3><span class="count">${c.policies.length}</span></div>
        ${c.policies.map((p) => `
          <div class="rule" data-rule="${esc(p.id)}">
            <div class="rule-top"><span class="rule-title">${esc(p.title)}</span>${pips(p)}</div>
            <p>${esc(p.summary ?? '')}</p>
            <div class="meta">
              <span>Since year ${esc(p.since ?? '–')} · set by ${esc(p.byName ?? (p.by === 'player' ? 'You' : ctx.bodyName(p.by)))}</span>
              ${(p.tensions ?? []).map((t) => `<span class="chip down">${icon('tensions')}Pulls against ${esc(titles[t] ?? t)}</span>`).join('')}
              ${p.againstGrain ? '<span class="chip gold">Against the town\'s grain</span>' : ''}
            </div>
          </div>`).join('')}
      </section>`).join('')
      : '<div class="empty" style="margin-top:14px"><b>The book is empty.</b>Bodies will bring you rules to adopt.</div>';
  }

  return {
    el,
    update(ruleBook) {
      data = ruleBook ?? [];
      render();
    },
  };
}
