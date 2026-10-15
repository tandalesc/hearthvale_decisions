// Proposal card (design-visual §8.3). Faction reaction chips show before the
// choice, so the player can weigh who gains and who loses. Debate strips show
// who is for and against, and how sure they are.
import {esc, h, setText, toggleClass} from '../dom.js';
import {icon} from '../icons.js';
import {inMonths, num, theName} from '../format.js';

const KIND_LABEL = {
  proposal: 'A proposal', petition: 'A petition', event: 'Something happened',
  demand: 'A demand', debate: 'A debate', report: 'A report',
};
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

function debateStrip(debate) {
  const col = (list, cls, title) => list?.length
    ? `<div class="debate-col ${cls}"><h4>${title}</h4>${list.map((s) => `<div class="stance"><b>${esc(s.label ?? s.name ?? s.faction)}</b>${s.note ? ` · ${esc(s.note)}` : ''}${Number.isFinite(s.p) ? `<small>${Math.round(s.p * 100)}% sure</small><div class="stance-bar"><i style="width:${Math.round(s.p * 100)}%"></i></div>` : ''}</div>`).join('')}</div>`
    : `<div class="debate-col ${cls}"><h4>${title}</h4><div class="stance"><small>No one, so far.</small></div></div>`;
  return `<div class="debate" aria-label="Debate">${col(debate.for, 'for', 'For')}${col(debate.against, 'against', 'Against')}</div>`;
}

// Build a full card. ctx: {factionName, bodyName, bodyIcon, coin(), unlocks(), onRule(card, option, node)}
export function createCard(card, ctx, {position, total} = {}) {
  const el = h('article.card', {'data-kind': card.kind ?? 'proposal', 'aria-labelledby': `t-${card.id}`});
  const report = card.kind === 'report';
  const options = card.options ?? [];
  const major = report ? options : options.filter((o) => !isMinor(o));
  const minor = report ? [] : options.filter(isMinor);
  const fromName = ctx.bodyName(card.from);
  const asker = card.asker;
  const showDebate = card.debate && ctx.unlocks().debates;
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
    ${showDebate ? debateStrip(card.debate) : ''}
    <div class="options"></div>
    <p class="card-note stuck" hidden>The chest cannot pay for any choice here. If you wait, ${esc(theName(fromName))} will act in its own way when this runs out.</p>
    ${minor.length ? '<div class="minor-options"></div>' : ''}
    <div class="card-foot">
      ${card.details?.length ? `<button class="link-btn details-btn" aria-expanded="false">Ask for details ${icon('chevron-down')}</button>` : ''}
      ${card.place ? `<button class="link-btn place-btn">${icon('locate')}Show me</button>` : ''}
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

  el.querySelector('.place-btn')?.addEventListener('click', () => ctx.focusWorld?.(card.place));
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
  el.__update = (next) => {
    latest = next ?? latest;
    if (sigOf(latest) !== proseSig && !touched) applyProse(latest, true);
    updateCard(el, latest, major, ctx);
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
  el.innerHTML = `<span class="next-text"><span class="next-from">${esc(ctx.bodyName(card.from))}${card.urgency >= 2 ? ' · urgent' : ''}</span><span class="next-title">${esc(card.title)}</span></span>${icon('chevron-right')}`;
  el.addEventListener('click', () => onPick(card.id));
  return el;
}
