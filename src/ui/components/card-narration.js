import {h, setAttr, setText} from '../dom.js';
import {icon} from '../icons.js';
import {animate} from '../motion.js';

// Quotes are presentation only. The canonical reason and every action remain
// unchanged; a rejected or cancelled preview returns to the game explanation.
export function createCardNarration(card, {allowSummaryToggle = true} = {}) {
  const el = h('div.card-narration');
  const body = h('div.card-narration-body', {id: `narration-${card.id}`});
  const explanation = h('p.card-why', {tabindex: '-1'});
  const quote = h('blockquote.card-flavour', {hidden: true});
  const quoteText = h('p.card-quote-text');
  quote.append(quoteText);
  const placeholder = h('div.card-narration-placeholder.shimmer', {hidden: true, 'aria-hidden': 'true'}, h('i'), h('i'));
  body.append(explanation, quote, placeholder);
  const toggle = h('button.icon-btn.card-narration-toggle', {type: 'button', hidden: true, 'aria-controls': body.id});
  const loading = h('span.card-narration-loading', {'aria-hidden': 'true', hidden: true}, h('i'), h('i'), h('i'));
  const status = h('span.sr-only.card-prose-status', {role: 'status', 'aria-live': 'polite'});
  el.append(body, toggle, loading, status);
  let latest = card, preferred = 'quote', signature = '', wasPending = false;

  function render(fade = true) {
    const pending = latest.streamingProse?.pending === true;
    const generated = pending ? latest.streamingProse.why : latest.prose?.source !== 'template' ? latest.prose?.why : '';
    const text = typeof generated === 'string' && generated !== latest.why ? generated.trim() : '';
    const showQuote = Boolean(text) && preferred === 'quote';
    const waiting = pending && !text && preferred === 'quote';
    const nextSignature = JSON.stringify([showQuote, showQuote ? text : latest.why, Boolean(text), pending]);
    if (nextSignature === signature) return;
    const previousHeight = body.getBoundingClientRect().height;
    const previousText = (quote.hidden ? explanation : quoteText).textContent;
    const wasQuote = !quote.hidden;
    signature = nextSignature;
    setText(explanation, latest.why ?? '');
    setText(quoteText, text);
    explanation.hidden = waiting || showQuote || !latest.why;
    placeholder.hidden = !waiting;
    quote.hidden = !showQuote;
    el.classList.toggle('has-quote', Boolean(text));
    el.classList.toggle('is-loading', pending);
    el.dataset.view = waiting ? 'loading' : showQuote ? 'quote' : 'explanation';
    setAttr(body, 'aria-busy', pending ? 'true' : null);
    loading.hidden = !pending || waiting;
    // Preserve a useful focus destination if a preview is rejected while the
    // player is using its swap control.
    if (!text && document.activeElement === toggle) explanation.focus({preventScroll: true});
    toggle.hidden = !text || !allowSummaryToggle;
    const label = showQuote ? 'Show game explanation' : 'Show town quote';
    setAttr(toggle, 'aria-label', label);
    setAttr(toggle, 'title', label);
    if (toggle.dataset.view !== el.dataset.view) {
      toggle.dataset.view = el.dataset.view;
      toggle.innerHTML = icon(showQuote ? 'details' : 'quote');
    }
    if (pending && !wasPending) setText(status, 'Preparing a town quote.');
    else if (!pending && wasPending) setText(status, text ? 'Town quote ready.' : 'Showing the game explanation.');
    wasPending = pending;
    const active = showQuote ? quote : explanation;
    if (fade && el.isConnected && (wasQuote !== showQuote || previousText !== (showQuote ? text : latest.why))) {
      // Cancel only our text/height animations; never replace nodes or delay
      // updates, so rapid previews and toggles cannot leave stale text behind.
      for (const node of [body, quote, explanation]) node.getAnimations?.().forEach(a => a.cancel());
      const height = body.getBoundingClientRect().height;
      if (previousHeight > 0 && height > 0 && Math.abs(previousHeight - height) > 1) {
        animate(body, [{height: `${previousHeight}px`, overflow: 'hidden'}, {height: `${height}px`, overflow: 'hidden'}], {duration: 280});
      }
      animate(active, [{opacity: 0.25, transform: 'translateY(4px)'}, {opacity: 1, transform: 'none'}], {duration: 320});
    }
  }
  toggle.addEventListener('click', () => {
    preferred = el.dataset.view === 'quote' ? 'explanation' : 'quote';
    render();
  });
  render(false);
  return {el, update(next) { latest = next; render(); }};
}
