// Budgets in the Council HUD (design §3.8, §8): one notice for the season,
// a Budget season page after the Town Council with the cards and the season
// beside them, striking a plan line, the answers, the whole-season buttons,
// and on phones the Council tab's chips, the strip and the pager. Real sim on
// the city fixture, run on to its first season (month 9).
import {test} from '@playwright/test';
import {expect, hv, inSim, open, regionIssues, settle, smallTargets} from './helpers.js';

// On to budget season (headless steps), with a plan line on the first card so
// there is something to strike.
async function toSeason(page) {
  await inSim(page, (s, sim) => {
    for (let i = 0; i < 5000 && !(s.time.month === 9 && s.docket.some((c) => c.kind === 'budget')); i++) sim.stepTick(s, 4, {}, {skipPeople: true});
    const card = s.docket.find((c) => c.kind === 'budget');
    if (!card.data.budget.lines.some((l) => l.kind === 'plan')) {
      card.data.budget.lines.splice(1, 0, {id: 'plan:seed-exchange', kind: 'plan', label: 'A seed exchange', cost: 300, templateId: 'seed-exchange', need: 0.6});
    }
  });
  await settle(page);
}
const budgets = (page) => inSim(page, (s) => s.docket.filter((c) => c.kind === 'budget').map((c) => c.id));

test('desktop: one notice opens the Budget season page; cards, strike, answers and the season beside them', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await toSeason(page);
  const ids = await budgets(page);
  expect(ids.length).toBeGreaterThanOrEqual(5);
  // One notice for the season, none per budget.
  const notice = page.locator('.notice-major[data-key="budget-season"]');
  await expect(notice).toContainText(`${ids.length} bodies bring their budgets`);
  expect(await page.locator('.notice-major[data-key="request"]', {hasText: 'Budget for year'}).count()).toBe(0);
  await notice.locator('.notice-main').click();
  await settle(page);
  const panel = page.locator('.dk');
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('role', 'dialog');
  await expect(page.locator('#dk-title')).toHaveText(/^Budget season · year \d+$/);
  // Second in the list, after the Town Council, with its count.
  await expect(page.locator('.dk-index [data-page]').nth(1)).toHaveAttribute('data-page', 'budgets');
  await expect(page.locator('.dk-index [data-page="budgets"] .dk-filter-count')).toHaveText(String(ids.length));
  // One card open, the rest folded; the season beside them.
  await expect(page.locator('.dk .budget-card')).toHaveCount(1);
  await expect(page.locator('.dk .card.is-next')).toHaveCount(ids.length - 1);
  const side = page.locator('.dk-side .bud-season');
  await expect(side).toBeVisible();
  await expect(side.locator('.bud-bar')).toHaveCount(2);
  await expect(side.locator('.bud-rows li')).toHaveCount(ids.length);
  // The Town Council's own page keeps budgets apart.
  await page.locator('.dk-index [data-page="moot"]').click();
  await settle(page);
  await expect(page.locator('.dk .budget-card, .dk .card.is-next[data-kind="budget"]')).toHaveCount(0);
  await page.locator('.dk-index [data-page="budgets"]').click();
  await settle(page);
  // Strike the plan line: the ask drops by its cost, and it comes back.
  const first = page.locator('.dk .budget-card');
  const ask = async () => Number((await first.locator('.bud-ask b').textContent()).replace(/,/g, ''));
  const before = await ask();
  const strike = first.locator('[data-strike]').first();
  const cost = Number((await first.locator('.bud-line.is-plan .bud-cost').first().textContent()).replace(/,/g, ''));
  await strike.click();
  await expect(first.locator('.bud-line.is-plan').first()).toHaveClass(/is-struck/);
  await expect.poll(ask).toBe(before - cost);
  await first.locator('[data-strike]').first().click();
  await expect.poll(ask).toBe(before);
  await first.locator('[data-strike]').first().click();
  // Trim it to 75%: answered, the next card comes up, the season counts it.
  const answered = await first.getAttribute('aria-labelledby');
  await first.locator('[data-option="trim75"]').click();
  await expect.poll(async () => page.locator(`.dk .budget-card[aria-labelledby="${answered}"]:not([data-leaving])`).count()).toBe(0);
  await expect(side.locator('.section-head .aside').first()).toHaveText(`1 of ${ids.length} answered`);
  const h = await inSim(page, (s) => s.cardHistory.filter((x) => x.kind === 'budget').at(-1));
  expect(h.choice).toBe('trim75');
  // The struck plan waits like a "Not now".
  expect(await inSim(page, (s) => s.cardHistory.some((x) => x.templateId === 'seed-exchange' && x.choice === 'not_now'))).toBe(true);
  // The rest at once: trim to fit when over the room, else approve.
  const over = await hv(page, () => window.hearthvale.app.council && document.querySelector('[data-season="trimAllToFit"]') != null);
  await side.locator(over ? '[data-season="trimAllToFit"]' : '[data-season="approveAllBudgets"]').click();
  await settle(page);
  expect(await budgets(page)).toEqual([]);
  await expect(side.locator('.section-head .aside').first()).toHaveText(`${ids.length} of ${ids.length} answered`);
  await expect(page.locator('.dk .docket .empty')).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('after the year turns, a body\'s page shows its budget, and the Town Council its yearly grants', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await toSeason(page);
  await inSim(page, (s, sim) => {
    sim.approveAllBudgets(s);
    const y = s.time.year;
    for (let i = 0; i < 5000 && !(s.time.year === y + 1 && s.time.month === 2); i++) sim.stepTick(s, 4, {}, {skipPeople: true});
  });
  await settle(page);
  await hv(page, () => window.hearthvale.app.notices.dismissAll());
  const id = await inSim(page, (s) => s.institutions.find((b) => b.budget?.mode === 'annual' && b.budget.granted > 0).id);
  await hv(page, (b) => window.hearthvale.app.openCouncil({page: b}), id);
  await settle(page);
  const own = page.locator(`.dk-page .body-view[data-body="${id}"] .bud-body`);
  await expect(own).toBeVisible();
  await expect(own.locator('.section-head h3')).toHaveText('Its budget');
  await expect(own.locator('.bud-spent')).toBeVisible();
  await expect(page.locator('.dk-index [data-page="budgets"]')).toHaveCount(0);
  await page.locator('.dk-index [data-page="moot"]').click();
  await settle(page);
  await expect(page.locator('.dk-page .budget .section-head h3')).toHaveText('This year\'s budgets');
  expect(errors).toEqual([]);
});

