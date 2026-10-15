// People: the town in numbers, and the groups (factions) with their moods.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {moodWord, num, pct} from '../format.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {compassSection} from './late-surfaces.js';

export function createPeople(ctx) {
  const el = h('div.view.people');
  const head = h('header.view-head');
  head.innerHTML = `<span class="seal-icon">${icon('people')}</span><div><h2>People</h2><p class="sub">Who lives here, and how they feel.</p></div>`;
  const sum = h('div.town-sum');
  const list = h('section.section');
  el.append(head);
  const note = explainer(ctx, 'people', EXPLAINERS.people);
  if (note) el.append(note);
  const compass = compassSection();
  el.append(sum, compass.el, list);
  let sig = '';

  return {
    el,
    update(top, factions = [], {compass: data, show} = {}) {
      compass.update(data, show);
      sum.innerHTML = `<div><b>${num(top.people)}</b><span>people</span></div>${Number.isFinite(top.homes) ? `<div><b>${num(top.homes)}</b><span>homes</span></div>` : `<div><b>${num(top.food)}</b><span>food</span></div>`}<div><b>${pct(top.wellbeing)}</b><span>wellbeing</span></div>`;
      const sorted = [...factions].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      const next = sorted.map((f) => `${f.id}${(f.mood ?? 0).toFixed(2)}${(f.trend ?? 0).toFixed(2)}`).join('|');
      if (next === sig) return;
      sig = next;
      const total = sorted.reduce((n, f) => n + (f.size ?? 0), 0) || 1;
      const max = Math.max(0.01, ...sorted.map((f) => f.size ?? 0));
      list.innerHTML = `<div class="section-head"><h3>Groups in town</h3><span class="count">${sorted.length}</span></div>` + sorted.map((f) => {
        const good = f.mood >= 0.58, bad = f.mood < 0.42;
        const arrow = f.trend > 0.01 ? 'tri-up' : f.trend < -0.01 ? 'tri-down' : 'flat';
        return `<div class="faction" data-faction="${esc(f.id)}">
          <span class="faction-name">${esc(f.name)}${f.parentName ? ` <small class="faction-parent">of the ${esc(f.parentName.toLowerCase())}</small>` : ''}${f.split ? ' <span class="chip gold">Split</span>' : ''}</span>
          <span class="faction-mood ${good ? 'good' : bad ? 'bad' : ''}">${icon(arrow)}${moodWord(f.mood)}</span>
          ${f.wants ? `<p>${esc(f.wants)}</p>` : ''}
          <div class="share"><span>${pct((f.size ?? 0) / total)} of town</span><span class="bar"><i style="width:${Math.round(((f.size ?? 0) / max) * 100)}%"></i></span></div>
        </div>`;
      }).join('');
    },
  };
}
