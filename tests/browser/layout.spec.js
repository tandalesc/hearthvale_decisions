// Layout: every fixture at every target viewport keeps its regions apart,
// inside the screen, with no sideways scroll and 44 px targets.
import {test} from '@playwright/test';
import {VIEWPORTS, expect, open, regionIssues, settle, smallTargets} from './helpers.js';

for (const fixture of ['hamlet', 'town', 'city']) {
  test(`${fixture}: regions stay apart at all sizes`, async ({page}) => {
    test.setTimeout(90000);
    const errors = await open(page, {fixture});
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({width, height});
      await page.waitForFunction((w) => innerWidth === w, width);
      await settle(page);
      const layout = await page.evaluate(() => window.hearthvale.app.layout);
      expect(layout, `${width}×${height}`).toBe(width < 720 ? 'phone' : width < 1000 || height < 520 ? 'tablet' : 'desk');
      expect(await regionIssues(page), `${fixture} ${width}×${height}`).toEqual([]);
      expect(await smallTargets(page), `${fixture} ${width}×${height} targets`).toEqual([]);
      // The renderer is told which pixels the chrome covers.
      const insets = await page.evaluate(() => window.hearthvale.world.insets?.());
      expect(insets.top, `${width}×${height} top inset`).toBeGreaterThan(40);
      expect(insets.bottom, `${width}×${height} bottom inset`).toBeGreaterThan(40);
      // Only the fixed chrome frames the scene: the dock on the right, never a panel.
      if (layout !== 'phone') {
        expect(insets.right).toBeGreaterThan(50);
        expect(insets.right).toBeLessThan(100);
      }
    }
    expect(errors).toEqual([]);
  });
}

test('the tablet Council and the phone sheet stay clear of the chrome when open', async ({page}) => {
  await open(page, {fixture: 'city'});
  await page.setViewportSize({width: 768, height: 1024});
  await settle(page);
  await page.locator('.dock [data-body="council"]').click();
  await settle(page);
  const dk = await page.locator('.dk').boundingBox();
  const top = await page.locator('.topbar').boundingBox();
  const strip = await page.locator('.timestrip').boundingBox();
  const dock = await page.locator('.dock').boundingBox();
  expect(dk.y).toBeGreaterThanOrEqual(top.y + top.height);
  expect(dk.y + dk.height).toBeLessThanOrEqual(strip.y);
  expect(dk.x + dk.width).toBeLessThanOrEqual(dock.x);
  await page.locator('.brand').click();
  await page.keyboard.press('Escape');
  await settle(page);
  await expect(page.locator('.dk')).toBeHidden();

  await page.setViewportSize({width: 320, height: 568});
  await settle(page);
  for (const snap of [0, 1, 2]) {
    await page.evaluate((i) => window.hearthvale.app.sheet.snapTo(i, false), snap);
    await settle(page);
    const visible = await page.evaluate(() => innerHeight - document.querySelector('.sheet').getBoundingClientRect().top);
    const peek = await page.evaluate(() => window.hearthvale.app.sheet.peekHeight);
    expect(peek, 'the peek holds the time controls and the view strip in one row').toBeGreaterThanOrEqual(64);
    const expected = [peek, Math.round(568 * 0.55), Math.round(568 * 0.92)][snap];
    expect(Math.abs(visible - expected), `snap ${snap}`).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  }
});

test('the home-screen offer sits under Play once a town is kept, and fits a phone', async ({page}) => {
  test.setTimeout(90000);
  const errors = await open(page, {fixture: 'hamlet'});
  await page.locator('.settings-btn').click();
  await page.locator('.settings [data-act="save"]').click();
  await expect(page.locator('.toast')).toContainText('saved');
  await page.setViewportSize({width: 375, height: 667});
  await Promise.all([page.waitForNavigation(), page.locator('.settings [data-act="menu"]').click()]);
  await page.locator('[data-go="play"]').click();
  // Desktop Chrome without an install offer: nothing to show.
  await expect(page.locator('[data-go="continue"]')).toBeVisible();
  await expect(page.locator('.mm-install')).toHaveCount(0);

  // Chrome hands over its offer after the screen is drawn.
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt', {cancelable: true});
    e.prompt = async () => { window.prompted = true; };
    e.userChoice = Promise.resolve({outcome: 'dismissed'});
    dispatchEvent(e);
  });
  const offer = page.locator('.mm-install');
  await expect(offer.locator('[data-act="install"]')).toBeVisible();
  for (const button of await offer.locator('button').all()) {
    const box = await button.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await offer.locator('[data-act="install"]').click();
  expect(await page.evaluate(() => window.prompted)).toBe(true);
  await expect(offer).toHaveCount(0);

  // iOS has no offer: the Share-menu tip instead, until "Not now".
  await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', {get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'}));
  await page.locator('.mm-back').click();
  await page.locator('[data-go="play"]').click();
  await expect(offer).toContainText('tap Share, then Add to Home Screen');
  await expect(offer.locator('[data-act="install"]')).toHaveCount(0);
  await offer.locator('[data-act="install-later"]').click();
  await expect(offer).toHaveCount(0);
  await page.locator('.mm-back').click();
  await page.locator('[data-go="play"]').click();
  await expect(offer).toHaveCount(0);

  // The dev server never registers the offline worker.
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(errors).toEqual([]);
});
