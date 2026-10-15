// Small DOM helpers. The UI is plain DOM: components build nodes once and
// patch text, attributes and keyed lists in place, so focus, scroll and
// running animations survive the 4 Hz refresh.

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// h('div.card.is-open', {attrs}, ...children). Children may be strings,
// nodes, arrays or null. Attribute keys starting with "on" become listeners.
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className += (el.className ? ' ' : '') + value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Set text only when it changed (avoids layout work and screen reader chatter).
export function setText(el, text) {
  const value = String(text ?? '');
  if (el && el.textContent !== value) el.textContent = value;
}

export function setAttr(el, name, value) {
  if (!el) return;
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const v = value === true ? '' : String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
}

export function toggleClass(el, name, on) {
  if (el && el.classList.contains(name) !== Boolean(on)) el.classList.toggle(name, Boolean(on));
}

// Keyed list reconciliation. create(item) returns a node; update(node, item)
// patches it. Nodes keep their identity across calls. Removed nodes may run
// an exit animation through onRemove(node, done).
export function reconcile(container, items, {key, create, update, onRemove} = {}) {
  const existing = new Map();
  for (const node of container.children) {
    if (node.dataset.key != null && !node.dataset.leaving) existing.set(node.dataset.key, node);
  }
  let cursor = container.firstElementChild;
  const seen = new Set();
  for (const item of items) {
    const k = String(key(item));
    seen.add(k);
    let node = existing.get(k);
    if (!node) {
      node = create(item);
      node.dataset.key = k;
    }
    update?.(node, item);
    while (cursor && cursor.dataset.leaving) cursor = cursor.nextElementSibling;
    if (node !== cursor) container.insertBefore(node, cursor);
    else cursor = cursor.nextElementSibling;
  }
  for (const [k, node] of existing) {
    if (seen.has(k)) continue;
    if (onRemove) {
      node.dataset.leaving = '1';
      onRemove(node, () => node.remove());
    } else node.remove();
  }
}

// Cheap change detection for panels: rebuild only when the signature moves.
export function changed(holder, signature) {
  if (holder.__sig === signature) return false;
  holder.__sig = signature;
  return true;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Edge fades on a scrolling strip: fade-start / fade-end say which ends
// have more to see. Returns the update function for callers that change
// the strip's content.
export function watchFades(el, axis = 'x') {
  const update = () => {
    const x = axis === 'x';
    const pos = x ? el.scrollLeft : el.scrollTop;
    const size = x ? el.scrollWidth : el.scrollHeight;
    const view = x ? el.clientWidth : el.clientHeight;
    toggleClass(el, 'fade-start', pos > 2);
    toggleClass(el, 'fade-end', pos + view < size - 2);
  };
  el.classList.add(`fades-${axis}`);
  el.addEventListener('scroll', update, {passive: true});
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(el);
  return update;
}
