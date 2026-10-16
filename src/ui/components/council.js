// The Council: one panel for every body that brings you requests. Down its
// left side, the Town Council (every request in town) and each body with
// its count; in the middle, the chosen page's cards (one open card, the rest
// folded beneath it; one card at a time with a pager on phones), with area
// filters above them; beside them, the rules in force in the open card's
// area and the body's own page: its dashboard, purse and rules.
// (How the factions feel lives in the People view.)
// In budget season (months 9-11) a "Budget season" page joins the list after
// the Town Council: the bodies' budget cards, and the season beside them.
// From the advisers' unlock an "Advisers" page follows: the bench (seats,
// advisers, the slate) and the cards they will answer, for your review.
//
// Desk and tablet: a HUD panel over the main area, between the left rail
// and the dock, above the time strip. It is not a dialog: the top bar and
// time strip stay in reach and the town keeps its own pace unless the
// player chose to pause while ruling. Phone: the sheet's Council tab, with
// the bodies as a strip of chips.
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {num} from '../format.js';
import {animate} from '../motion.js';
import {explainer, EXPLAINERS} from './explainer.js';
import {createDocket} from './docket.js';
import {pips} from './body-view.js';
import {seasonSummary, seasonStrip} from './budget.js';
import {createAdvisersView} from './advisers.js';

const TOWN = 'moot';
const BUDGETS = 'budgets';
const ADVISERS = 'advisers';
const waiting = (cards) => cards.filter((c) => c.kind !== 'report').length;

