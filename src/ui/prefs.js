// Per-device UI preferences, persisted in localStorage. Every access is
// guarded: private windows and blocked storage fall back to defaults.

const KEY = 'hearthvale-ui';
const SEEN_KEY = 'hearthvale-ui-seen';

export const DEFAULT_PREFS = {
  quality: 'auto',          // auto | low | medium | high
  batterySaver: 'off',      // off | battery (when unplugged) | always
  dayCycle: 'seasonal',     // seasonal | slow | off
  peopleShadows: 'blob',    // blob: soft sun-aware blobs | full: walkers also cast real shadows
  motion: 'full',           // full | reduced
  theme: 'auto',            // auto | light | night
  textSize: 'normal',       // normal | large
  master: 0.8, ambience: 0.6, ui: 0.7, muted: false,
  moments: 'fast',          // fast: blocking title cards at 3× and 5× only | always | never
  settingsTab: 'game',      // the Settings tab opened last
  approvalTab: 'faction',   // the People view's Approval breakdown shown last
  binderWidth: null,        // px, the panel's dragged width; null is the layout default
  drawerWidth: null,        // px, the left drawer's dragged width
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function createPrefs() {
  const values = {...DEFAULT_PREFS, ...read(KEY, {})};
  const seen = new Set(read(SEEN_KEY, []));
  const listeners = new Set();
  return {
    get: (k) => values[k],
    all: () => ({...values}),
    set(k, v) {
      if (values[k] === v) return;
      values[k] = v;
      write(KEY, values);
      for (const fn of listeners) fn(k, v);
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // One-time explainers and reveals.
    seen: (id) => seen.has(id),
    markSeen(id) {
      if (seen.has(id)) return;
      seen.add(id);
      write(SEEN_KEY, [...seen]);
    },
    resetSeen() { seen.clear(); write(SEEN_KEY, []); },
  };
}
