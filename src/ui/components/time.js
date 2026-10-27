// Time controls (design-visual §8.7): pause, and one speed button that
// opens a speed menu, a thin era progress bar toward the next age, the
// season, and a sound toggle. 'strip' variant lives in the desktop time
// strip; 'peek' in the phone sheet (the Council and every other view sit in
// the sheet's view strip below it).
import {allowedSpeeds} from '../../entitlements.js';
import {h, setAttr, setText} from '../dom.js';
import {icon} from '../icons.js';
import {SEASON_ICONS, SEASONS} from '../format.js';

// Keep the pure nextSpeed helper usable in Node tests.
if (typeof document !== 'undefined') import('./time-menu.css');

export const SPEEDS = [1, 3, 5, 10, 20];

// The speed after s, round to 1× again after the fastest.
export function nextSpeed(s, entitlement) {
  const speeds = allowedSpeeds(entitlement);
  return speeds[(speeds.indexOf(s) + 1) % speeds.length];
}

const toggleLag = (el, on) => el.classList.toggle('lagging', on);

function speedSeg(ctx) {
  const seg = h('div.seg', {role: 'group', 'aria-label': 'Speed'});
  const pause = h('button.pause', {type: 'button', title: 'Pause (Space)'});
  pause.addEventListener('click', () => ctx.setSpeed(ctx.speed() === 0 ? ctx.lastSpeed() : 0));
  const step = h('button.speed', {type: 'button', title: 'Choose speed', 'aria-haspopup': 'menu', 'aria-expanded': 'false'});
  let menu = null, controller = null;
  function close(restoreFocus = false) {
    if (!menu) return;
    controller.abort();
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.remove();
    menu = null;
    step.setAttribute('aria-expanded', 'false');
    step.removeAttribute('aria-controls');
    if (restoreFocus) step.focus();
  }
  function updateMenu() {
    if (!menu) return;
    const available = allowedSpeeds(ctx.entitlement?.());
    const current = ctx.speed() || ctx.lastSpeed() || 1;
    for (const item of menu.querySelectorAll('[role="menuitemradio"]')) {
      const speed = Number(item.dataset.value);
      item.setAttribute('aria-checked', String(speed === current));
      item.setAttribute('aria-disabled', String(!available.includes(speed)));
      item.querySelector('.speed-menu-mark').textContent = speed === current ? '✓' : '';
      item.querySelector('.speed-menu-plan').textContent = available.includes(speed) ? '' : 'Plus';
    }
  }
  function open() {
    menu = h('div.speed-menu', {id: `speed-menu-${Math.random().toString(36).slice(2)}`, role: 'menu', 'aria-label': 'Town speed', popover: 'manual', 'data-open': ''});
    menu.append(h('p.speed-menu-title', {role: 'presentation'}, 'Town speed'));
    for (const speed of SPEEDS) {
      const item = h('button.speed-menu-option', {type: 'button', role: 'menuitemradio', tabindex: '-1', dataset: {value: speed}},
        h('span.speed-menu-mark', {'aria-hidden': 'true'}), h('span', null, `${speed}×`), h('span.speed-menu-plan'));
      item.addEventListener('click', () => {
        // A locked speed keeps the current one, says why and shows the plans.
        if (!allowedSpeeds(ctx.entitlement?.()).includes(speed)) {
          close(true);
          ctx.speedLocked?.(speed);
          ctx.openAccount?.({view: 'plans'});
          return;
        }
        ctx.setSpeed(speed);
        close(true);
      });
      menu.append(item);
    }
    if (!allowedSpeeds(ctx.entitlement?.()).includes(10) && ctx.openAccount) {
      const upgrade = h('button.speed-menu-upgrade', {type: 'button', role: 'menuitem', tabindex: '-1'}, 'Explore Plus');
      upgrade.addEventListener('click', () => { close(true); ctx.openAccount({view: 'plans'}); });
      menu.append(upgrade);
    }
    document.body.append(menu);
    updateMenu();
    menu.showPopover?.();
    const anchor = step.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, anchor.top - bounds.height - 8)}px`;
    step.setAttribute('aria-expanded', 'true');
    step.setAttribute('aria-controls', menu.id);
    controller = new AbortController();
    const {signal} = controller;
    document.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target) && !step.contains(event.target)) close();
    }, {capture: true, signal});
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close(true);
    }, {capture: true, signal});
    window.addEventListener('resize', () => close(), {signal});
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % items.length;
      if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      if (next != null) { event.preventDefault(); items[next].focus(); }
    });
    menu.querySelector('[aria-checked="true"]')?.focus();
  }
  step.addEventListener('click', () => menu ? close(true) : open());
  step.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!menu) open(); }
  });
  seg.append(pause, step);
  return {el: seg, updateMenu};
}

function eraSummary(era) {
  if (!era || era.final) return {label: 'The last age', progress: 1, ready: ''};
  const conds = era.conditions ?? [];
  const met = conds.filter((c) => c.met).length;
  const condP = conds.length ? conds.reduce((a, c) => a + Math.min(1, c.progress ?? (c.met ? 1 : 0)), 0) / conds.length : 0;
  const progress = Math.max(condP, era.timeProgress ?? 0);
  return {label: `Next, ${era.nextName}`, ready: conds.length ? `${met} of ${conds.length} ready` : '', progress};
}

export function createTime(ctx, variant = 'strip') {
  const el = h('div.time', {'data-variant': variant});
  const {el: seg, updateMenu} = speedSeg(ctx);
  if (variant === 'strip') {
    const era = h('button.era-progress', {type: 'button', 'aria-haspopup': 'dialog'});
    era.innerHTML = '<span class="label"><b class="era-name"></b><span class="era-next"></span></span><span class="track"><i></i></span>';
    era.addEventListener('click', () => ctx.openEraPopover(era));
    const season = h('span.season');
    const sound = h('button.icon-btn.sound-btn', {type: 'button'});
    sound.addEventListener('click', () => ctx.toggleMute());
    el.append(seg, era, season, sound);
  } else {
    // The phone drawer keeps only pause and speed; the date is in the top bar.
    el.append(seg);
  }

  return {
    el,
    update({speed, top, era, muted}) {
      updateMenu();
      const [pause, step] = seg.children;
      const want = speed === 0 ? 'play' : 'pause';
      if (pause.dataset.icon !== want) {
        pause.dataset.icon = want;
        pause.innerHTML = icon(want);
        pause.setAttribute('aria-label', speed === 0 ? 'Resume' : 'Pause');
      }
      setAttr(pause, 'aria-pressed', String(speed === 0));
      const shown = speed || ctx.lastSpeed() || 1;
      if (step.dataset.speed !== String(shown)) {
        step.dataset.speed = String(shown);
        step.textContent = `${shown}×`;
        step.setAttribute('aria-label', `Speed ${shown} times. Change speed`);
      }
      setAttr(step, 'aria-pressed', String(speed > 0));
      // At a speed this device cannot keep up with, say what it really reaches.
      const reached = speed > 0 ? ctx.reachedSpeed?.() : null;
      const lagging = reached != null && reached < speed * 0.8;
      const lagKey = lagging ? String(Math.max(1, Math.round(reached))) : '';
      if (step.dataset.lag !== lagKey) {
        step.dataset.lag = lagKey;
        toggleLag(step, lagging);
        step.title = lagging ? `Running at about ${lagKey}× on this device. Choose speed` : 'Choose speed';
        step.setAttribute('aria-label', lagging ? `Speed ${shown} times, running at about ${lagKey} times. Change speed` : `Speed ${shown} times. Change speed`);
      }
      const sum = eraSummary(era);
      if (variant === 'strip') {
        setText(el.querySelector('.era-name'), top.eraName);
        setText(el.querySelector('.era-next'), [sum.label, sum.ready].filter(Boolean).join(' · '));
        el.querySelector('.track i').style.width = `${Math.round(sum.progress * 100)}%`;
        const season = el.querySelector('.season');
        const key = `${top.season}`;
        if (season.dataset.k !== key) {
          season.dataset.k = key;
          season.innerHTML = `${icon(SEASON_ICONS[top.season] ?? 'sun')}<span>${SEASONS[top.season] ?? ''}</span>`;
        }
        const sound = el.querySelector('.sound-btn');
        if (sound.dataset.m !== String(muted)) {
          sound.dataset.m = String(muted);
          sound.innerHTML = icon(muted ? 'mute' : 'sound');
          sound.setAttribute('aria-label', muted ? 'Turn sound on' : 'Mute sound');
          sound.title = muted ? 'Sound off' : 'Sound on';
        }
      }
    },
  };
}
