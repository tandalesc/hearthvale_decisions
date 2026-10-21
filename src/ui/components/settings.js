// Settings (design-visual §8.7) in five ARIA tabs: Game (play and the
// town's save), Display (and live performance numbers), Sound,
// Accessibility (motion, text size, keys) and the local Decision model's
// status and pacing. The last tab opened is remembered.
import {esc, h, setText} from '../dom.js';
import {icon} from '../icons.js';
import {num} from '../format.js';

const STATUS = {
  ready: ['ok', 'Connected', (r) => `The decision model answers at ${r.endpoint ?? 'the local service'}.`],
  'service-unavailable': ['bad', 'Service unavailable', (r) => `Nothing answers at ${r.endpoint ?? 'the local service'}. Local rules keep the town running.`],
  'authentication-failed': ['bad', 'Key rejected', () => 'The service rejected the key in local.env. Local rules keep the town running.'],
  'key-missing': ['warn', 'No key', () => 'Add API_KEY to local.env, then restart npm run dev. Local rules keep the town running.'],
  'service-error': ['bad', 'Service error', () => 'The service answered with an error. Local rules keep the town running.'],
};

function seg(name, value, options) {
  return `<div class="seg" role="radiogroup" data-pref="${name}">${options.map(([v, label]) => `<button type="button" role="radio" data-value="${v}" aria-pressed="${String(v) === String(value)}" aria-checked="${String(v) === String(value)}">${esc(label)}</button>`).join('')}</div>`;
}

function field(label, hint, control) {
  return `<div class="field"><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>${control}</div>`;
}

function switchCtl(name, on, label) {
  return `<button type="button" class="switch" role="switch" data-switch="${name}" aria-checked="${Boolean(on)}" aria-label="${esc(label)}"></button>`;
}

function range(name, value, min, max, step, label) {
  return `<input type="range" data-range="${name}" min="${min}" max="${max}" step="${step}" value="${value}"${label ? ` aria-label="${esc(label)}"` : ''}>`;
}

// Tabs group the settings; the last one opened is remembered.
export const TABS = [
  {id: 'game', label: 'Game'},
  {id: 'display', label: 'Display'},
  {id: 'sound', label: 'Sound'},
  {id: 'access', label: 'Accessibility'},
  {id: 'model', label: 'Decision model'},
];

