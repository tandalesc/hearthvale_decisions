// One-time two-line explainer at the top of a newly revealed surface.
import {esc, h} from '../dom.js';
import {icon} from '../icons.js';
import {animate, collapse, EASE} from '../motion.js';

export function explainer(ctx, id, lines) {
  if (!lines?.length || ctx.prefs.seen(`explain:${id}`)) return null;
  const el = h('div.explainer', {role: 'note'});
  el.innerHTML = `<p><b>${esc(lines[0])}</b>${lines[1] ? `<br>${esc(lines[1])}` : ''}</p><button class="icon-btn" aria-label="Got it, hide this note">${icon('close')}</button>`;
  el.querySelector('button').addEventListener('click', async () => {
    ctx.prefs.markSeen(`explain:${id}`);
    await animate(el, [{opacity: 1}, {opacity: 0}], {duration: 140, easing: EASE.in, fill: 'forwards'});
    await collapse(el);
    el.remove();
  });
  return el;
}

export const EXPLAINERS = {
  docket: ['This is the docket. Requests that need your ruling land here.', 'Nothing changes until you choose. Each request expires in time.'],
  rules: ['The Rule Book holds every rule in force.', 'Rules change only through proposals. Bodies will ask you to add, raise or drop them.'],
  people: ['These are the groups that live here.', 'Each wants different things. Their mood shapes how your rulings land.'],
  chronicle: ['The chronicle keeps the story of your town.', 'Your rulings are marked with a seal.'],
  tensions: ['Some rules pull against each other.', 'When two rules fight, both cost coin and little changes.'],
  overlays: ['The map can show what is hard to see.', 'Look at worn paths, land value or health across the town.'],
  debates: ['Some requests split the town.', 'The strip shows who is for and against, and how sure they are.'],
  delegation: ['You can let a body run its own affairs.', 'It spends within a cap and sends you a yearly report. You can take it back at any time.'],
  bodies: ['Each body now keeps a small dashboard.', 'The lines show the last five years.'],
};
