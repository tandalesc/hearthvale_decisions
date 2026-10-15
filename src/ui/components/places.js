// Places: the valley's centres (design-centres §7). One row per centre: its
// name, size, character, how much it runs itself, a growth line, and a way
// to fly there or open its ward council.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {num, pct} from '../format.js';
import {sparkline} from './sparkline.js';
import {explainer} from './explainer.js';

// A growth line only once the centre has a history; never an empty frame.
const hasHistory = (c) => (c.popSeries ?? []).filter(Number.isFinite).length >= 2;

const KIND = {hamlet: 'Hamlet', village: 'Village', town: 'Town', borough: 'Borough', city: 'City'};

export function createPlaces(ctx) {
  const el = h('div.view.places');
  const head = h('header.view-head');
  head.innerHTML = `<span class="seal-icon">${icon('map')}</span><div><h2>Places</h2><p class="sub"></p></div>`;
  const list = h('div.section.place-list');
  el.append(head);
  const note = explainer(ctx, 'places', ['The valley has more than one centre now.', 'Each grows its own way. Some will want to run their own affairs.']);
  if (note) el.append(note);
  el.append(list);
  let sig = '';

  list.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) ctx.focusWorld({x: Number(go.dataset.x), z: Number(go.dataset.z)});
    const body = e.target.closest('[data-body]');
    if (body) ctx.openBody(body.dataset.body);
  });

  return {
    el,
    update(data, current) {
      const centres = (data?.centres ?? []).filter((c) => !c.mergedInto);
      const next = JSON.stringify([centres.map((c) => [c.id, c.pop, c.kind, c.autonomy?.toFixed(2), c.popSeries?.length, c.bodyId]), current]);
      if (next === sig) return;
      sig = next;
      const total = data?.region?.people ?? centres.reduce((n, c) => n + (c.pop ?? 0), 0);
      head.querySelector('.sub').textContent = `${num(total)} people in ${centres.length} ${centres.length === 1 ? 'place' : 'places'}.`;
      list.innerHTML = [...centres].sort((a, b) => (b.seat - a.seat) || (b.pop ?? 0) - (a.pop ?? 0)).map((c) => `
        <article class="place ${c.id === current ? 'is-here' : ''}" data-centre="${esc(c.id)}">
          <div class="place-top">
            <span class="place-name">${esc(c.name)}</span>
            ${c.seat ? '<span class="chip gold">The seat</span>' : ''}
            ${c.id === current ? '<span class="chip river">You are here</span>' : ''}
            <span class="place-pop">${num(c.pop)}<small> people</small></span>
          </div>
          <div class="place-meta">${esc(KIND[c.kind] ?? c.kind ?? '')}${c.characterName ? ` · ${esc(c.characterName)}` : ''}${c.federated ? ' · in the federation' : ''}</div>
          <div class="place-row${hasHistory(c) ? '' : ' no-spark'}">
            <div class="meter"><span>Runs itself · ${pct(c.autonomy ?? 0)}</span><div class="bar"><i style="width:${pct(c.autonomy ?? 0)}"></i></div></div>
            ${hasHistory(c) ? sparkline(c.popSeries) : ''}
          </div>
          <div class="place-actions">
            ${Number.isFinite(c.x) ? `<button class="btn btn-secondary" data-go data-x="${c.x}" data-z="${c.z}">${icon('locate')}Go there</button>` : ''}
            ${c.bodyId ? `<button class="btn btn-ghost" data-body="${esc(c.bodyId)}">${icon('flag')}Its council</button>` : ''}
          </div>
        </article>`).join('');
    },
  };
}
