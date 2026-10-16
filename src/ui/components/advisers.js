// Advisers in the Council (docs/design/governance-budgets-advisors.md §4, §8.3-8.4):
// the bench's seats, each with its adviser's card (who they are, what they
// believe, how they have done, their mode, Dismiss) or, when empty, the slate
// of townsfolk to hire from; and the banner on a card an adviser has answered
// (Let it stand / Change) or would answer (a recommendation).
//
// ctx.onAdviser(action, ...args): 'hireAdviser' | 'setAdviserMode' | 'redrawSlate' | 'letStand';
// ctx.dismissAdviser(adviser) asks first; ctx.focusCard(id) opens a card.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {inMonths, num} from '../format.js';
import {sparkline} from './sparkline.js';

const MODE_LABEL = {advise: 'Advise only', routine: 'Routine', all: 'All in their area'};
const MODE_NOTE = {
  advise: 'They only say what they would do. Everything comes to you.',
  routine: 'They answer plans, budgets and reports. Rules on their pet issues, demands, debates and petitions come to you.',
  all: 'They also answer rules, demands and debates in their area. Events and new bodies come to you.',
};
const AXES = [['industry', 'Fields', 'Industry'], ['market', 'Commons', 'Markets'], ['innovation', 'Old ways', 'New ways'], ['authority', 'Freedom', 'Order']];

// The banner on a card an adviser answered (staged) or would answer.
export function adviceBanner(advice) {
  if (!advice) return '';
  const why = (advice.rationale ?? []).map((t) => `<li>${esc(t)}.</li>`).join('');
  if (!advice.act) {
    return `<div class="advice is-recommend" data-adviser="${esc(advice.adviserId)}">${icon('quill')}<div class="advice-text"><b>${esc(advice.name)} would ${esc(advice.verb)}.</b>${why ? `<ul>${why}</ul>` : ''}</div></div>`;
  }
  const when = advice.inMonths > 0 ? inMonths(advice.inMonths) : 'at the next session';
  return `<div class="advice" data-adviser="${esc(advice.adviserId)}">
    <div class="advice-head">${icon('quill')}<div><b>${esc(advice.name)} will ${esc(advice.verb)}.</b><small>It stands ${esc(when)} unless you change it.</small></div></div>
    ${why ? `<ul>${why}</ul>` : ''}
    <div class="advice-actions">
      <button type="button" class="btn btn-secondary" data-advice="stand">${icon('check')}Let it stand</button>
      <button type="button" class="btn btn-ghost" data-advice="change" aria-expanded="false">Change answer</button>
    </div>
    <p class="advice-change" hidden>Choose another answer below. Your choice stands; it counts as overruling ${esc(advice.name.split(' ')[0])}.</p>
  </div>`;
}

// Wire a card's banner: Let it stand applies now; Change opens the answers.
export function bindAdvice(el, ctx, cardOf) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-advice]');
    if (!b) return;
    e.stopPropagation();
    const card = cardOf();
    if (b.dataset.advice === 'stand') return ctx.onAdviser?.('letStand', card.id);
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    el.classList.toggle('is-changing', open);
    const note = el.querySelector('.advice-change');
    if (note) note.hidden = !open;
    if (open) el.querySelector('.options .option, .bud-trim')?.focus?.();
  });
}

function scales(beliefs) {
  return `<div class="adv-scales">${AXES.map(([k, left, right]) => {
    const v = Math.max(-1, Math.min(1, beliefs[k] ?? 0));
    return `<div class="lean" role="img" aria-label="${esc(`${left} or ${right}: ${Math.abs(v) < 0.1 ? 'balanced' : `leans to ${(v > 0 ? right : left).toLowerCase()}`}`)}">
      <span class="${v < -0.1 ? 'on' : ''}">${esc(left)}</span><span class="lean-track"><i class="mid"></i><i class="dot" style="left:${((v + 1) / 2 * 100).toFixed(1)}%"></i></span><span class="${v > 0.1 ? 'on' : ''}">${esc(right)}</span></div>`;
  }).join('')}</div>`;
}

