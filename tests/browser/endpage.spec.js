// The end page (E9): the town's story opens once when the chronicle closes
// at year 150, pauses the town, and comes back from the Chronicle. Esc and
// Continue put it away; play goes on. One column on a phone.
import {test} from '@playwright/test';
import {expect, hv, inSim, open, settle} from './helpers.js';

// Carry the town to the end of year 149 and run into 150: the chronicle closes.
// The city is in its last age by then, so that age's title card may come first;
// the end page waits for it and opens when it is put away.
async function closeChronicle(page) {
  const ended = await inSim(page, (s, sim) => {
    s.time.year = 149;
    sim.fastForward(s, 1);
    return Boolean(s.chronicle.summary);
  });
  const card = page.locator('.moment-layer');
  await page.locator('.moment-layer, .endpage-layer').first().waitFor();
  while (await card.count()) {
    await expect(page.locator('.endpage-layer')).toHaveCount(0);
    await card.locator('.moment-go').click();
    await expect(card).toHaveCount(0);
  }
  return ended;
}

test('the end page opens once at year 150, pauses the town, and Esc or Continue puts it away', async ({page}) => {
  const errors = await open(page, {fixture: 'city', paused: false});
  await hv(page, () => window.hearthvale.setSpeed(3));
  expect(await closeChronicle(page)).toBe(true);
  const layer = page.locator('.endpage-layer');
  await expect(layer).toBeVisible();
  await expect(layer).toHaveAttribute('role', 'dialog');
  // The town's name as the title, the archetype arc under it.
  await expect(page.locator('#endpage-title')).toHaveText('Hearthvale');
  await expect(layer.locator('.endpage-lead')).toContainText('It began as');
  const highlights = await layer.locator('.endpage-highlights li').count();
  expect(highlights).toBeGreaterThan(0);
  expect(highlights).toBeLessThanOrEqual(12);
  await expect(layer.locator('.endpage-axis svg path')).toHaveCount(4);
  await expect(layer.locator('.endpage-bodies')).toContainText('Founded');
  await expect(layer.locator('.endpage-rulings')).toContainText('approved');
  // Paused while it is open.
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  // Focus starts on Continue and stays inside.
  await expect(layer.locator('.endpage-go')).toBeFocused();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  expect(await hv(page, () => Boolean(document.activeElement?.closest('.endpage-layer')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  // The pace comes back, and play goes on past 150.
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  await settle(page);
  await expect(layer).toHaveCount(0);

  // Back again from the Chronicle; Continue closes it.
  await hv(page, () => window.hearthvale.setSpeed(0));
  await page.locator('.rail [data-view="chronicle"]').click();
  const story = page.locator('.drawer .chronicle-story');
  await expect(story).toBeVisible();
  await story.click();
  await expect(layer).toBeVisible();
  await expect(page.locator('#endpage-title')).toHaveText('Hearthvale');
  await layer.locator('.endpage-go').click();
  await expect(layer).toHaveCount(0);
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  expect(errors).toEqual([]);
});

test('on a phone the end page is one column with no sideways scroll, and Share makes a link', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const errors = await open(page, {fixture: 'city'});
  let posted = null;
  await page.route('**/api/towns', async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({status: 201, contentType: 'application/json', body: JSON.stringify({id: 'abcdefgh23', url: '/t/abcdefgh23'})});
  });
  expect(await closeChronicle(page)).toBe(true);
  const layer = page.locator('.endpage-layer');
  await expect(layer).toBeVisible();
  await expect(layer.locator('.endpage-highlights li').first()).toBeVisible();
  const fit = await hv(page, () => {
    const l = document.querySelector('.endpage-layer');
    return {doc: document.documentElement.scrollWidth <= innerWidth, layer: l.scrollWidth <= l.clientWidth,
      wide: [...l.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.className).slice(0, 5)};
  });
  expect(fit).toEqual({doc: true, layer: true, wide: []});
  // One column: the bodies' rolls stack.
  const rolls = await layer.locator('.endpage-roll').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(rolls).size).toBe(1);
  await layer.locator('.endpage-share').scrollIntoViewIfNeeded();
  await layer.locator('.endpage-share').click();
  await expect(layer.locator('.endpage-status a')).toHaveAttribute('href', /\/t\/abcdefgh23$/);
  expect(posted.page.townName).toBe('Hearthvale');
  expect(posted.page.highlights.length).toBeLessThanOrEqual(12);
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  expect(errors).toEqual([]);
});
