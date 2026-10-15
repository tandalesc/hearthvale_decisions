// Time controls (design-visual §8.7): pause / 1× / 3× / 8×, a thin era
// progress bar toward the next age, the season, and a sound toggle.
// 'strip' variant lives in the desktop time strip; 'peek' in the phone sheet
// (the docket and every other view sit in the sheet's view strip below it).
import {h, setAttr, setText} from '../dom.js';
import {icon} from '../icons.js';
import {SEASON_ICONS, SEASONS} from '../format.js';

export const SPEEDS = [0, 1, 3, 8];

function speedSeg(ctx) {
  const seg = h('div.seg', {role: 'group', 'aria-label': 'Speed'});
  for (const s of SPEEDS) {
    const b = h('button', {type: 'button', 'data-speed': s, class: s === 0 ? 'pause' : null, 'aria-label': s === 0 ? 'Pause' : `Speed ${s} times`, title: s === 0 ? 'Pause (Space)' : `${s}× (${SPEEDS.indexOf(s)})`});
    b.innerHTML = s === 0 ? icon('pause') : `${s}×`;
    b.addEventListener('click', () => ctx.setSpeed(s === 0 && ctx.speed() === 0 ? ctx.lastSpeed() : s));
    seg.append(b);
  }
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
    const date = h('button.peek-date', {type: 'button'});
    date.innerHTML = '<b class="when"></b><span class="era-next"></span>';
    date.addEventListener('click', () => ctx.openEraPopover(date));
    el.append(seg, date);
  }

  return {
    el,
    update({speed, top, era, muted}) {
      for (const b of seg.children) {
        const s = Number(b.dataset.speed);
        setAttr(b, 'aria-pressed', String(s === speed));
        if (s === 0) {
          const want = speed === 0 ? 'play' : 'pause';
          if (b.dataset.icon !== want) {
            b.dataset.icon = want;
            b.innerHTML = icon(want);
            b.setAttribute('aria-label', speed === 0 ? 'Resume' : 'Pause');
          }
        }
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
      } else {
        const when = el.querySelector('.when');
        if (when.dataset.y !== String(top.year)) {
          when.dataset.y = String(top.year);
          when.innerHTML = `<span class="long">Year </span><span class="short">Yr </span>${top.year ?? 0}`;
        }
        setText(el.querySelector('.era-next'), `${SEASONS[top.season] ?? ''} · ${top.eraName ?? ''}`);
      }
    },
  };
}