function person(p, {chips = true} = {}) {
  return `<div class="adv-who"><span class="avatar">${esc(p.name.split(' ').map((w) => w[0]).join('').slice(0, 2))}</span><div><h4>${esc(p.name)}</h4><p>${esc(p.background)}</p></div></div>
    ${chips ? `<div class="chips adv-chips">${p.chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}`;
}

export function createAdvisersView(ctx) {
  const el = h('div.adv-view');
  let data = null, sig = '', area = null;

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'hire') ctx.onAdviser?.('hireAdviser', t.dataset.cand, area ?? data?.slate?.areas?.[0]?.id);
    else if (act === 'area') { area = t.dataset.area; sig = ''; render(); }
    else if (act === 'mode') ctx.onAdviser?.('setAdviserMode', t.dataset.seat, t.dataset.mode);
    else if (act === 'redraw') ctx.onAdviser?.('redrawSlate');
    else if (act === 'dismiss') ctx.dismissAdviser?.(data.seats.flatMap((s) => (s.adviser ? [s.adviser] : [])).find((x) => x.id === t.dataset.adviser));
    else if (act === 'card') ctx.focusCard?.(t.dataset.card);
  });

  function adviserCard(seat) {
    const a = seat.adviser;
    const modes = (data.modes ?? ['advise', 'routine', 'all']).map((m) => `<button type="button" data-act="mode" data-seat="${esc(seat.id)}" data-mode="${m}" aria-pressed="${seat.mode === m}">${esc(MODE_LABEL[m])}</button>`).join('');
    const recent = a.recent.length ? `<ul class="adv-recent">${a.recent.map((r) => `<li class="${r.changed ? 'is-changed' : ''}">${icon(r.changed ? 'quill' : 'check')}<span>${esc(r.title)}</span><small>${r.changed ? 'you changed it' : esc(r.choice ?? '')}</small></li>`).join('')}</ul>` : '<p class="adv-none">No answers yet.</p>';
    const waiting = a.waiting.length ? `<div class="section-head"><h3>Waiting for your review</h3><span class="count">${a.waiting.length}</span></div><ul class="adv-waiting">${a.waiting.map((w) => `<li><button type="button" data-act="card" data-card="${esc(w.id)}"><span>${esc(w.title)}</span><small>${esc(w.verb)} · ${esc(inMonths(w.inMonths))}</small></button></li>`).join('')}</ul>` : '';
    return `<article class="adv-card" data-adviser="${esc(a.id)}">
      ${person(a)}
      ${scales(a.beliefs)}
      <div class="adv-stats">
        <div><b>${a.standing}</b><span>standing</span>${a.history.length >= 2 ? sparkline(a.history.map((x) => x.v)) : ''}</div>
        <div><b>${a.answered}</b><span>answered</span></div>
        <div><b>${a.changed}</b><span>you changed (${a.overruled}%)</span></div>
        <div><b>${num(a.salary)}</b><span>a year · since ${a.hiredYear}</span></div>
      </div>
      <div class="adv-mode"><span class="adv-label">What they answer</span><div class="seg adv-seg" role="group" aria-label="What ${esc(a.name)} answers">${modes}</div><p>${esc(MODE_NOTE[seat.mode])}</p></div>
      ${waiting}
      <div class="section-head"><h3>Recent answers</h3></div>${recent}
      <button type="button" class="btn btn-ghost btn-danger adv-dismiss" data-act="dismiss" data-adviser="${esc(a.id)}">${icon('close')}Dismiss ${esc(a.name.split(' ')[0])}</button>
    </article>`;
  }

  function slateHTML(seat) {
    const s = data.slate;
    if (!s || s.seatId !== seat.id) return '<p class="adv-none">A slate of townsfolk will be drawn for this seat.</p>';
    if (!area || !s.areas.some((x) => x.id === area)) area = s.areas[0]?.id ?? null;
    const areas = s.areas.length > 1
      ? `<div class="adv-areas" role="group" aria-label="The seat's area">${s.areas.map((x) => `<button type="button" class="filter" data-act="area" data-area="${x.id}" aria-pressed="${x.id === area}" title="${esc(x.bodies.join(', '))}">${esc(x.name)}</button>`).join('')}</div>
        <p class="adv-bodies">${esc((s.areas.find((x) => x.id === area)?.bodies ?? []).join(', ') || 'No body sits in this area yet.')}</p>` : '';
    return `<p class="adv-pick">Choose an adviser from the townsfolk${s.areas.length > 1 ? ', and the area they answer for' : ''}.</p>${areas}
      <div class="adv-slate">${s.candidates.map((c) => `<article class="adv-card is-candidate">
        ${person(c)}${scales(c.beliefs)}
        <p class="adv-salary">${num(c.salary)} coin a year</p>
        <button type="button" class="btn btn-primary" data-act="hire" data-cand="${esc(c.id)}">Hire ${esc(c.name.split(' ')[0])}</button>
      </article>`).join('')}</div>
      ${s.canRedraw ? '<button type="button" class="btn btn-ghost adv-redraw" data-act="redraw">See others</button>' : '<p class="adv-none">You can ask for others again next year.</p>'}`;
  }

  function render() {
    if (!data) return;
    const next = JSON.stringify([data, area]);
    if (next === sig) return;
    sig = next;
    el.innerHTML = data.seats.map((seat) => `<section class="adv-seat" data-seat="${esc(seat.id)}">
      <div class="section-head"><h3>${esc(seat.areaName ?? 'An open seat')}</h3>${seat.bodies.length ? `<span class="aside">${esc(seat.bodies.map((b) => b.name).join(', '))}</span>` : ''}</div>
      ${seat.adviser ? adviserCard(seat) : slateHTML(seat)}
    </section>`).join('') + (data.next ? `<p class="adv-next">${esc(data.next)}</p>` : '') +
      (data.gone?.length ? `<p class="adv-next">${data.gone.map((g) => esc(`${g.name}: ${g.why} in year ${g.year}.`)).join(' ')}</p>` : '');
  }

  return {
    el,
    update(next) {
      data = next;
      el.hidden = !next;
      render();
    },
  };
}
