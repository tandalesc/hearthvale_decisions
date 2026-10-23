// Inline SVG icon sprite (design-visual §8.10): 24×24, 1.75 px stroke,
// round caps and joins, currentColor. Mounted once; used via <use href>.

const PATHS = {
  // Bodies
  council: '<path d="M3 9.5 12 4l9 5.5"/><path d="M4 20h16M5 17h14"/><path d="M6.5 10.5v6M10 10.5v6M14 10.5v6M17.5 10.5v6"/>',
  farms: '<path d="M12 21V7"/><path d="M12 9c-2.6 0-4.2-1.7-4.2-4.2 2.6 0 4.2 1.7 4.2 4.2zM12 9c2.6 0 4.2-1.7 4.2-4.2-2.6 0-4.2 1.7-4.2 4.2z"/><path d="M12 14c-2.6 0-4.2-1.7-4.2-4.2 2.6 0 4.2 1.7 4.2 4.2zM12 14c2.6 0 4.2-1.7 4.2-4.2-2.6 0-4.2 1.7-4.2 4.2z"/><path d="M12 19c-2.6 0-4.2-1.7-4.2-4.2 2.6 0 4.2 1.7 4.2 4.2zM12 19c2.6 0 4.2-1.7 4.2-4.2-2.6 0-4.2 1.7-4.2 4.2z"/>',
  guild: '<path d="M4.5 19.5 13 11"/><path d="m10.5 7.5 4-4 6 6-4 4z"/><path d="m12.5 9.5 2 2"/>',
  treasury: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 10v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-4"/><path d="M5 14v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-4"/>',
  exchange: '<path d="M4 8.5h15l-4-4M20 15.5H5l4 4"/>',
  health: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M12 16.5V11M9.5 13.2h5"/>',
  works: '<path d="M2 17.5h20"/><path d="M3 17.5c0-4.6 4-8.3 9-8.3s9 3.7 9 8.3"/><path d="M7 12.6v4.9M12 9.2v8.3M17 12.6v4.9"/>',
  harbour: '<circle cx="12" cy="5" r="2"/><path d="M12 7v13"/><path d="M5 13a7 7 0 0 0 14 0"/><path d="M8.5 10.5h7"/>',
  schools: '<path d="M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5z"/><path d="M12 6v13.5"/>',
  parish: '<path d="M12 2.5v4M10.3 4.2h3.4"/><path d="M5 21v-8.5l7-5.7 7 5.7V21"/><path d="M10 21v-3.5a2 2 0 0 1 4 0V21"/><path d="M3.5 21h17"/>',
  union: '<path d="M5.5 21V3.5"/><path d="M5.5 4.5c4-2 7 2 12.5 0v8c-5.5 2-8.5-2-12.5 0"/>',
  watch: '<path d="M9 5.5h6M12 2.5v3"/><path d="M8 7.5h8l-.8 10.5H8.8z"/><path d="M6.5 21h11M12 11v3.5"/>',
  arts: '<path d="M2.5 5c6 3.2 13 3.2 19 0"/><path d="m5 6.4 1.6 5 2.1-4.3M10.7 7.5 12 12.3l1.3-4.8M15.3 7.1l2.1 4.3L19 6.4"/>',
  planning: '<path d="M4 20V4l16 16z"/><path d="M8 16v-3.8l3.8 3.8z"/><path d="M4 8h2M4 12h2"/>',
  // Metrics and views
  people: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.3c1.6.7 2.6 2.3 3 4.7"/>',
  homes: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  food: '<path d="M12 7.4c-1.6-1.2-4.6-1.3-6.1.7S4.6 13.2 6 16.1c1.4 2.9 3.6 4.4 6 3.4 2.4 1 4.6-.5 6-3.4 1.4-2.9 1.6-6.1.1-8s-4.5-1.9-6.1-.7z"/><path d="M12 7.4c0-2 1-3.6 3.2-4.4"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.6"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  roads: '<path d="M8 3 5 21M16 3l3 18"/><path d="M12 4v2.5M12 10.5v3M12 17.5V20"/>',
  chronicle: '<path d="M8 4h10.5A1.5 1.5 0 0 1 20 5.5V7h-3.5"/><path d="M16.5 5.5V18a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 18v-.5h9.5V18a2.5 2.5 0 0 0 2.5 2.5"/><path d="M8 4a1.5 1.5 0 0 0-1.5 1.5V17.5M9.5 9h4M9.5 12.5h4"/>',
  rules: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19"/><path d="M10 3v7l2-1.5 2 1.5V3"/>',
  tensions: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="m5 7-2.6 6.2a2.6 2.6 0 0 0 5.2 0zM19 7l-2.6 6.2a2.6 2.6 0 0 0 5.2 0z"/>',
  map: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z"/><path d="M9 4v14M15 6v14"/>',
  layers: '<path d="m12 4 9 4.5-9 4.5-9-4.5z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  locate: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  seal: '<circle cx="12" cy="10" r="6"/><path d="M9 15.2 8 21l4-2 4 2-1-5.8"/><path d="m9.6 10.1 1.6 1.6 3.1-3.2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-up': '<path d="m6 14.5 6-6 6 6"/>',
  'tri-up': '<path d="M12 6.5 18.5 17h-13z" fill="currentColor" stroke="none"/>',
  'tri-down': '<path d="M12 17.5 5.5 7h13z" fill="currentColor" stroke="none"/>',
  'tri-up-o': '<path d="M12 7.5 17.5 16.5h-11z"/>',
  'tri-down-o': '<path d="M12 16.5 6.5 7.5h11z"/>',
  flat: '<path d="M6 12h12"/>',
  sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  save: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19.5h14"/>',
  refresh: '<path d="M19.5 12A7.5 7.5 0 1 1 17 6.4"/><path d="M19.5 4v4.5H15"/>',
  quote: '<path d="M4 13h5V7H4v6c0 3-1 4-2 5M15 13h5V7h-5v6c0 3-1 4-2 5"/>',
  details: '<path d="M8 7h12M8 12h12M8 17h12"/><path d="M4 7h.01M4 12h.01M4 17h.01"/>',
  leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 14"/><path d="M5 19 14 10"/>',
  crest: '<path d="M18.5 4.5C10 3 4 9.5 6.5 16.5c6.5 5 13.5-.5 12-12z"/><path d="m4.5 20 9.5-10"/>',
  sprout: '<path d="M12 20v-8"/><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6zM12 14.5c0-3-2.5-5-6-5 0 3 2.5 5 6 5z"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="m9.5 4.6 2.5 2 2.5-2M9.5 19.4l2.5-2 2.5 2"/>',
  spark: '<path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2z"/>',
  flag: '<path d="M5.5 21V3.5"/><path d="M5.5 4.5h12l-2.5 4 2.5 4h-12"/>',
  quill: '<path d="M20 4C12 4 7 9 5.5 18.5"/><path d="M20 4c0 7-4.5 11-10.5 11.5M4 20l2-2"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 6.5-6 6.5-2.6 0-4.2-1.3-5.6-3.5L3.6 14a1.5 1.5 0 0 1 2.4-1.8L8 14"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  scroll: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 11.5h6M9 15h4"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off': '<path d="M3.5 3.5l17 17"/><path d="M9.9 6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.7 3.5M6.2 7.6C3.9 9.4 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/>',
};