export function createSettings(ctx) {
  let el = null, timer = null, lastFocus = null;

  function build() {
    const p = ctx.prefs.all();
    const d = ctx.decisionSettings();
    el = h('div.settings', {role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title'});
    const tab = TABS.some((t) => t.id === p.settingsTab) ? p.settingsTab : TABS[0].id;
    const panels = {
      game: `
        <fieldset><legend>Play</legend>
          ${field('Title cards', 'Full-screen cards for a new age, a new body or a disaster. They pause the town.', seg('moments', p.moments, [['fast', 'At 3× and 5×'], ['always', 'Always'], ['never', 'Never']]))}
          ${field('People who walk', 'More is livelier but heavier on this device.', `<span style="display:flex;gap:10px;align-items:center">${range('individualCap', ctx.getIndividualCap(), 300, 5000, 100, 'People who walk')}<b class="cap-val" style="font:500 13px var(--font-mono);min-width:44px;text-align:right">${num(ctx.getIndividualCap())}</b></span>`)}
        </fieldset>
        <fieldset><legend>Your town</legend>
          <p style="margin:0 0 8px;font-size:var(--fs-13);color:var(--ink-2)">The town saves itself every 30 seconds on this device. Your other towns wait on the main menu. Export a copy to keep a town safe or move it.</p>
          ${ctx.seedCode?.() ? `<div class="field"><span>Valley<small>Share this code to grow the same valley.</small></span><span class="seed-row"><span class="seed-code">${esc(ctx.seedCode())}</span><button class="btn btn-secondary" data-act="copy-seed">Copy</button></span></div>` : ''}
          <div class="field"><span>Start from a seed<small>A code, a number or any word.</small></span><span class="seed-row"><input type="text" data-seed maxlength="40" placeholder="Riverbend" aria-label="Seed for a new valley"><button class="btn btn-secondary" data-act="seed-town">Start</button></span></div>
          <div class="btn-row">
            <button class="btn btn-primary" data-act="save">${icon('save')}Save now</button>
            <button class="btn btn-secondary" data-act="export">Export</button>
            <label class="btn btn-secondary">${icon('upload')}Import<input type="file" accept="application/json" class="sr-only" data-act="import"></label>
            <button class="btn btn-secondary" data-act="menu">Main menu</button>
            <button class="btn btn-ghost" data-act="new">Start a new town</button>
          </div>
        </fieldset>`,
      display: `
        <fieldset><legend>Display</legend>
          ${field('Detail', 'Auto picks what this device can draw smoothly.', seg('quality', p.quality, [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]))}
          ${field('Shadows of people', 'Soft shadows follow the sun smoothly. Full draws true shapes but costs more in a busy town.', seg('peopleShadows', p.peopleShadows, [['blob', 'Soft'], ['full', 'Full']]))}
          ${field('Shadows of trees', 'Soft shadows lie on the ground and follow the sun. Detailed draws true shapes on roofs and people too, and costs more. Low detail always uses simple ones.', seg('treeShadows', p.treeShadows, [['soft', 'Soft'], ['detailed', 'Detailed']]))}
          ${field('Battery saver', saverHint(ctx.power?.()), seg('batterySaver', p.batterySaver, [['off', 'Off'], ['battery', 'On battery'], ['always', 'Always']]))}
          ${field('Day and night', 'Seasonal follows the year. Slow gives a full day each minute.', seg('dayCycle', p.dayCycle, [['seasonal', 'Seasonal'], ['slow', 'Slow'], ['off', 'Off']]))}
          ${field('Theme', null, seg('theme', p.theme, [['auto', 'Auto'], ['light', 'Light'], ['night', 'Night']]))}
          ${field('Clean view', 'Hide everything but the town. Press H, or tap, to bring it back.', `<button class="btn btn-secondary" data-act="clean">${icon('eye-off')}Hide the interface</button>`)}
          ${isIOS() && !standalone() ? '<p class="ios-tip">For full screen, tap Share → Add to Home Screen.</p>' : ''}
        </fieldset>
        <fieldset><legend>Performance</legend><div class="stat-grid perf-stats"></div></fieldset>`,
      sound: `
        <fieldset><legend>Sound</legend>
          ${field('Sound', null, switchCtl('sound', !p.muted, 'Sound on'))}
          ${field('Volume', null, range('master', p.master, 0, 1, 0.05, 'Volume'))}
          ${field('Town and nature', null, range('ambience', p.ambience, 0, 1, 0.05, 'Town and nature'))}
          ${field('Interface', null, range('ui', p.ui, 0, 1, 0.05, 'Interface sounds'))}
        </fieldset>`,
      access: `
        <fieldset><legend>Reading and motion</legend>
          ${field('Motion', 'Reduced turns off slides and camera moves.', seg('motion', p.motion, [['full', 'Full'], ['reduced', 'Reduced']]))}
          ${field('Text size', null, seg('textSize', p.textSize, [['normal', 'Normal'], ['large', 'Large']]))}
        </fieldset>
        <fieldset><legend>Keys</legend>
          <div class="keys"><kbd>Space</kbd><span>Pause or resume</span><kbd>1</kbd><span>Normal speed</span><kbd>2</kbd><span>Three times</span><kbd>3</kbd><span>Five times</span><kbd>4</kbd><span>Ten times</span><kbd>5</kbd><span>Twenty times</span><kbd>C</kbd><span>Open or close the Council</span><kbd>R</kbd><span>Open or close the Rule Book</span><kbd>F</kbd><span>Full screen</span><kbd>H</kbd><span>Hide or show the interface</span><kbd>Esc</kbd><span>Close panels, cards and notices</span><kbd>← →</kbd><span>Move between these tabs</span></div>
        </fieldset>`,
      model: `
        <fieldset><legend>Decision model</legend>
          ${field('Use the local model', 'Townsfolk ask it about their everyday choices. Your rulings stay with you.', switchCtl('model', ctx.modelEnabled(), 'Use the local decision model'))}
          ${field('Pacing', 'Automatic asks what the town needs, and never asks the same question twice.', `<select data-decision="mode" aria-label="Pacing"><option value="auto" ${d.mode === 'auto' ? 'selected' : ''}>Automatic</option><option value="manual" ${d.mode === 'manual' ? 'selected' : ''}>Manual ceiling</option></select>`)}
          ${field('Most questions a second', 'Used in manual pacing. 1 to 5,000.', `<input type="number" min="1" max="5000" step="1" data-decision="cap" value="${d.cap}" aria-label="Most questions a second">`)}
          <div class="status-box" role="status">
            <div class="status-line"><span class="status-dot"></span><span class="status-title">Checking…</span></div>
            <div class="status-text" style="margin-top:4px">Asking the local decision service.</div>
            <div class="stat-grid decision-stats"></div>
            <div class="btn-row" style="margin-top:10px"><button class="btn btn-secondary" data-act="check">${icon('refresh')}Check again</button></div>
          </div>
        </fieldset>`,
    };
    el.innerHTML = `<div class="settings-card paper">
      <div class="panel-head"><h2 id="settings-title">Settings</h2><button class="icon-btn close" aria-label="Close settings">${icon('close')}</button></div>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">${TABS.map((t) => `<button type="button" role="tab" id="set-tab-${t.id}" data-tab="${t.id}" aria-controls="set-panel-${t.id}" aria-selected="${t.id === tab}" tabindex="${t.id === tab ? 0 : -1}">${esc(t.label)}</button>`).join('')}</div>
      <div class="settings-body">
        ${TABS.map((t) => `<section class="settings-panel" role="tabpanel" id="set-panel-${t.id}" data-panel="${t.id}" aria-labelledby="set-tab-${t.id}" tabindex="0"${t.id === tab ? '' : ' hidden'}>${panels[t.id]}</section>`).join('')}
      </div>
    </div>`;
    wire();
    return el;
  }

  function selectTab(id, focus) {
    if (!el || !TABS.some((t) => t.id === id)) return;
    for (const b of el.querySelectorAll('[role="tab"]')) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
      if (on) b.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    }
    for (const panel of el.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.dataset.panel !== id;
    el.querySelector('.settings-body').scrollTop = 0;
    ctx.prefs.set('settingsTab', id);
  }

  function wire() {
    el.querySelector('.close').addEventListener('click', close);
    const tablist = el.querySelector('[role="tablist"]');
    // Arrow keys move along the tabs and open each one (automatic activation).
    tablist.addEventListener('keydown', (e) => {
      const tabs = [...tablist.querySelectorAll('[role="tab"]')];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const to = {ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1}[e.key];
      if (to == null) return;
      e.preventDefault();
      selectTab(tabs[(to + tabs.length) % tabs.length].dataset.tab, true);
    });
    el.addEventListener('click', (e) => {
      if (e.target === el) return close();
      const tabBtn = e.target.closest('[role="tab"]');
      if (tabBtn) return selectTab(tabBtn.dataset.tab);
      const opt = e.target.closest('.seg[data-pref] button');
      if (opt) {
        const group = opt.parentElement;
        for (const b of group.children) {
          b.setAttribute('aria-pressed', String(b === opt));
          b.setAttribute('aria-checked', String(b === opt));
        }
        ctx.prefs.set(group.dataset.pref, opt.dataset.value);
        return;
      }
      const sw = e.target.closest('[data-switch]');
      if (sw) {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        if (sw.dataset.switch === 'sound') ctx.prefs.set('muted', !on);
        else if (sw.dataset.switch === 'model') { ctx.setModelEnabled(on); refreshStatus(); }
        else ctx.prefs.set(sw.dataset.switch, on);
        return;
      }
      const act = e.target.closest('button[data-act]')?.dataset.act;
      if (act === 'save') ctx.save(true);
      if (act === 'clean') ctx.hideInterface?.();
      if (act === 'export') ctx.exportSave();
      if (act === 'new') ctx.newTown();
      if (act === 'menu') ctx.toMenu?.();
      if (act === 'seed-town') {
        const seed = el.querySelector('[data-seed]').value.trim();
        if (seed) ctx.newTown({seed});
      }
      if (act === 'copy-seed') {
        const btn = e.target.closest('button');
        navigator.clipboard?.writeText(ctx.seedCode()).then(() => { btn.textContent = 'Copied'; }, () => { btn.textContent = 'Copy failed'; });
      }
      if (act === 'check') refreshStatus();
    });
    el.addEventListener('input', (e) => {
      const r = e.target.dataset.range;
      if (!r) return;
      const v = Number(e.target.value);
      if (r === 'individualCap') {
        setText(el.querySelector('.cap-val'), num(v));
        ctx.setIndividualCap(v);
      } else ctx.prefs.set(r, v);
    });
    el.addEventListener('change', (e) => {
      if (e.target.dataset.act === 'import' && e.target.files?.[0]) ctx.importSave(e.target.files[0]);
      if (e.target.dataset.decision) {
        const mode = el.querySelector('[data-decision="mode"]').value;
        const cap = Math.max(1, Math.min(5000, Math.round(Number(el.querySelector('[data-decision="cap"]').value) || 100)));
        ctx.configureDecisions({mode, cap});
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') trapFocus(e);
    });
  }

  function trapFocus(e) {
    const items = [...el.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  async function refreshStatus() {
    if (!el) return;
    const dot = el.querySelector('.status-dot');
    setText(el.querySelector('.status-title'), 'Checking…');
    try {
      const res = await fetch('/api/system1/status', {cache: 'no-store', signal: AbortSignal.timeout(4500)});
      if (!res.ok) throw new Error(String(res.status));
      const r = await res.json();
      const [tone, title, text] = STATUS[r.state] ?? ['warn', 'Unknown', () => 'The service gave an unexpected answer. Local rules keep the town running.'];
      if (!el) return;
      dot.className = `status-dot ${ctx.modelEnabled() ? tone : ''}`;
      setText(el.querySelector('.status-title'), ctx.modelEnabled() ? `${title}${r.model ? ` · ${r.model}` : ''}` : 'Model off · local rules');
      setText(el.querySelector('.status-text'), ctx.modelEnabled() ? text(r) : 'Townsfolk use simple local rules. Turn the model on to let them think for themselves.');
    } catch {
      if (!el) return;
      dot.className = 'status-dot bad';
      setText(el.querySelector('.status-title'), 'No answer');
      setText(el.querySelector('.status-text'), 'The status check failed. Restart npm run dev. Local rules keep the town running.');
    }
  }

  function refreshStats() {
    if (!el) return;
    const s = ctx.decisionStats() ?? {};
    const rows = [
      ['State', s.state === 'backoff' ? `retry in ${((s.backoffMs ?? 0) / 1000).toFixed(1)} s` : s.state ?? '–'],
      ['Answered a second', fmt(s.observedRate, 1)],
      ['Capacity a second', fmt(s.capacity, 0)],
      ['Response time', Number.isFinite(s.latencyMs) ? `${Math.round(s.latencyMs)} ms` : '–'],
      ['In flight', `${s.inFlight ?? 0} / ${s.concurrency ?? '–'}`],
      ['Queued', fmt(s.queueDepth, 0)],
      ['Batch size', fmt(s.batchSize, 0)],
      ['Answered', fmt(s.answered, 0)],
      ['Slice questions', fmt(s.tags?.slice?.asked ?? s.slices, 0)],
      ['Refinements', fmt(s.tags?.refine?.asked ?? s.refinements, 0)],
      ['Shared states', fmt(s.groupsPerRequest, 1)],
      ['Merged repeats', fmt(s.deduped, 0)],
      ['Failures', fmt(s.failures, 0)],
    ];
    el.querySelector('.decision-stats').innerHTML = rows.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    const w = ctx.renderStats() ?? {};
    const perf = [
      ['Frames a second', fmt(w.fps, 0)], ['Frame time', Number.isFinite(w.frameMs) ? `${w.frameMs.toFixed(1)} ms` : '–'],
      ['Sim step', Number.isFinite(ctx.simMs()) ? `${ctx.simMs().toFixed(2)} ms` : '–'], ['Detail', w.tier ?? '–'],
      ['Draw calls', fmt(w.drawCalls, 0)], ['Triangles', fmt(w.triangles, 0)],
      ['Battery saver', w.saving == null ? '–' : w.saving ? 'Saving' : 'Not saving'], ['Screen', w.refreshHz ? `${w.refreshHz} Hz` : '–'],
    ];
    el.querySelector('.perf-stats').innerHTML = perf.map(([k, v]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  }

  function open() {
    if (el) return;
    lastFocus = document.activeElement;
    ctx.root.append(build());
    refreshStatus();
    refreshStats();
    timer = setInterval(refreshStats, 500);
    requestAnimationFrame(() => el?.querySelector('[role="tab"][aria-selected="true"]')?.focus());
  }

  function close() {
    if (!el) return;
    clearInterval(timer);
    el.remove();
    el = null;
    lastFocus?.focus?.({preventScroll: true});
  }

  return {open, close, selectTab, get isOpen() { return Boolean(el); }};
}

// Where the browser can't report the battery (Safari, Firefox), say so:
// 'On battery' then never engages.
function saverHint(power) {
  const what = 'While you watch, the town draws 30 frames a second and a little softer. Moving the view stays smooth.';
  return power && !power.batteryKnown ? `${what} This browser can't tell when you're unplugged, so choose Always to save power.` : what;
}

function fmt(v, digits) {
  return Number.isFinite(v) ? (digits ? v.toFixed(digits) : num(v)) : '–';
}

function isIOS() {
  return /iP(hone|od|ad)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function standalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
