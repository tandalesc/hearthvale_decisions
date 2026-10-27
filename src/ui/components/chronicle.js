// Chronicle: a vertical timeline grouped by era (design-visual §8.5). It
// holds the most recent lines; "Show earlier lines" asks for more, so a long
// town's history never loads all at once, and era groups out of view skip
// rendering. New lines also pass through the notice stack as they come
// (app.js). Lines
// about one place carry its name as a quiet tag; with two or more centres
// the timeline can be filtered to one place.
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {ERA_NAMES, ERA_NUMERALS, ERA_SWATCHES} from '../format.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {previewSection} from './late-surfaces.js';

export function createChronicle(ctx) {
  const el = h('div.view.chronicle');
  const head = h('header.view-head');
  head.innerHTML = `<span class="seal-icon">${icon('chronicle')}</span><div><h2>Chronicle</h2><p class="sub"></p></div>`;
  // The town's own name, chosen on the main menu; older towns are Hearthvale.
  const sub = head.querySelector('.sub');
  const nameSub = () => setText(sub, `The story of ${ctx.townName?.() || 'Hearthvale'} so far.`);
  nameSub();
  const list = h('div.timeline');
  const filters = h('div.filter-row', {role: 'toolbar', 'aria-label': 'Show lines about one place', hidden: true});
  el.append(head);
  const note = explainer(ctx, 'chronicle', EXPLAINERS.chronicle);
  if (note) el.append(note);
  const preview = previewSection();
  // From year 150 the preview leads to the full end page.
  const story = h('button.btn.btn-ghost.chronicle-story', {type: 'button', hidden: true});
  story.innerHTML = `${icon('scroll')}Read the town's story`;
  story.addEventListener('click', () => ctx.openEndPage?.());
  const more = h('button.link-btn.chronicle-more', {type: 'button', hidden: true});
  more.innerHTML = `${icon('chevron-down')}Show earlier lines`;
  more.addEventListener('click', () => ctx.moreChronicle?.());
  el.append(preview.el, story, filters, list, more);
  let sig = '', place = 'all', last = null;

  // A follow-up line (what came of a ruling) links to "Your rulings".
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-ruling]')) ctx.openRulings?.();
  });
  filters.addEventListener('click', (e) => {
    const b = e.target.closest('[data-place]');
    if (!b || b.dataset.place === place) return;
    place = b.dataset.place;
    sig = '';
    if (last) render(...last);
  });

  function render(entries, centres) {
    const names = new Map(centres.map((c) => [String(c.id), c.name]));
    const multi = names.size >= 2;
    if (!multi || (place !== 'all' && !names.has(place))) place = 'all';
    const next = `${entries.length}|${entries.at(-1)?.key ?? entries.at(-1)?.text}|${place}|${[...names].join()}`;
    if (next === sig) return;
    sig = next;
    filters.hidden = !multi;
    filters.innerHTML = multi ? [['all', 'Everywhere'], ...names].map(([id, name]) => `<button class="filter" data-place="${esc(id)}" aria-pressed="${place === id}">${esc(name)}</button>`).join('') : '';
    const shown = place === 'all' ? entries : entries.filter((e) => centreOf(e) === place);
    const groups = new Map();
    for (const e of shown) {
      const era = Number.isFinite(e.era) ? e.era : 0;
      if (!groups.has(era)) groups.set(era, []);
      groups.get(era).push(e);
    }
    const tag = (e) => {
      const name = multi && place === 'all' ? names.get(centreOf(e)) : null;
      return name ? `<span class="place-tag">${esc(name)}</span>` : '';
    };
    list.innerHTML = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([era, items]) => `
      <section class="era-group">
        <div class="era-head"><span class="num">${ERA_NUMERALS[era] ?? era}</span><h3>${ERA_NAMES[era] ?? 'Era'}</h3><span class="swatches" aria-hidden="true">${(ERA_SWATCHES[era] ?? []).map((c) => `<i style="background:${c}"></i>`).join('')}</span></div>
        <ol class="entries">${[...items].reverse().map((e) => `<li class="entry k-${esc(e.kind ?? 'line')}"><span class="yr">Yr ${esc(e.year ?? '')}</span><span class="txt">${tag(e)}${e.kind === 'decision' ? icon('seal', 'seal') : ''}${esc(e.text)}${e.refs?.followup && e.refs.card ? ` <button type="button" class="link-btn ledger-link" data-ruling="${esc(e.refs.card)}">Your rulings</button>` : ''}</span></li>`).join('')}</ol>
      </section>`).join('') || `<div class="empty">${place === 'all' ? 'The story starts here.' : `Nothing written about ${esc(names.get(place))} yet.`}</div>`;
  }

  return {
    el,
    // centres: [{id, name}] for the live centres; earlier: older lines exist.
    // ended: the chronicle has closed (year 150), so the end page can be read.
    update(entries = [], {summary, show, ended = false, centres = [], earlier = false} = {}) {
      nameSub();
      preview.update(summary, show);
      story.hidden = !ended;
      more.hidden = !earlier;
      last = [entries, centres];
      render(entries, centres);
    },
  };
}

// The centre a line is about, from its refs (or a flat centreId).
function centreOf(e) {
  const id = e.refs?.centreId ?? e.centreId;
  return id == null ? null : String(id);
}