export const ICON_NAMES = Object.keys(PATHS);

// Body (institution) id → icon. Unknown ids fall back to the council hall.
const BODY_ICONS = {
  moot: 'council', council: 'council', 'agri-council': 'farms', 'trades-guild': 'guild', exchange: 'exchange',
  'river-authority': 'works', 'school-board': 'schools', parish: 'parish', 'health-board': 'health',
  planning: 'planning', union: 'union', watch: 'watch', 'arts-society': 'arts', steward: 'treasury', ward: 'flag',
};

export function bodyIcon(body) {
  if (body?.icon && PATHS[body.icon]) return body.icon;
  if (String(body?.id ?? '').startsWith('ward:')) return 'flag';
  return BODY_ICONS[body?.kind] ?? BODY_ICONS[body?.id] ?? 'council';
}

export function mountSprite(root = document.body) {
  if (document.getElementById('hv-sprite')) return;
  const symbols = Object.entries(PATHS)
    .map(([name, d]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${d}</symbol>`)
    .join('');
  const holder = document.createElement('div');
  holder.innerHTML = `<svg id="hv-sprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${symbols}</svg>`;
  root.prepend(holder.firstChild);
}

// Markup for an icon. Symbols inherit stroke settings from the sprite <svg>
// only in some engines, so set them on the use site as well.
export function icon(name, cls = '') {
  return `<svg class="i ${cls}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-${name}"/></svg>`;
}

export function iconNode(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
}
