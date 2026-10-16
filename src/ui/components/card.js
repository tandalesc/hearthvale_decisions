// Proposal card (design-visual §8.3). Faction reaction chips show before the
// choice, so the player can weigh who gains and who loses. Debate strips show
// who is for and against, and how sure they are.
import {esc, h, setText, toggleClass} from '../dom.js';
import {icon} from '../icons.js';
import {inMonths, num, theName} from '../format.js';

const KIND_LABEL = {
  proposal: 'A proposal', petition: 'A petition', event: 'Something happened',
  demand: 'A demand', debate: 'A debate', report: 'A report', budget: 'A budget',
};
import {createBudgetCard, budgetNextText} from './budget.js';
import {adviceBanner, bindAdvice} from './advisers.js';
import {isMinorKey} from '../model.js';
import {animate} from '../motion.js';
const AVATAR_TINTS = ['#e3ead3', '#efe2c8', '#d9ebec', '#f3dfd4', '#e6e0ef', '#e9e4cf'];

export function isMinor(option) {
  return isMinorKey(option.key) || /^(not now|refuse)\b/i.test(option.label ?? '');
}

function initials(name = '') {
  return name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).slice(-2).map((w) => w[0]).join('') || '·';
}

function tint(name = '') {
  let hsh = 0;
  for (const c of name) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[hsh % AVATAR_TINTS.length];
}

function reactionChips(reactions, ctx) {
  if (!reactions?.length) return '';
  const chips = reactions
    .filter((r) => r && r.dir)
    .slice(0, 3)
    .map((r) => {
      const strong = Math.abs(r.dir) >= 2;
      const name = r.name ?? ctx.factionName(r.faction);
      const glyph = r.dir > 0 ? (strong ? 'tri-up' : 'tri-up-o') : (strong ? 'tri-down' : 'tri-down-o');
      const how = r.dir > 0 ? (strong ? 'strongly for' : 'for') : (strong ? 'strongly against' : 'against');
      return `<span class="chip ${r.dir > 0 ? 'up' : 'down'}" title="${esc(name)}: ${how}">${icon(glyph)}${esc(name)}</span>`;
    });
  return chips.length ? `<span class="chips">${chips.join('')}</span>` : '';
}

// Town feeling: a rough for / against bar with a one-word verdict, from the
// factions' stances weighted by their size. Tap (or hover) for the factions.
const VERDICT = {popular: 'Popular', divisive: 'Divisive', unpopular: 'Unpopular', indifferent: 'Indifferent', forming: 'Opinion forming…'};
const STANCE_WORD = {for: 'for', against: 'against', split: 'split', indifferent: "don't mind"};
const pc = (x) => Math.round((Number.isFinite(x) ? x : 0) * 100);

function opinionBar(o, cls = '') {
  if (o.verdict === 'forming') return `<span class="op-bar is-empty${cls}" aria-hidden="true"></span>`;
  const f = pc(o.for), a = pc(o.against), n = Math.max(0, 100 - f - a);
  return `<span class="op-bar${cls}" aria-hidden="true"><i class="op-for" style="width:${f}%"></i><i class="op-none" style="width:${n}%"></i><i class="op-against" style="width:${a}%"></i></span>`;
}

function opinionSummary(o) {
  if (o.verdict === 'forming') return 'The factions have not made up their minds yet.';
  return `About ${pc(o.for)} in 100 for, ${pc(o.against)} against, ${Math.max(0, 100 - pc(o.for) - pc(o.against))} don't mind.`;
}

function opinionRow(o, label) {
  const forming = o.verdict === 'forming' || o.pending;
  const word = forming ? VERDICT.forming : (VERDICT[o.verdict] ?? o.word ?? '');
  return `<span class="op-row" data-verdict="${forming ? 'forming' : esc(o.verdict)}" title="${esc(`${label ? `${label}: ` : ''}${opinionSummary(o)}`)}">`
    + `<span class="op-label">${esc(label ?? 'Town')}</span>${opinionBar(o)}<span class="op-verdict">${esc(word)}</span></span>`;
}

function opinionFactions(o, heading) {
  const rows = (o.factions ?? []).map((r) => `<li><span class="op-name">${esc(r.name ?? r.faction)}</span><span class="op-share">${pc(r.share)}%</span>`
    + `${opinionBar(r, ' is-mini')}<span class="op-stance" data-stance="${esc(r.stance)}">${esc(STANCE_WORD[r.stance] ?? r.stance ?? '')}</span></li>`).join('');
  return `${heading ? `<h4>${esc(heading)}</h4>` : ''}${rows ? `<ul>${rows}</ul>` : '<p class="op-note">No faction has spoken yet.</p>'}`;
}

