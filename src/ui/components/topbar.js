// Top bar: the town's name and date, and a few numbers that grow with the
// town (three at the start: People, Food, Coin). From Borough, Approval sits
// after Wellbeing; on phones it takes Wellbeing's place (Wellbeing stays in People).
import {esc, h, setAttr, setText, toggleClass} from '../dom.js';
import {icon} from '../icons.js';
import {SEASONS, dateLine, num, pct, seasonOf, short, signed} from '../format.js';

const METRICS = [
  {key: 'people', icon: 'people', label: 'People', unlock: null},
  {key: 'food', icon: 'food', label: 'Food', unlock: null},
  {key: 'coin', icon: 'coin', label: 'Coin', unlock: null},
  {key: 'wellbeing', icon: 'heart', label: 'Wellbeing', unlock: 'people'},
  {key: 'approval', icon: 'hand', label: 'Approval', unlock: 'approval'},
  {key: 'homes', icon: 'homes', label: 'Homes', unlock: 'bodies'},
];

export function createTopbar(ctx) {
  const el = h('header.topbar.paper', {role: 'banner'});
  el.innerHTML = `
    <div class="brand">
      <span class="crest">${icon('crest')}</span>
      <button class="date-chip" type="button" aria-haspopup="dialog" title="Toward the next age"><b class="dc-year"></b><span class="dc-season"></span></button>
      <div class="brand-text"><h1>Hearthvale</h1><div class="date"><span class="when"></span><span class="era-chip"></span><button class="here-chip" type="button" hidden></button></div></div>
    </div>
    <div class="metrics" role="group" aria-label="The town at a glance"></div>
    <div class="topbar-end"><button class="icon-btn settings-btn" aria-label="Settings" title="Settings">${icon('settings')}</button></div>`;
  el.querySelector('.brand h1').textContent = ctx.townName?.() || 'Hearthvale';
  const host = el.querySelector('.metrics');
  const nodes = {};
  for (const m of METRICS) {
    const b = h('button.metric', {type: 'button', 'data-key': m.key, hidden: true});
    b.innerHTML = `${icon(m.icon)}<span><span class="metric-val"></span><span class="metric-cap"></span></span>`;
    b.addEventListener('click', () => ctx.onMetric(m.key));
    host.append(b);
    nodes[m.key] = b;
  }
  el.querySelector('.settings-btn').addEventListener('click', () => ctx.openSettings());
  el.querySelector('.here-chip').addEventListener('click', () => ctx.openPlaces?.());
  // On phones the date sits here (the drawer keeps only the time controls),
  // and its "toward the next age" popover opens downward, clear of the drawer.
  const dateChip = el.querySelector('.date-chip');
  dateChip.addEventListener('click', () => ctx.openEraPopover?.(dateChip, 'below'));
  let ready = false;

  function set(key, value, caption, warn, aria) {
    const b = nodes[key];
    setText(b.querySelector('.metric-val'), value);
    const cap = b.querySelector('.metric-cap');
    if (cap.innerHTML !== caption) cap.innerHTML = caption;
    toggleClass(b, 'is-warn', warn);
    setAttr(b, 'aria-label', aria);
  }

  return {
    el,
    update(top, unlocks, here) {
      // The town's own name, chosen on the main menu; older towns are Hearthvale.
      const name = ctx.townName?.() || 'Hearthvale';
      const h1 = el.querySelector('.brand h1');
      setText(h1, name);
      setAttr(h1, 'title', name);
      setText(el.querySelector('.when'), dateLine(top.year, top.month));
      const dy = el.querySelector('.dc-year');
      if (dy.dataset.y !== String(top.year ?? 0)) {
        dy.dataset.y = String(top.year ?? 0);
        dy.innerHTML = `<span class="dc-yr">Yr </span>${top.year ?? 0}`;
      }
      setText(el.querySelector('.dc-season'), SEASONS[seasonOf(top.month ?? 0)] ?? '');
      setAttr(dateChip, 'aria-label', `${dateLine(top.year, top.month)}, ${top.eraName ?? ''}. Toward the next age`);
      // With several centres the numbers are the region's; the chip says
      // which place the camera is over.
      const chip = el.querySelector('.here-chip');
      chip.hidden = !here;
      if (here && chip.__t !== here.id) {
        chip.__t = here.id;
        chip.innerHTML = `${icon('locate')}<span>${esc(here.name)}</span>`;
        chip.setAttribute('aria-label', `Over ${here.name}. Open Places`);
      }
      setText(el.querySelector('.era-chip'), top.eraName ?? '');
      for (const m of METRICS) {
        const on = (!m.unlock || unlocks[m.unlock]) && (m.key !== 'homes' || Number.isFinite(top.homes)) && (m.key !== 'approval' || Number.isFinite(top.approval));
        const b = nodes[m.key];
        if (on && b.hidden) {
          b.hidden = false;
          if (ready) b.classList.add('is-new');
        } else if (!on) b.hidden = true;
      }
      ready = true;
      toggleClass(host, 'has-approval', !nodes.approval.hidden);
      const fm = top.foodMonths;
      set('people', short(top.people), 'people', false, `${num(top.people)} people`);
      set('food', short(top.food), Number.isFinite(fm) ? `${fm < 1 ? 'under a month' : `${Math.round(fm)} months`} stored` : 'stored', fm < 2, `${num(top.food)} food, about ${Math.round(fm ?? 0)} months`);
      const t = top.coinTrend;
      const trend = Number.isFinite(t) && Math.abs(t) >= 1 ? `<span class="${t > 0 ? 'up' : 'down'}">${signed(t)}</span> a year` : 'in the chest';
      set('coin', short(top.coin), trend, top.coin < 0, `${num(top.coin)} coin`);
      set('wellbeing', pct(top.wellbeing), 'wellbeing', top.wellbeing < 0.4, `Wellbeing ${pct(top.wellbeing)}`);
      if (Number.isFinite(top.approval)) {
        const d = top.approvalChange;
        const moved = Number.isFinite(d) && d !== 0;
        set('approval', `${top.approval}%`, moved ? `<span class="${d > 0 ? 'up' : 'down'}">${signed(d)}</span> this year` : 'approve',
          top.approval < 40, `Approval ${top.approval}%${moved ? `, ${d > 0 ? 'up' : 'down'} ${Math.abs(d)} this year` : ''}. Open People`);
      }
      const waiting = Number.isFinite(top.homesWaiting) && top.homesWaiting > 0 ? top.homesWaiting : 0;
      set('homes', Number.isFinite(top.homes) ? short(top.homes) : '–', waiting ? `<span class="down">${num(waiting)} waiting</span>` : 'homes', waiting > 0 && waiting > (top.homes ?? 0) * 0.1, `${num(top.homes)} homes${waiting ? `, ${num(waiting)} families waiting` : ''}`);
    },
  };
}
