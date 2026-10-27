// "Your rulings": every request you ruled on (or let lapse), newest first.
// A page of the Council (council.js), reached from its list, from the
// "requests lapsed" notice and from a follow-up line in the Chronicle.
// Each row: the year, what was asked, what you chose, how it ended
// (approved, refused, put off, lapsed, enacted by the body), who it helped
// or hurt, what the chronicle said of it since, and "Show me" where it has a
// place. Filters: everything, lapsed, refused, or one body's requests.
//
// Rows come from the sim's selectRulings (src/sim/view.js), asked for only
// while this page is open (the snapshot's panels.rulings).
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';

const PAGE = 60;
const FILTERS = [['all', 'Everything'], ['lapsed', 'Lapsed'], ['refused', 'Refused']];
// Lapsed counts what the town settled without you: unanswered, or done by a body on its own.
const LAPSED = new Set(['lapsed', 'enacted']);

export function createLedger(ctx) {
  const el = h('div.ledger');
  const filters = h('div.filter-row.ledger-filters', {role: 'toolbar', 'aria-label': 'Show some rulings'});
  const list = h('ol.ledger-list');
  const empty = h('div.empty.ledger-empty', {hidden: true});
  const more = h('button.link-btn.ledger-more', {type: 'button', hidden: true});
  more.innerHTML = `${icon('chevron-down')}Show more`;
  el.append(filters, list, empty, more);

  let rows = [], filter = 'all', shownCount = PAGE, sig = '', filterSig = '';

  filters.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b || b.dataset.filter === filter) return;
    setFilter(b.dataset.filter);
    ctx.sound?.('tick');
  });
  more.addEventListener('click', () => { shownCount += PAGE; sig = ''; render(); });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (!b) return;
    const row = rows.find((r) => r.key === b.dataset.show);
    if (row?.at) ctx.focusWorld?.(row.at);
  });

  function matches(r) {
    if (filter === 'all') return true;
    if (filter === 'lapsed') return LAPSED.has(r.outcome);
    if (filter === 'refused') return r.outcome === 'refused';
    return filter.startsWith('body:') && r.from === filter.slice(5);
  }

  function renderFilters() {
    const bodies = new Map();
    for (const r of rows) if (r.from && !bodies.has(r.from)) bodies.set(r.from, r.bodyName ?? ctx.bodyName?.(r.from) ?? r.from);
    const items = [...FILTERS, ...[...bodies].map(([id, name]) => [`body:${id}`, name])];
    if (filter !== 'all' && !items.some(([id]) => id === filter) && filter.startsWith('body:')) filter = 'all';
    const next = `${filter}|${items.map((i) => i[0]).join()}`;
    if (next === filterSig) return;
    filterSig = next;
    filters.innerHTML = items.map(([id, label]) => `<button type="button" class="filter" data-filter="${esc(id)}" aria-pressed="${id === filter}">${esc(label)}</button>`).join('');
  }

  function rowHtml(r) {
    const who = [
      r.helps?.length ? `Helped ${r.helps.map((n) => n.toLowerCase()).join(', ')}.` : '',
      r.hurts?.length ? `Hurt ${r.hurts.map((n) => n.toLowerCase()).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    const tone = r.outcome === 'approved' ? 'up' : LAPSED.has(r.outcome) || r.outcome === 'refused' ? 'down' : '';
    return `<li class="ledger-row" data-outcome="${esc(r.outcome)}" data-id="${esc(r.id)}">
      <span class="ledger-year">Yr ${esc(r.year)}</span>
      <div class="ledger-main">
        <p class="ledger-title"><b>${esc(r.title)}</b> <span class="ledger-from">${esc(r.bodyName ?? '')}</span></p>
        <p class="ledger-what"><span class="chip ${tone}">${esc(r.outcomeText)}</span>${r.choice && r.outcome !== 'refused' && r.outcome !== 'put off' ? ` <span class="ledger-choice">${esc(r.choice)}</span>` : ''}${r.byAdviser ? ' <span class="ledger-by">by your adviser</span>' : ''}</p>
        ${who ? `<p class="ledger-who">${esc(who)}</p>` : ''}
        ${(r.followups ?? []).map((t) => `<p class="ledger-since">${esc(t)}</p>`).join('')}
        ${r.at ? `<button type="button" class="link-btn ledger-show" data-show="${esc(r.key)}">${icon('locate')}Show me</button>` : ''}
      </div>
    </li>`;
  }

  function render() {
    renderFilters();
    const shown = rows.filter(matches);
    const next = `${filter}|${shownCount}|${shown.length}|${shown[0]?.key}|${shown.map((r) => r.followups?.length ?? 0).join('')}`;
    if (next === sig) return;
    sig = next;
    list.innerHTML = shown.slice(0, shownCount).map(rowHtml).join('');
    more.hidden = shown.length <= shownCount;
    empty.hidden = shown.length > 0;
    empty.innerHTML = filter === 'lapsed' ? '<b>Nothing lapsed.</b>Every request had your answer.'
      : filter === 'refused' ? '<b>Nothing refused.</b>You have said yes or let things be.'
        : rows.length ? '<b>Nothing here.</b>This body has not asked you yet.' : '<b>No rulings yet.</b>Your answers to the town gather here.';
  }

  function setFilter(next) {
    filter = next || 'all';
    shownCount = PAGE;
    sig = filterSig = '';
    render();
  }

  return {
    el,
    // data: {rows, tally} from selectRulings, or null while it is on its way.
    update(data) {
      if (!data) return;
      rows = data.rows ?? [];
      render();
    },
    setFilter,
    get filter() { return filter; },
    // How the head of the page reads: "43 approved, 21 refused, 6 lapsed."
    tallyText(t) {
      if (!t?.total) return 'Nothing ruled yet.';
      return `${t.approved} approved, ${t.refused} refused, ${t.lapsed} lapsed.`;
    },
  };
}