for (const [width, height] of [[390, 844], [320, 568]]) {
  test(`phone ${width}: the Council tab's Budgets chip, the season strip, the pager and the answers`, async ({page}) => {
    await page.setViewportSize({width, height});
    const errors = await open(page, {fixture: 'city'});
    test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
    expect(await hv(page, () => window.hearthvale.app.layout)).toBe('phone');
    await toSeason(page);
    const ids = await budgets(page);
    await page.locator('.notice-major[data-key="budget-season"] .notice-main').click();
    await settle(page);
    await hv(page, () => window.hearthvale.app.notices.dismissAll());
    await settle(page);
    await expect(page.locator('.sheet .dk')).toBeVisible();
    await expect(page.locator('.dk-index [data-page="budgets"]')).toHaveAttribute('aria-pressed', 'true');
    // The strip sums the season up over the cards.
    const strip = page.locator('.dk .bud-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Asked');
    await expect(strip).toContainText('Room');
    // One card at a time, with the pager.
    await expect(page.locator('.dk .budget-card')).toHaveCount(1);
    await expect(page.locator('.dk .pager .eyebrow')).toHaveText(`1 of ${ids.length}`);
    await page.locator('.dk .pager .next').click();
    await expect(page.locator('.dk .pager .eyebrow')).toHaveText(`2 of ${ids.length}`);
    // Nothing spills sideways; every control in reach is 44 px or more.
    const rights = await page.locator('.dk .budget-card button').evaluateAll((els) => els.filter((e) => e.offsetWidth).map((e) => e.getBoundingClientRect().right));
    for (const r of rights) expect(r).toBeLessThanOrEqual(width + 0.5);
    expect(await hv(page, () => document.documentElement.scrollWidth)).toBe(width);
    // (A sheet raised all the way may pass under the top bar on the smallest phones.)
    expect((await regionIssues(page)).filter((x) => x !== '.topbar overlaps .sheet')).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
    // Approve the card in view.
    const card = page.locator('.dk .budget-card');
    await card.locator('[data-option="approve"]').scrollIntoViewIfNeeded();
    await card.locator('[data-option="approve"]').click();
    await expect.poll(async () => (await budgets(page)).length).toBe(ids.length - 1);
    // The strip's Trim to fit answers the rest, when the asks are over the room.
    if (await strip.locator('[data-season="trimAllToFit"]').count()) {
      await strip.locator('[data-season="trimAllToFit"]').click();
      await expect.poll(async () => (await budgets(page)).length).toBe(0);
    }
    expect(errors).toEqual([]);
  });
}