// ctx adds: bodyView(id) → the body's page view; onOpen(), onClose().
export function createCouncil(ctx) {
  const el = h('section.dk.paper', {'aria-labelledby': 'dk-title', id: 'council'});
  el.innerHTML = `
    <header class="dk-head">
      <span class="seal-icon"></span>
      <div class="dk-title"><h2 id="dk-title">Town Council</h2><p class="sub" id="dk-sub"></p></div>
      <button class="icon-btn dk-close" type="button" aria-label="Close the Council" title="Close (Esc)">${icon('close')}</button>
    </header>
    <div class="dk-main">
      <nav class="dk-index" aria-label="Bodies"></nav>
      <div class="dk-cards" tabindex="-1">
        <div class="dk-note"></div>
        <div class="filter-row dk-areas" role="toolbar" aria-label="Show requests about one area" hidden></div>
        <div class="dk-advisers" hidden></div>
        <div class="section-head dk-cards-head"><h3></h3><span class="count"></span></div>
        <div class="dk-strip"></div>
      </div>
      <aside class="dk-side" aria-label="Rules and the body's page">
        <section class="dk-section dk-rules">
          <div class="section-head"><h3></h3><span class="count"></span></div>
          <div class="dk-rule-list"></div>
          <button type="button" class="link-btn dk-to-book" hidden>${icon('rules')}Open the Rule Book</button>
        </section>
        <div class="dk-page"></div>
        <div class="dk-season"></div>
        <section class="dk-section dk-adv-side" hidden>
          <div class="section-head"><h3>How advisers answer</h3></div>
          <p>An adviser answers the requests of the bodies in its area by what it believes. Each answer waits a season (a month for a blunt one): let it stand, or change it. Changing it counts against them; overruled often, they may resign.</p>
          <p>Advise only: they say what they would do. Routine: plans, budgets and reports. All: rules, demands and debates in their area too. Events and new bodies always come to you.</p>
        </section>
        <p class="dk-side-empty" hidden>Rules and the bodies' dashboards gather here as the town grows.</p>
      </aside>
    </div>`;
  const $ = (s) => el.querySelector(s);
  // The cards' "The rules" link shows the rules of the card's area beside it.
  const docket = createDocket({...ctx, openRuleBook: (cat) => showRules(cat)}, {empty: ['Nothing waits here.', 'New requests come each season.']});
  $('.dk-cards').append(docket.el);
  const note = explainer(ctx, 'council', EXPLAINERS.council);
  if (note) $('.dk-note').append(note);
  // The budget season's summary (side column) and its one-line strip (phones).
  const season = seasonSummary({...ctx, focusCard: (id) => { docket.focus(id); }});
  const strip = seasonStrip(ctx);
  $('.dk-season').append(season.el);
  $('.dk-strip').append(strip.el);
  const bench = createAdvisersView({...ctx, focusCard: (id) => { docket.focus(id); }});
  $('.dk-advisers').append(bench.el);

  // page: the body shown (TOWN is every request); area: a category filter.
  // rulesFor: an area asked for by a card's link; bookCat: the area shown.
  let open = false, page = TOWN, area = 'all', rulesFor = null, bookCat = null, data = null;
  let indexSig = '', areaSig = '', rulesSig = '', headSig = '';

  // ---------- events ----------
  $('.dk-close').addEventListener('click', () => close());
  $('.dk-index').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (b) setPage(b.dataset.page);
  });
  $('.dk-areas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-area]');
    if (!b || b.dataset.area === area) return;
    area = b.dataset.area;
    rulesFor = null;
    areaSig = '';
    docket.reset();
    render();
    ctx.sound?.('tick');
  });
  $('.dk-to-book').addEventListener('click', () => ctx.openRuleBook?.(bookCat));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open || ctx.root.dataset.layout === 'phone') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });

  function setPage(id, {quiet} = {}) {
    if (id === page) return;
    page = id;
    area = 'all';
    rulesFor = null;
    indexSig = areaSig = headSig = '';
    docket.reset();
    $('.dk-page').replaceChildren();
    render();
    $('.dk-cards').scrollTop = 0;
    $('.dk-side').scrollTop = 0;
    $('.dk-main').scrollTop = 0;
    if (!quiet) ctx.sound?.('tick');
    ctx.onPage?.(id);
  }

  function showRules(cat) {
    // No side column yet (the narrow card): the Rule Book drawer at that area.
    if (!full) return ctx.openRuleBook?.(cat);
    rulesFor = cat ?? null;
    rulesSig = '';
    renderRules();
    $('.dk-rules').scrollIntoView?.({block: 'nearest'});
  }

  // ---------- rendering ----------
  function catName(id) {
    return data?.cats?.find((c) => c.id === id)?.name ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Other');
  }

  const body = () => data?.bodies?.find((b) => b.id === page) ?? null;
  // The page's cards: every request on the Town Council (budgets have their
  // own page), the budgets in season, else what the body asks or joins.
  function pageCards() {
    const cards = data?.cards ?? [];
    if (page === TOWN) return cards.filter((c) => c.kind !== 'budget');
    if (page === BUDGETS) return cards.filter((c) => c.kind === 'budget');
    if (page === ADVISERS) return cards.filter((c) => c.advice?.act);
    return cards.filter((c) => c.from === page || c.sides?.includes(page));
  }
  const inSeason = () => (data?.cards ?? []).some((c) => c.kind === 'budget');
  function shown() {
    const cards = pageCards();
    return area === 'all' ? cards : cards.filter((c) => c.category === area);
  }

  function render() {
    if (!data) return;
    // A body that is gone (or a season that is over) takes the page back to the Town Council.
    if (page === BUDGETS ? !inSeason() && !data.season : page === ADVISERS ? !data.advisers : page !== TOWN && !body()) return setPage(TOWN, {quiet: true});
    renderIndex();
    renderHead();
    renderAreas();
    const cards = shown();
    const b = body();
    setText($('.dk-cards-head h3'), page === BUDGETS ? 'Budgets to answer' : page === ADVISERS ? 'Waiting for your review' : area !== 'all' ? `About ${catName(area).toLowerCase()}` : 'Needs your ruling');
    setText($('.dk-cards-head .count'), cards.length ? String(cards.length) : '');
    docket.update(cards, {phone: data.phone});
    renderRules();
    const view = b ? ctx.bodyView(page) : null;
    if (view && $('.dk-page').firstChild !== view.el) $('.dk-page').replaceChildren(view.el);
    $('.dk-page').hidden = !view;
    // The season: beside the cards on its own page, and as a strip over them on phones.
    season.update(page === BUDGETS ? data.season : null);
    $('.dk-season').hidden = page !== BUDGETS || !data.season;
    strip.update(data.season, page === BUDGETS && data.phone);
    // The bench, over the cards its advisers will answer.
    $('.dk-advisers').hidden = page !== ADVISERS;
    $('.dk-adv-side').hidden = page !== ADVISERS;
    if (page === ADVISERS) bench.update(data.advisers);
    fit();
  }

  // Which columns have anything to show: the bodies list once there is a
  // second body, the side once a section in it is visible. Empty columns are
  // hidden and the panel sizes to what is left (components.css), so an early
  // town's Council is a modest card that grows with the town.
  // The full layout (bodies list and side column) comes with progress, not
  // with whatever is on screen, and stays once it has come: the Rule Book
  // open with a rule in force, People open, or a second body. Before that the
  // Council is a narrow card of requests.
  let full = false;
  function fit() {
    const page = $('.dk-page');
    const pageHas = (!page.hidden && [...page.querySelectorAll('.body-view > section')].some((sec) => !sec.hidden && sec.childElementCount)) || !$('.dk-season').hidden || !$('.dk-adv-side').hidden;
    const rulesInForce = (data?.cats ?? []).some((c) => c.policies?.length);
    full ||= (Boolean(data?.unlockedRules) && rulesInForce) || Boolean(data?.unlocks?.people) || (data?.bodies ?? []).some((x) => x.id !== TOWN);
    el.classList.toggle('has-index', full);
    el.classList.toggle('has-side', full);
    // Nothing for the side yet (People open before the Rule Book): a quiet line, not bare paper.
    $('.dk-side-empty').hidden = !full || !$('.dk-rules').hidden || pageHas;
  }

  function renderHead() {
    const b = body();
    const all = pageCards();
    const asks = waiting(all), reports = all.length - asks;
    const s = data.season;
    const adv = data.advisers;
    const sig = `${page}|${b?.name}|${b?.founded}|${b?.status}|${asks}|${reports}|${page === BUDGETS ? `${s?.answered}/${s?.total}` : ''}|${page === ADVISERS ? `${adv?.staged}/${adv?.seats?.filter((x) => x.adviser).length}` : ''}`;
    if (sig === headSig) return;
    headSig = sig;
    $('.dk-head .seal-icon').innerHTML = icon(page === BUDGETS ? 'coin' : page === ADVISERS ? 'quill' : ctx.bodyIcon(page));
    if (page === ADVISERS) {
      const filled = adv?.seats?.filter((x) => x.adviser).length ?? 0, seats = adv?.seats?.length ?? 0;
      setText($('#dk-title'), 'Advisers');
      $('#dk-sub').innerHTML = esc(`${filled} of ${seats} ${seats === 1 ? 'seat' : 'seats'} filled.${adv?.staged ? ` ${adv.staged} ${adv.staged === 1 ? 'answer waits' : 'answers wait'} for your review.` : ''}`);
      return;
    }
    if (page === BUDGETS) {
      setText($('#dk-title'), `Budget season${s ? ` · year ${s.year}` : ''}`);
      $('#dk-sub').innerHTML = esc(s ? `${s.answered} of ${s.total} answered. Unanswered budgets keep last year's figure when the year turns.` : '');
      return;
    }
    setText($('#dk-title'), page === TOWN ? 'Town Council' : b?.name ?? '');
    const counts = asks
      ? `${asks} ${asks === 1 ? 'request waits' : 'requests wait'} for your ruling.${reports ? ` ${reports} ${reports === 1 ? 'report' : 'reports'} to read.` : ''}`
      : reports ? `${reports} ${reports === 1 ? 'report' : 'reports'} to read.` : 'Nothing waits for you just now.';
    const since = page === TOWN ? 'Speaks for the whole town.' : Number.isFinite(b?.founded) ? `Sits since year ${b.founded}.` : '';
    const chips = [];
    if (b?.status === 'waning') chips.push('<span class="chip down">Losing heart</span>');
    if (b?.status === 'petitioning') chips.push('<span class="chip river">Asking to form</span>');
    $('#dk-sub').innerHTML = `${esc(`${since} ${counts}`.trim())}${chips.length ? ` <span class="dk-chips">${chips.join('')}</span>` : ''}`;
  }

  // The Town Council first, then each body, the busy ones (and new ones) first.
  function renderIndex() {
    const cards = (data.cards ?? []).filter((c) => c.kind !== 'budget');
    const budgets = (data.cards ?? []).length - cards.length;
    const counts = new Map();
    for (const c of cards) if (c.kind !== 'report') counts.set(c.from, (counts.get(c.from) ?? 0) + 1);
    const rest = (data.bodies ?? []).filter((b) => b.id !== TOWN);
    const busy = (b) => (counts.get(b.id) ?? 0) > 0 || data.fresh?.has(`body:${b.id}`);
    const order = rest.length > 6 ? [...rest.filter(busy), ...rest.filter((b) => !busy(b))] : rest;
    const sig = `${page}|${waiting(cards)}|${budgets}|${data.advisers?.staged}|${Boolean(data.advisers?.slate)}|${Boolean(data.advisers)}|${order.map((b) => `${b.id}:${b.name}:${counts.get(b.id) ?? 0}:${data.fresh?.has(`body:${b.id}`)}`).join()}`;
    if (sig === indexSig) return;
    indexSig = sig;
    const button = (id, label, short, count, isNew, ic = ctx.bodyIcon(id)) => `<button type="button" class="dk-filter" data-page="${esc(id)}" aria-pressed="${id === page}" title="${esc(label)}">
      ${icon(ic)}<span class="dk-filter-name"><span class="long">${esc(label)}</span><span class="short">${esc(short)}</span></span>${count ? `<span class="dk-filter-count">${count}</span>` : ''}${isNew && !count ? '<span class="dot" aria-label="New"></span>' : ''}</button>`;
    $('.dk-index').innerHTML = button(TOWN, 'Town Council', 'Council', waiting(cards))
      + (budgets || page === BUDGETS ? button(BUDGETS, 'Budget season', 'Budgets', budgets, false, 'coin') : '')
      + (data.advisers ? button(ADVISERS, 'Advisers', 'Advisers', data.advisers.staged, Boolean(data.advisers.slate), 'quill') : '')
      + (order.length ? `<h3 class="dk-index-head">Bodies</h3>${order.map((b) => button(b.id, b.name, ctx.shortName?.(b) ?? b.name, counts.get(b.id) ?? 0, data.fresh?.has(`body:${b.id}`))).join('')}` : '');
  }

  // Area chips above the cards, when the page's cards touch two areas or more.
  function renderAreas() {
    const cats = new Map();
    for (const c of pageCards()) if (c.category) cats.set(c.category, (cats.get(c.category) ?? 0) + 1);
    if (area !== 'all' && !cats.has(area)) area = 'all';
    const sig = `${area}|${[...cats].join()}`;
    if (sig === areaSig) return;
    areaSig = sig;
    const row = $('.dk-areas');
    row.hidden = cats.size < 2;
    const sorted = [...cats].sort((a, b) => catName(a[0]).localeCompare(catName(b[0])));
    row.innerHTML = [['all', 'Everything', pageCards().length], ...sorted.map(([c, n]) => [c, catName(c), n])]
      .map(([id, label, n]) => `<button class="filter" data-area="${esc(id)}" aria-pressed="${id === area}">${esc(label)} <span class="dk-filter-count">${n}</span></button>`).join('');
  }

  // Rules in force in the chosen area, or in the open card's area.
  function renderRules() {
    if (page === BUDGETS || page === ADVISERS) {
      $('.dk-rules').hidden = true;
      rulesSig = '';
      return;
    }
    const cat = rulesFor ?? (area !== 'all' ? area : shown().find((c) => c.id === docket.active)?.category ?? shown()[0]?.category ?? null);
    const rules = data.cats?.find((c) => c.id === cat)?.policies ?? [];
    // With no card open, the side still says something: the rules in force
    // overall, newest first, so the column never stands empty.
    const all = cat ? null : (data.cats ?? []).flatMap((c) => c.policies ?? []);
    const sig = `${cat}|${(cat ? rules : all).map((p) => p.id + p.level).join()}|${data.unlockedRules}`;
    if (sig === rulesSig) return;
    rulesSig = sig;
    const section = $('.dk-rules');
    section.hidden = !data.unlockedRules;
    if (section.hidden) return;
    if (!cat) {
      const recent = [...all].sort((a, b) => (b.since ?? 0) - (a.since ?? 0)).slice(0, 4);
      setText(section.querySelector('h3'), 'Rules in force');
      setText(section.querySelector('.count'), all.length ? String(all.length) : '');
      section.querySelector('.dk-rule-list').innerHTML = recent.length
        ? recent.map((p) => `<div class="rule" data-rule="${esc(p.id)}"><div class="rule-top"><span class="rule-title">${esc(p.title)}</span>${pips(p)}</div><p>${esc(p.summary ?? '')}</p></div>`).join('')
        : '<p class="dk-none">No rule stands yet. Rules come through the requests you approve.</p>';
      section.querySelector('.dk-to-book').hidden = false;
      bookCat = null;
      return;
    }
    setText(section.querySelector('h3'), `Rules on ${catName(cat).toLowerCase()}`);
    setText(section.querySelector('.count'), rules.length ? String(rules.length) : '');
    section.querySelector('.dk-rule-list').innerHTML = rules.length
      ? rules.map((p) => `<div class="rule" data-rule="${esc(p.id)}"><div class="rule-top"><span class="rule-title">${esc(p.title)}</span>${pips(p)}</div><p>${esc(p.summary ?? '')}</p>${Number.isFinite(p.upkeep) && p.upkeep > 0 ? `<div class="meta"><span>Upkeep ${num(p.upkeep)} coin a year</span></div>` : ''}</div>`).join('')
      : '<p class="dk-none">No rule stands here yet.</p>';
    section.querySelector('.dk-to-book').hidden = false;
    bookCat = cat;
  }

  // ---------- open and close ----------
  // opts: {page, cardId}; a cardId alone opens the page of the body that asks.
  function show({page: p, cardId} = {}) {
    const card = cardId ? data?.cards?.find((c) => c.id === cardId) : null;
    const want = p ?? (card?.kind === 'budget' && page !== card.from ? BUDGETS : card && page !== TOWN && card.from !== page && !card.sides?.includes(page) ? card.from : null);
    if (want && want !== page) setPage(want, {quiet: true});
    if (card && area !== 'all' && card.category !== area) { area = 'all'; areaSig = ''; docket.reset(); }
    rulesFor = null;
    indexSig = rulesSig = headSig = '';
    if (!open) {
      open = true;
      el.hidden = false;
      ctx.onOpen?.();
      if (ctx.root.dataset.layout !== 'phone') animate(el, [{opacity: 0, transform: 'translateY(8px) scale(.99)'}, {opacity: 1, transform: 'none'}], {duration: 200});
    }
    render();
    if (cardId) {
      docket.focus(cardId);
      renderRules();
    }
  }

  function close() {
    if (!open) return;
    open = false;
    if (ctx.root.dataset.layout !== 'phone') el.hidden = true;
    ctx.onClose?.();
  }

  el.hidden = true;
  return {
    el,
    docket,
    open: show,
    close,
    toggle: (opts) => (open ? close() : show(opts)),
    setPage: (id) => setPage(id),
    // After the body pages are updated (their sections show or hide), re-fit.
    fit: () => fit(),
    get isOpen() { return open; },
    get page() { return page; },
    // {cards, bodies, cats (rules in force by area), phone, unlockedRules, unlocks, fresh, season, advisers}
    update(next) {
      data = next;
      render();
    },
  };
}
