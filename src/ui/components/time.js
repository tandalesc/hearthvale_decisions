// Time controls (design-visual §8.7): pause, and one speed button that
// steps 1× → 3× → 5×, a thin era progress bar toward the next age, the
// season, and a sound toggle. 'strip' variant lives in the desktop time
// strip; 'peek' in the phone sheet (the Council and every other view sit in
// the sheet's view strip below it).
import {h, setAttr, setText} from '../dom.js';
import {icon} from '../icons.js';
import {SEASON_ICONS, SEASONS} from '../format.js';

export const SPEEDS = [1, 3, 5];

// The speed after s, round to 1× again after the fastest.
export function nextSpeed(s) {
  return SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length];
}

function speedSeg(ctx) {
  const seg = h('div.seg', {role: 'group', 'aria-label': 'Speed'});
  const pause = h('button.pause', {type: 'button', title: 'Pause (Space)'});
  pause.addEventListener('click', () => ctx.setSpeed(ctx.speed() === 0 ? ctx.lastSpeed() : 0));
  // Steps to the next speed; when paused it also starts the town again.
  const step = h('button.speed', {type: 'button', title: 'Change speed (1, 2, 3)'});
  step.addEventListener('click', () => ctx.setSpeed(nextSpeed(ctx.speed() || ctx.lastSpeed())));
  seg.append(pause, step);
  return seg;
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
  const seg = speedSeg(ctx);
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
