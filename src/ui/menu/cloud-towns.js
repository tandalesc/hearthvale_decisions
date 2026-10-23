import {esc} from '../dom.js';
import {icon} from '../icons.js';

// Cloud backup inside Manage Towns. It adds to the menu's own town list
// rather than drawing a second one:
//   badge(town)        a small icon on each backed-up local town
//   entries(locals)    placeholder rows for cloud towns not on this device
//   row(entry, on)     markup for one of those rows
//   buttons(town)      extra buttons for the selected town (Plus: past versions)
//   notice(town)       "Not backed up yet", conflicts, the versions list
// Signed-out players see none of it.
export function createCloudTowns({cloud, play, changed, say, update}) {
  let busy = false, versions = null, confirm = null, disposed = false;
  const on = () => Boolean(cloud?.enabled());
  const snap = () => cloud.snapshot();
  const plus = () => snap().limit > 1;
  const remote = (id) => snap().towns.find((t) => t.id === id);
  const linked = (town) => { const b = cloud.link(town); return b?.id && !b.paused ? b : null; };
  const cloudIdOf = (town) => town?.cloudOnly ? town.cloudId : linked(town)?.id;
  const btn = (act, text, {cls = 'btn-secondary', attrs = ''} = {}) =>
    `<button type="button" class="btn ${cls}" data-cloud-act="${act}" ${attrs}${busy ? ' disabled' : ''}>${text}</button>`;
  const count = (n) => Number(n || 0).toLocaleString();

  // backed | conflict | problem | none
  function stateOf(town) {
    const status = cloud.status(town.id)?.state;
    if (status === 'conflict') return 'conflict';
    const b = linked(town);
    if (!b?.revision || !remote(b.id)) return 'none';
    return status === 'offline' || status === 'limit' ? 'problem' : 'backed';
  }

  function badge(town) {
    if (!on() || town.cloudOnly) return '';
    const state = stateOf(town);
    if (state === 'backed') return `<span class="mm-cloud-badge" title="Backed up to the cloud" role="img" aria-label="Backed up to the cloud">${icon('cloud-check')}</span>`;
    if (state === 'conflict' || state === 'problem') {
      const why = state === 'conflict' ? 'Changed on two devices' : 'Cloud backup needs attention';
      return `<span class="mm-cloud-badge is-alert" title="${why}" role="img" aria-label="${why}">${icon('cloud-alert')}</span>`;
    }
    return '';
  }

  function entries(locals) {
    if (!on()) return [];
    const here = new Set(locals.map((t) => cloud.link(t)?.id).filter(Boolean));
    const {towns, recoverable = []} = snap();
    return [
      ...towns.filter((t) => !here.has(t.id)).map((t) => ({...t, cloudOnly: true})),
      ...recoverable.filter((t) => !here.has(t.id)).map((t) => ({...t, cloudOnly: true, removed: true})),
    ].map((t) => ({...t, cloudId: t.id, id: `cloud:${t.id}`}));
  }

  function row(t, selected) {
    const meta = t.removed ? 'Removed from the cloud. It can be restored for seven days.' : 'In your cloud. Not on this device yet.';
    return `<li role="option" class="mm-town mm-town-cloud" data-town="${esc(t.id)}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">
      <span class="mm-thumb">${icon(t.removed ? 'cloud' : 'cloud-down')}</span>
      <span class="mm-town-text">
        <span class="mm-town-name">${esc(t.name || 'Hearthvale')}</span>
        <span class="mm-town-line">Year ${Number(t.year) || 0}. ${count(t.people)} people.</span>
        <span class="mm-town-meta">${meta}</span>
      </span>
    </li>`;
  }

  // Buttons for the selected town's main row.
  function buttons(town) {
    if (!on() || !town) return '';
    if (town.cloudOnly) {
      const main = town.removed
        ? btn('restore-removed', `${icon('refresh')}Restore`, {cls: 'btn-primary'})
        : btn('download', `${icon('cloud-down')}Download and play`, {cls: 'btn-primary'});
      return main + (plus() ? btn('versions', `${icon('clock')}Past versions`) : '') +
        (town.removed ? '' : btn('remove', 'Remove from cloud', {cls: 'btn-ghost btn-danger'}));
    }
    return plus() && stateOf(town) === 'backed' ? btn('versions', `${icon('clock')}Past versions`) : '';
  }

  function notice(town) {
    if (!on() || !town) return '';
    if (confirm) return confirmBox();
    const cloudId = cloudIdOf(town);
    if (versions && versions.cloudId === cloudId) return versionsBox(town);
    if (town.cloudOnly) return '';
    const state = stateOf(town);
    if (state === 'conflict') {
      return note('cloud-alert', 'This town changed on this device and another one. Choose which copy to keep; the other is kept as a separate town.',
        btn('use-cloud', 'Use cloud copy') + btn('keep-local', 'Keep this device’s copy'), 'is-alert');
    }
    if (state === 'problem') return note('cloud-alert', cloud.status(town.id)?.message || 'The last cloud backup did not finish.', btn('backup', 'Try again'), 'is-alert');
    if (state !== 'none') return '';
    const {towns, limit} = snap();
    if (towns.length < limit) return note('cloud', 'Not backed up to the cloud yet.', btn('backup', `${icon('cloud-up')}Back up now`));
    if (!plus()) {
      const other = towns[0];
      return note('cloud', `Your free cloud backup holds ${esc(other?.name || 'another town')}.`,
        btn('replace', `${icon('cloud-up')}Back up this town instead`, {attrs: `data-cloud-id="${esc(other?.id ?? '')}"`}));
    }
    return note('cloud', `All ${limit} cloud backups are in use. Remove one to back up this town.`, '');
  }

  const note = (name, text, actions, cls = '') =>
    `<div class="mm-cloud-note ${cls}">${icon(name)}<p>${text}</p>${actions ? `<div class="btn-row">${actions}</div>` : ''}</div>`;

  function versionsBox(town) {
    const label = (b) => b.id === 'previous' ? 'Previous save' : new Date(`${b.id}T12:00:00`).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
    const rows = versions.rows.map((b) => `<li><span><b>${esc(label(b))}</b><small>Year ${Number(b.year) || 0} · ${count(b.people)} people</small></span>${btn('restore', 'Restore', {attrs: `data-backup="${esc(b.id)}"`})}</li>`).join('');
    const stop = !town.cloudOnly && !town.removed ? btn('remove', 'Stop backing up', {cls: 'btn-ghost btn-danger'}) : '';
    return `<div class="mm-versions"><div class="mm-versions-head"><h3>Past versions</h3>${btn('close-versions', 'Close', {cls: 'btn-ghost'})}</div>
      ${rows ? `<ul>${rows}</ul>` : '<p class="mm-small">No earlier versions yet. A daily copy is kept from the first night after a backup.</p>'}
      ${stop ? `<div class="btn-row">${stop}</div>` : ''}</div>`;
  }

  function confirmBox() {
    const text = {
      remove: 'Stop backing up this town? Copies on your devices stay. The cloud copy can be restored for seven days.',
      replace: 'Back up this town instead? The other town stays on its devices, and its cloud copy can be restored for seven days.',
      restore: 'Restore this version? Your current copy on this device is kept as a separate town.',
      keep: 'Replace the cloud copy with this device’s progress? The cloud copy stays in past versions.',
    }[confirm.type];
    return `<div class="mm-confirm" role="alert"><p>${text}</p><div class="btn-row">${btn('confirm', 'Confirm', {cls: 'btn-primary'})}${btn('cancel', 'Cancel', {cls: 'btn-ghost'})}</div></div>`;
  }

  async function run(fn) {
    if (busy) return;
    busy = true; update();
    try { await fn(); await changed(); }
    catch (error) { say(error.message || 'Cloud backup is unavailable. Your towns on this device are safe.', 'error'); }
    finally { busy = false; if (!disposed) update(); }
  }

  // Clicks on [data-cloud-act]; town is the menu's selected town.
  function handle(button, town) {
    if (busy || !town) return;
    const act = button.dataset.cloudAct, cloudId = cloudIdOf(town);
    if (act === 'download') return play(town.cloudId);
    if (act === 'backup') return run(async () => { await cloud.resume(town.id); say('Backed up to the cloud.'); });
    if (act === 'use-cloud') return run(async () => { await cloud.useCloud(town.id); say('Cloud copy downloaded. This device’s copy was kept as a separate town.'); });
    if (act === 'versions') return run(async () => { versions = {cloudId, rows: await cloud.history(cloudId)}; });
    if (act === 'close-versions') { versions = null; return update(); }
    if (act === 'restore-removed') { confirm = {type: 'restore', cloudId, backup: 'previous'}; return update(); }
    if (act === 'restore') { confirm = {type: 'restore', cloudId, backup: button.dataset.backup}; return update(); }
    if (act === 'remove') { confirm = {type: 'remove', cloudId}; return update(); }
    if (act === 'replace') { confirm = {type: 'replace', cloudId: button.dataset.cloudId, local: town.id}; return update(); }
    if (act === 'keep-local') { confirm = {type: 'keep', local: town.id}; return update(); }
    if (act === 'cancel') { confirm = null; return update(); }
    if (act === 'confirm') {
      const c = confirm; confirm = null;
      return run(async () => {
        if (c.type === 'remove') { await cloud.remove(c.cloudId); versions = null; say('No longer backed up. Copies on your devices are unchanged.'); }
        else if (c.type === 'replace') { if (c.cloudId) await cloud.remove(c.cloudId); await cloud.resume(c.local); say('Backed up to the cloud.'); }
        else if (c.type === 'restore') { await cloud.restore(c.cloudId, c.backup); versions = null; say('Version restored. Your earlier copy on this device was kept.'); }
        else { await cloud.keepLocal(c.local); say('This device’s progress is now in the cloud.'); }
      });
    }
  }

  // A different town was selected: drop panels that belonged to the last one.
  function reset() { versions = null; confirm = null; }

  const unsubscribe = cloud?.subscribe?.(() => { if (!disposed) update(); }) ?? (() => {});
  if (on()) cloud.refresh().then(() => { if (!disposed) update(); }).catch(() => {});
  return {badge, entries, row, buttons, notice, handle, reset, destroy() { disposed = true; unsubscribe(); }};
}
