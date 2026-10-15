// Tensions: pairs of rules that pull against each other (design-systems §4.1).
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {num} from '../format.js';
import {explainer, EXPLAINERS} from './explainer.js';

const PULL = '<svg viewBox="0 0 30 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h9M6 4 2 8l4 4M28 8h-9M24 4l4 4-4 4"/></svg>';

export function createTensions(ctx) {
  const el = h('div.view.tensions');
  const head = h('header.view-head');
  head.innerHTML = `<span class="seal-icon">${icon('tensions')}</span><div><h2>Tensions</h2><p class="sub"></p></div>`;
  const list = h('div.section');
  el.append(head);
  const note = explainer(ctx, 'tensions', EXPLAINERS.tensions);
  if (note) el.append(note);
  el.append(list);
  let sig = '';

  return {
    el,
    update({rules: tensions = [], torn = []} = {}) {
      const next = tensions.map((t) => t.id).join('|') + '#' + torn.map((t) => t.id).join('|');
      if (next === sig) return;
      sig = next;
      head.querySelector('.sub').textContent = tensions.length
        ? `${tensions.length} ${tensions.length === 1 ? 'pair of rules pulls' : 'pairs of rules pull'} against each other.`
        : 'Your rules work together.';
      list.innerHTML = tensions.length ? tensions.map((t) => `
        <article class="tension" data-tension="${esc(t.id)}">
          <div class="tension-pair"><span class="side">${esc(t.a?.title)}</span><span class="pull">${PULL}</span><span class="side">${esc(t.b?.title)}</span></div>
          ${t.text ? `<p>${esc(t.text)}</p>` : ''}
          ${t.forA?.length || t.forB?.length ? `<div class="backers"><div>Backed by ${esc((t.forA ?? []).join(', ') || 'no one')}</div><div>Backed by ${esc((t.forB ?? []).join(', ') || 'no one')}</div></div>` : ''}
          <div class="net">${esc(t.net ?? 'Nothing moves while both stand.')}${Number.isFinite(t.upkeep) ? ` Together they cost ${num(t.upkeep)} coin a year.` : ''}</div>
        </article>`).join('')
        : '<div class="empty"><b>No tensions.</b>No two rules fight each other right now.</div>';
      if (torn.length) list.insertAdjacentHTML('beforeend', `<div class="section-head" style="margin-top:18px"><h3>Torn households</h3></div>${torn.map((t) => `<div class="torn">${esc(t.text)}</div>`).join('')}`);
    },
  };
}
