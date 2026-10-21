// Advisers in the Council HUD (design §4, §8.3-8.4): one notice when the bench
// opens with a slate, the Advisers page (slate, hiring by area, the adviser's
// card, its mode, Dismiss with a confirm), and the banner on a card an adviser
// answered (Let it stand / Change). Real sim on the city fixture, run on past
// its first budget season (when the bench opens).
import {test} from '@playwright/test';
import {expect, hv, inSim, open, regionIssues, settle, smallTargets} from './helpers.js';

async function toBench(page) {
  await inSim(page, (s, sim) => {
    for (let i = 0; i < 9000 && !(s.time.year === 93 && s.time.month === 1); i++) sim.stepTick(s, 4, {}, {skipPeople: true});
  });
  await settle(page);
  // The bench's notice waits for the year's to go, so the two never crowd the stack.
  await expect(page.locator('.notice-major[data-key="year"]')).toBeVisible();
  await expect(page.locator('.notice-major[data-key="advisers"]')).toHaveCount(0);
  await page.locator('.notice-major[data-key="year"] .notice-close').click();
  await settle(page);
  await hv(page, () => window.hearthvale.app.refresh());
  await settle(page);
}
// A plan from the Agricultural Council (land and trade), as a body would bring it.
const bringPlan = (page, tag) => inSim(page, (s, sim, t) => {
  const docket = sim.docket;
  const card = docket.addCard(s, docket.makeCard(s, {kind: 'proposal', from: 'agri-council', templateId: 'seed-exchange', category: 'food',
    title: `A seed exchange (${t})`, why: 'Farmers would swap their best seed.', cost: 40, subjects: [`test:${t}`],
    options: [{key: 'do', label: 'Set it up', tradeoff: 'Small cost.', cost: 40, effects: [{tag: `test:${t}`}]}]}));
  return card ? {id: card.id, option: card.advice?.option ?? null, act: !!card.advice?.act} : null;
}, tag);

test('desktop: the bench opens with one notice; hire from the slate by area; mode; dismiss after a confirm', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await toBench(page);
  const notice = page.locator('.notice-major[data-key="advisers"]');
  await expect(notice).toContainText('advisers');
  await notice.locator('.notice-main').click();
  await settle(page);
  await expect(page.locator('#dk-title')).toHaveText('Advisers');
  await expect(page.locator('.dk-index [data-page="advisers"]')).toHaveAttribute('aria-pressed', 'true');
  // The slate: real townsfolk, each with beliefs and a salary; the seat's area to choose.
  const slate = page.locator('.dk-advisers .adv-card.is-candidate');
  await expect(slate).toHaveCount(3);
  await expect(page.locator('.dk-advisers .adv-areas .filter')).toHaveCount(3);
  await page.locator('.dk-advisers .adv-areas [data-area="land"]').click();
  await expect(page.locator('.dk-advisers .adv-areas [data-area="land"]')).toHaveAttribute('aria-pressed', 'true');
  const name = (await slate.first().locator('h4').textContent()).trim();
  await slate.first().locator('[data-act="hire"]').click();
  await settle(page);
  // Their card: who, what they believe, how they have done, what they answer.
  const card = page.locator('.dk-advisers .adv-card:not(.is-candidate)');
  await expect(card).toHaveCount(1);
  await expect(card.locator('h4')).toHaveText(name);
  await expect(card.locator('.adv-scales .lean')).toHaveCount(4);
  await expect(card.locator('.adv-stats div')).toHaveCount(4);
  await expect(card.locator('.adv-seg [aria-pressed="true"]')).toHaveText('Routine');
  await card.locator('.adv-seg [data-mode="all"]').click();
  await expect(card.locator('.adv-seg [aria-pressed="true"]')).toHaveText('All in their area');
  expect(await inSim(page, (s) => s.advisers.seats.find((x) => x.adviserId).mode)).toBe('all');
  expect(await inSim(page, (s) => s.advisers.seats.find((x) => x.adviserId).area)).toBe('land');
  expect(await smallTargets(page)).toEqual([]);
  // Dismiss: asked first; cancelling keeps them.
  await card.locator('[data-act="dismiss"]').click();
  await expect(page.locator('.confirm-layer')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText(`Dismiss ${name}?`);
  await page.locator('.confirm-layer [data-act="cancel"]').click();
  await expect(page.locator('.dk-advisers .adv-card:not(.is-candidate)')).toHaveCount(1);
  await card.locator('[data-act="dismiss"]').click();
  await page.locator('.confirm-layer [data-act="dismiss"]').click();
  await settle(page);
  await expect(page.locator('.dk-advisers .adv-card.is-candidate').first()).toBeVisible();
  expect(await inSim(page, (s) => s.advisers.roster[0].leftWhy)).toBe('dismissed');
  expect(errors).toEqual([]);
});

