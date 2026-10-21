// The sim in its worker (src/sim-worker.js, docs/design/sim-worker.md): the real sim
// runs there by default and the town moves on; ?simWorker=0 runs it on the main thread
// through the same host; and a worker that dies stops the town and says so.
import {test} from '@playwright/test';
import {expect, hv, inSim, open, settle} from './helpers.js';

const tick = (page) => inSim(page, (s) => s.time.tick);

test('the real sim runs in the worker: time passes, the mirror fills, a ruling lands', async ({page}) => {
  const errors = await open(page, {fixture: 'town', paused: false});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  expect(await hv(page, () => window.hearthvale.simHost)).toBe('worker');
  expect(await hv(page, () => window.hearthvale.state())).toBe(null);
  const t0 = await tick(page);
  await expect.poll(() => tick(page), {timeout: 15000}).toBeGreaterThan(t0 + 5);
  // The render view on this side is the mirror, filled from the worker.
  const mirror = await hv(page, () => {
    const v = window.hearthvale.host.mirror.view;
    return {buildings: v.buildings.length, people: v.peopleCount, roads: v.roads?.W ?? 0, year: v.time.year};
  });
  const town = await inSim(page, (s) => ({buildings: s.buildings.length, people: s.people.length, year: s.time.year}));
  expect(mirror.buildings).toBe(town.buildings);
  expect(mirror.people).toBeGreaterThan(0);
  expect(mirror.roads).toBeGreaterThan(0);
  // A ruling through the Council: the card leaves the worker's docket, once, even for
  // two clicks in the same task (the second goes while the first is on its way).
  await hv(page, () => window.hearthvale.setSpeed(0));
  await hv(page, () => window.hearthvale.app.openCouncil());
  await settle(page);
  const card = page.locator('.dk .card:not(.is-next):not([data-leaving])').first();
  test.skip(!(await card.count()), 'no card to rule on');
  const cid = await card.getAttribute('data-id');
  const history = await inSim(page, (s) => s.cardHistory.length);
  await hv(page, (id) => {
    const b = document.querySelector(`.dk .card[data-id="${id}"]`).querySelector('.option:not([disabled]), .minor');
    b.click();
    b.click();
  }, cid);
  await expect.poll(() => inSim(page, (s, sim, id) => s.docket.some((c) => c.id === id), cid)).toBe(false);
  await settle(page);
  expect(await inSim(page, (s, sim, id) => s.cardHistory.filter((c) => c.id === id).length, cid)).toBe(1);
  expect(await inSim(page, (s) => s.cardHistory.length)).toBe(history + 1);
  expect(errors).toEqual([]);
});

test('?simWorker=0 runs the town on the main thread through the same host', async ({page}) => {
  const errors = await open(page, {fixture: 'town', paused: false, query: '&simWorker=0'});
  expect(await hv(page, () => window.hearthvale.simHost)).toBe('inline');
  const t0 = await tick(page);
  await expect.poll(() => tick(page), {timeout: 15000}).toBeGreaterThan(t0 + 5);
  expect(await hv(page, () => window.hearthvale.state().time.tick)).toBeGreaterThan(t0);
  await settle(page);
  await expect(page.locator('.topbar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a worker that stops: the town stops too, and offers its last save', async ({page}) => {
  test.setTimeout(60000);
  const errors = await open(page, {fixture: 'town', paused: false});
  test.skip(await hv(page, () => window.hearthvale.simHost) !== 'worker', 'no sim worker');
  // The worker closes itself a moment after answering: no error event, just silence.
  await inSim(page, () => { setTimeout(() => self.close(), 50); return true; });
  await expect(page.locator('.notice', {hasText: 'The town stopped working'})).toBeVisible({timeout: 40000});
  // No more frames for a frozen town.
  expect(await hv(page, () => window.hearthvale.host.dead)).toBeTruthy();
  expect(errors).toEqual([]);
});
