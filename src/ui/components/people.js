// People: the town in numbers, how many approve of your rule (from Borough),
// and the groups (factions) with their moods.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {moodWord, num, pct, plural, signed} from '../format.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {compassSection} from './late-surfaces.js';
import {historyChart} from './sparkline.js';

export function createPeople(ctx) {
  const el = h('div.view.people');
  const head = h('header.view-head');
  head.innerHTML = `<span class="seal-icon">${icon('people')}</span><div><h2>People</h2><p class="sub">Who lives here, and how they feel.</p></div>`;
  const sum = h('div.town-sum');
  const list = h('section.section');
  el.append(head);
  const note = explainer(ctx, 'people', EXPLAINERS.people);
  if (note) el.append(note);
  const approval = approvalSection(ctx);
  const compass = compassSection();
  el.append(sum, approval.el, compass.el, list);
  let sig = '';

  return {
    el,
    update(top, factions = [], {compass: data, show, approval: ap = null, showApproval = false} = {}) {
      compass.update(data, show);
      approval.update(ap, showApproval);
      sum.innerHTML = `<div><b>${num(top.people)}</b><span>people</span></div>${Number.isFinite(top.homes) ? `<div><b>${num(top.homes)}</b><span>homes</span></div>` : `<div><b>${num(top.food)}</b><span>food</span></div>`}<div><b>${pct(top.wellbeing)}</b><span>wellbeing</span></div>`;
      const sorted = [...factions].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      const next = `${showApproval}|` + sorted.map((f) => `${f.id}${(f.mood ?? 0).toFixed(2)}${(f.trend ?? 0).toFixed(2)}${f.approval ?? ''}`).join('|');
      if (next === sig) return;
      sig = next;
      const total = sorted.reduce((n, f) => n + (f.size ?? 0), 0) || 1;
      const max = Math.max(0.01, ...sorted.map((f) => f.size ?? 0));
      list.innerHTML = `<div class="section-head"><h3>Groups in town</h3><span class="count">${sorted.length}</span></div>` + sorted.map((f) => {
        const good = f.mood >= 0.58, bad = f.mood < 0.42;
        const arrow = f.trend > 0.01 ? 'tri-up' : f.trend < -0.01 ? 'tri-down' : 'flat';
        const ap = showApproval && Number.isFinite(f.approval)
          ? ` <span class="faction-approval ${approvalTone(f.approval)}" title="${f.approval}% approve of your rule">${f.approval}%</span>` : '';
        return `<div class="faction" data-faction="${esc(f.id)}">
          <span class="faction-name">${esc(f.name)}${f.parentName ? ` <small class="faction-parent">of the ${esc(f.parentName.toLowerCase())}</small>` : ''}${f.split ? ' <span class="chip gold">Split</span>' : ''}</span>
          <span class="faction-mood ${good ? 'good' : bad ? 'bad' : ''}">${icon(arrow)}${moodWord(f.mood)}${ap}</span>
          ${f.wants ? `<p>${esc(f.wants)}</p>` : ''}
          <div class="share"><span>${pct((f.size ?? 0) / total)} of town</span><span class="bar"><i style="width:${Math.round(((f.size ?? 0) / max) * 100)}%"></i></span></div>
        </div>`;
      }).join('');
    },
    // Bring the Approval section into view (the top bar's metric opens it).
    showApproval() {
      if (approval.el.hidden) return false;
      // Scroll the panel it sits in (the drawer, or the phone sheet), never the page.
      const box = approval.el.closest('.panel-body') ?? el.parentElement;
      if (!box) return false;
      // Clear a head that floats over the panel's top (the drawer's close button).
      const head = box.parentElement?.querySelector(':scope > .panel-head');
      const boxTop = box.getBoundingClientRect().top;
      const cover = head && getComputedStyle(head).position === 'absolute' ? Math.max(0, head.getBoundingClientRect().bottom - boxTop) : 0;
      const top = approval.el.getBoundingClientRect().top - boxTop + box.scrollTop - 8 - cover;
      box.scrollTo({top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
      return true;
    },
  };
}

const approvalTone = (v) => (v >= 58 ? 'good' : v < 42 ? 'bad' : '');

// Approval (src/sim/view.js selectApproval): the figure and its change, the
// years so far, who approves by group, wealth, district, place, age and faith,
// and why it moved this year.
function approvalSection(ctx) {
  const el = h('section.section.approval', {hidden: true, id: 'people-approval', 'aria-labelledby': 'approval-title'});
  let tab = ctx.prefs?.get?.('approvalTab') ?? 'faction';
  let data = null, sig = '';

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ap-tab]');
    if (!b) return;
    tab = b.dataset.apTab;
    try { ctx.prefs?.set?.('approvalTab', tab); } catch { /* prefs unavailable */ }
    sig = '';
    render();
  });

  function render() {
    const a = data;
    const next = JSON.stringify([a, tab]);
    if (next === sig) return;
    sig = next;
    const tabs = a.tabs ?? [];
    const current = tabs.find((t) => t.id === tab) ?? tabs[0];
    const d = a.change;
    const moved = Number.isFinite(d) && d !== 0;
    const change = Number.isFinite(d)
      ? `<span class="chip ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${icon(d > 0 ? 'tri-up' : d < 0 ? 'tri-down' : 'flat')}${moved ? `${signed(d)} this year` : 'No change'}</span>`
      : '';
    const why = (a.drivers ?? []);
    el.innerHTML = `<div class="section-head"><h3 id="approval-title">Approval</h3>${Number.isFinite(a.year) ? `<span class="aside">year ${a.year}</span>` : ''}</div>
      <div class="ap-figure">
        <b class="ap-value ${approvalTone(a.value)}">${a.value}%</b>
        <div class="ap-figure-text"><span>approve of how you rule</span>${change}</div>
      </div>
      ${a.strongAgainst > 0 ? `<p class="ap-against">${a.strongAgainst}% are strongly against you.</p>` : ''}
      ${a.history?.length >= 2 ? historyChart(a.history) : '<p class="ap-empty">The chart fills in as the years pass.</p>'}
      <div class="ap-why">
        <h4>Why it moved</h4>
        ${why.length ? `<ul>${why.map((w) => `<li class="${w.points > 0 ? 'up' : 'down'}"><span class="ap-pts">${signed(w.points)}</span><span>${esc(w.text)}</span></li>`).join('')}</ul>`
          : `<p class="ap-empty">${Number.isFinite(a.change) ? 'Nothing much changed people\'s minds this year.' : 'Ask again after a year: there is nothing yet to compare.'}</p>`}
      </div>
      ${tabs.length ? `<div class="filter-row ap-tabs" role="toolbar" aria-label="Approval by">${tabs.map((t) => `<button class="filter" type="button" data-ap-tab="${esc(t.id)}" aria-pressed="${t.id === current.id}">${esc(t.label)}</button>`).join('')}</div>
      <div class="ap-rows">${current.rows.map((r) => `<div class="ap-row">
          <span class="ap-name">${esc(r.name)}</span>
          <span class="ap-bar" role="img" aria-label="${esc(`${r.name}: ${r.value}% approve`)}"><i class="${approvalTone(r.value)}" style="width:${Math.max(0, Math.min(100, r.value))}%"></i><b></b></span>
          <span class="ap-num">${r.value}%</span>
          <span class="ap-share">${pct(r.share)} of town</span>
        </div>`).join('')}</div>
      ${current.more ? `<p class="ap-more">The ${current.rows.length} largest of ${current.rows.length + current.more} ${plural(current.rows.length + current.more, current.label.toLowerCase().replace(/s$/, ''), current.label.toLowerCase())}.</p>` : ''}` : ''}`;
  }

  return {
    el,
    update(a, show) {
      el.hidden = !show || !a || !Number.isFinite(a.value);
      if (el.hidden) return;
      data = a;
      render();
    },
  };
}