test('an advised card: the banner says who answers and why; Let it stand applies now; Change overrules', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await toBench(page);
  await inSim(page, (s, sim) => { sim.hireAdviser(s, s.advisers.slate.candidates[0].id, 'land'); });
  await hv(page, () => window.hearthvale.app.notices.dismissAll());
  const one = await bringPlan(page, 'one');
  expect(one.act).toBe(true);
  await hv(page, (id) => window.hearthvale.app.openCouncil({cardId: id}), one.id);
  await settle(page);
  const card = page.locator(`.dk .card[aria-labelledby="t-${one.id}"]`);
  const banner = card.locator('.advice');
  await expect(banner).toBeVisible();
  const adviser = await inSim(page, (s) => s.advisers.roster[0].name);
  await expect(banner.locator('b')).toContainText(`${adviser} will`);
  await expect(banner.locator('li').first()).toBeVisible();
  // The Advisers page lists it for review.
  await expect(page.locator('.dk-index [data-page="advisers"] .dk-filter-count')).toHaveText('1');
  await banner.locator('[data-advice="stand"]').click();
  await expect.poll(() => inSim(page, (s, sim, id) => s.docket.some((c) => c.id === id), one.id)).toBe(false);
  const h1 = await inSim(page, (s, sim, id) => s.cardHistory.findLast((c) => c.id === id), one.id);
  expect(h1.advisedBy).toBeTruthy();
  expect(h1.overruled).toBeFalsy();
  expect(h1.choice).toBe(one.option);
  // Change: the answers open; another one is yours, and counts as overruling.
  const two = await bringPlan(page, 'two');
  await hv(page, (id) => window.hearthvale.app.openCouncil({cardId: id}), two.id);
  await settle(page);
  const card2 = page.locator(`.dk .card[aria-labelledby="t-${two.id}"]`);
  await card2.locator('[data-advice="change"]').click();
  await expect(card2).toHaveClass(/is-changing/);
  await expect(card2.locator('.advice-change')).toBeVisible();
  const other = two.option === 'do' ? '.minor[data-option="not_now"]' : '.option[data-option="do"]';
  await card2.locator(other).click();
  await expect.poll(() => inSim(page, (s, sim, id) => s.docket.some((c) => c.id === id), two.id)).toBe(false);
  const h2 = await inSim(page, (s, sim, id) => s.cardHistory.findLast((c) => c.id === id), two.id);
  expect(h2.overruled).toBe(true);
  expect(await inSim(page, (s) => s.advisers.roster[0].stats.changed)).toBe(1);
  expect(errors).toEqual([]);
});

test('phone: the Advisers chip, the slate and hiring in the Council tab, in reach and on screen', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await toBench(page);
  await page.locator('.notice-major[data-key="advisers"] .notice-main').click();
  await settle(page);
  await hv(page, () => window.hearthvale.app.notices.dismissAll());
  await settle(page);
  await expect(page.locator('.sheet .dk')).toBeVisible();
  await expect(page.locator('.dk-index [data-page="advisers"]')).toHaveAttribute('aria-pressed', 'true');
  const hire = page.locator('.dk-advisers .adv-card.is-candidate [data-act="hire"]').first();
  await hire.scrollIntoViewIfNeeded();
  const box = await hire.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  expect(await hv(page, () => document.documentElement.scrollWidth)).toBe(390);
  expect((await regionIssues(page)).filter((x) => x !== '.topbar overlaps .sheet')).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);
  await hire.click();
  await settle(page);
  await expect(page.locator('.dk-advisers .adv-card:not(.is-candidate)')).toHaveCount(1);
  const seg = page.locator('.dk-advisers .adv-seg button');
  for (const b of await seg.all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(errors).toEqual([]);
});

test('before the bench opens there is no Advisers page', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await hv(page, () => window.hearthvale.app.openCouncil());
  await settle(page);
  await expect(page.locator('.dk-index [data-page="advisers"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