function opinionHTML(op, open) {
  const sides = op.sides?.length ? op.sides : null;
  const rows = sides ? sides.map((s) => opinionRow(s, s.name)).join('') : opinionRow(op);
  const detail = sides ? sides.map((s) => opinionFactions(s, s.name)).join('') : opinionFactions(op);
  return `<button type="button" class="op-head" aria-expanded="${open}" aria-label="What the town thinks. Show the factions."><span class="op-rows">${rows}</span>${icon('chevron-down')}</button>`
    + `<div class="op-detail"${open ? '' : ' hidden'}>${detail}</div>`;
}

function renderOpinion(el, op) {
  const host = el.querySelector('.opinion');
  if (!host) return;
  const sig = JSON.stringify(op ?? null);
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.hidden = !op;
  if (!op) return;
  const open = host.querySelector('.op-head')?.getAttribute('aria-expanded') === 'true';
  host.innerHTML = opinionHTML(op, open);
}

// Build a full card. ctx: {factionName, bodyName, bodyIcon, coin(), unlocks(), onRule(card, option, node)}
export function createCard(card, ctx, {position, total} = {}) {
  if (card.kind === 'budget' && card.budget) return createBudgetCard(card, ctx);
  const el = h('article.card', {'data-kind': card.kind ?? 'proposal', 'aria-labelledby': `t-${card.id}`});
  const report = card.kind === 'report';
  const options = card.options ?? [];
  const major = report ? options : options.filter((o) => !isMinor(o));
  const minor = report ? [] : options.filter(isMinor);
  const fromName = ctx.bodyName(card.from);
  const asker = card.asker;
  const counter = total > 1 ? ` · ${position} of ${total}` : '';

  el.innerHTML = `
    <div class="card-eyebrow">
      <span class="eyebrow">${KIND_LABEL[card.kind] ?? 'A proposal'}${counter}</span>
      <span class="card-from">${icon(ctx.bodyIcon(card.from))}<span>${esc(fromName)}</span>${card.urgency >= 2 ? ' · <span class="urgent">urgent</span>' : ''}</span>
    </div>
    <h3 class="card-title" id="t-${esc(card.id)}">${esc(card.title)}</h3>
    <p class="card-why"${card.prose?.why || card.why ? '' : ' hidden'}>${esc(card.prose?.why ?? card.why ?? '')}</p>
    ${asker?.name ? `<div class="asker"><span class="avatar" style="--avatar:${tint(asker.name)}">${esc(initials(asker.name))}</span><span>Asked by <b>${esc(asker.name)}</b>${asker.role ? `, ${esc(asker.role)}` : ''}</span></div>` : ''}
    ${card.costLine ? `<div class="cost-line">${icon('coin')}<span>${esc(card.costLine)}</span></div>` : ''}
    ${card.note ? `<p class="card-note">${esc(card.note)}</p>` : ''}
    <div class="opinion" hidden></div>
    <div class="advice-host"></div>
    <div class="options"></div>
    <p class="card-note stuck" hidden>The chest cannot pay for any choice here. If you wait, ${esc(theName(fromName))} will act in its own way when this runs out.</p>
    ${minor.length ? '<div class="minor-options"></div>' : ''}
    <div class="card-foot">
      ${card.details?.length ? `<button class="link-btn details-btn" aria-expanded="false">Ask for details ${icon('chevron-down')}</button>` : ''}
      ${card.place ? `<button class="link-btn place-btn">${icon('locate')}Show me</button>` : ''}
      ${card.category && ctx.openRuleBook && ctx.unlocks().ruleBook ? `<button class="link-btn rules-btn" title="Open the Rule Book at this area">${icon('rules')}The rules</button>` : ''}
      <span class="expiry">${icon('clock')}<span class="expiry-text"></span></span>
    </div>
    ${card.details?.length ? `<dl class="details" hidden>${card.details.slice(0, 4).map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd>`).join('')}</dl>` : ''}`;

  const optHost = el.querySelector('.options');
  major.forEach((o, i) => {
    const btn = h('button.option', {type: 'button', 'data-option': o.key});
    if (i === 0) btn.classList.add('is-primary');
    btn.innerHTML = `<span class="opt-label">${esc(o.label)}</span><span class="opt-go">${icon('arrow-right')}</span><span class="opt-trade"${proseFor(card, o) ? '' : ' hidden'}>${esc(proseFor(card, o))}</span><span class="afford" hidden></span>${reactionChips(o.reactions, ctx)}`;
    btn.addEventListener('click', () => ctx.onRule(card, o, el));
    optHost.append(btn);
  });
  const minorHost = el.querySelector('.minor-options');
  for (const o of minor) {
    const refuse = /refuse|reject/i.test(o.key + o.label);
    const btn = h('button.minor', {type: 'button', 'data-option': o.key, class: refuse ? 'is-refuse' : null});
    btn.innerHTML = `<b>${esc(o.label)}</b><small class="opt-trade"${proseFor(card, o) ? '' : ' hidden'}>${esc(proseFor(card, o))}</small>`;
    btn.addEventListener('click', () => ctx.onRule(card, o, el));
    minorHost.append(btn);
  }

  el.querySelector('.opinion').addEventListener('click', (e) => {
    const head = e.target.closest('.op-head');
    if (!head) return;
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', String(open));
    el.querySelector('.op-detail').hidden = !open;
  });
  el.querySelector('.place-btn')?.addEventListener('click', () => ctx.focusWorld?.(card.place));
  el.querySelector('.rules-btn')?.addEventListener('click', () => ctx.openRuleBook(card.category));
  const detailsBtn = el.querySelector('.details-btn');
  detailsBtn?.addEventListener('click', () => {
    const dl = el.querySelector('.details');
    const open = dl.hidden;
    dl.hidden = !open;
    detailsBtn.setAttribute('aria-expanded', String(open));
  });

  // Prose from the narrator may arrive later. Swap it in with a soft
  // cross-fade, but never under a player who is already reading the card.
  let touched = false, latest = card, proseSig = sigOf(card);
  const touch = () => { touched = true; };
  el.addEventListener('pointerdown', touch);
  el.addEventListener('pointerenter', touch);
  el.addEventListener('focusin', touch);
  el.addEventListener('wheel', touch, {passive: true});
  el.addEventListener('touchmove', touch, {passive: true});
  const applyProse = (next, fade) => {
    proseSig = sigOf(next);
    const why = el.querySelector('.card-why');
    const text = next.prose?.why ?? next.why ?? '';
    const trades = [...el.querySelectorAll('[data-option] .opt-trade')];
    const changes = [[why, text], ...trades.map((t) => {
      const o = options.find((x) => x.key === t.closest('[data-option]').dataset.option);
      return [t, proseFor(next, o ?? {})];
    })].filter(([node, value]) => node && node.textContent !== value);
    for (const [node, value] of changes) {
      node.textContent = value;
      node.hidden = !value;
      if (fade) animate(node, [{opacity: 0}, {opacity: 1}], {duration: 400});
    }
  };
  bindAdvice(el, ctx, () => latest);
  el.__update = (next) => {
    latest = next ?? latest;
    if (sigOf(latest) !== proseSig && !touched) applyProse(latest, true);
    updateCard(el, latest, major, ctx);
    // An adviser's staged answer (Let it stand / Change), or what they would do.
    const host = el.querySelector('.advice-host');
    const asig = JSON.stringify(latest.advice ?? null);
    if (host.dataset.sig !== asig) {
      host.dataset.sig = asig;
      host.innerHTML = adviceBanner(latest.advice);
      el.classList.toggle('is-advised', !!latest.advice?.act);
      el.classList.remove('is-changing');
    }
  };
  // Called when the card is shown again: pending prose lands now.
  el.__reopen = () => {
    touched = false;
    if (sigOf(latest) !== proseSig) applyProse(latest, false);
  };
  el.__update(card);
  return el;
}

function proseFor(card, option) {
  return card.prose?.options?.[option.key] ?? option.tradeoff ?? '';
}

function sigOf(card) {
  return JSON.stringify(card.prose ?? null);
}

function updateCard(el, card, major, ctx) {
  renderOpinion(el, card.opinion ?? null);
  const open = major.some((o) => o.affordable !== false) || el.querySelector('.minor');
  el.querySelector('.stuck').hidden = Boolean(open);
  const months = card.expiresInMonths;
  const text = el.querySelector('.expiry-text');
  if (Number.isFinite(months)) {
    const verb = card.kind === 'report' ? 'Fades' : card.kind === 'event' ? 'Settles itself' : 'Expires';
    setText(text, `${verb} ${inMonths(months)}`);
  }
  toggleClass(el.querySelector('.expiry'), 'is-soon', months <= 3);
  const coin = ctx.coin();
  el.querySelectorAll('.option').forEach((btn, i) => {
    if (!major[i]) return;
    const o = major[i];
    const warn = btn.querySelector('.afford');
    const short = o?.affordable === false || (Number.isFinite(o?.cost) && o.cost > 0 && Number.isFinite(coin) && o.cost > coin);
    warn.hidden = !short;
    if (short) setText(warn, `Costs ${num(o.cost)}. We have ${num(Math.max(0, coin))}.`);
    // The sim says outright when the chest cannot pay; then the choice is closed.
    btn.disabled = o?.affordable === false;
  });
}

// A collapsed card in a desktop stack: title and body, tap to bring forward.
export function createNextCard(card, ctx, onPick) {
  const el = h('button.card.is-next', {type: 'button', 'data-kind': card.kind ?? 'proposal'});
  const text = card.kind === 'budget' ? budgetNextText(card, ctx) : {from: `${ctx.bodyName(card.from)}${card.urgency >= 2 ? ' · urgent' : ''}`, title: card.title};
  el.innerHTML = `<span class="next-text"><span class="next-from">${esc(text.from)}</span><span class="next-title">${esc(text.title)}</span></span>${icon('chevron-right')}`;
  el.addEventListener('click', () => onPick(card.id));
  return el;
}
