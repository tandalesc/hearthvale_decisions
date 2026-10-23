import {test, expect} from '@playwright/test';

async function mount(page, tier, upgrade = false) {
  await page.route('**/speed-test', (route) => route.fulfill({contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/src/ui/tokens.css"><body><button id="outside">Outside</button></body>'}));
  await page.goto('/speed-test');
  await page.evaluate(async ({tier, upgrade}) => {
    const {createTime} = await import('/src/ui/components/time.js');
    let speed = 1;
    window.chosenSpeeds = [];
    window.upgradeRequested = false;
    const ctx = {speed: () => speed, lastSpeed: () => speed || 1, entitlement: () => ({tier}), setSpeed: (value) => { speed = value; window.chosenSpeeds.push(value); time.update({speed}); }, ...(upgrade ? {openAccount: (options) => { window.upgradeRequested = options.view === 'plans'; }} : {})};
    const time = createTime(ctx, 'peek');
    time.el.style.cssText = 'position:fixed;bottom:8px;right:8px';
    document.body.append(time.el);
    time.update({speed});
  }, {tier, upgrade});
}

test('free speed popup lists all speeds, shows locked paid choices and selects an allowed speed', async ({page}) => {
  await mount(page, 'free');
  const trigger = page.locator('button.speed');
  await trigger.click();
  const menu = page.getByRole('menu', {name: 'Town speed'});
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
  await expect(menu.getByRole('menuitemradio', {name: '1×', exact: true})).toHaveAttribute('aria-checked', 'true');
  for (const speed of [10, 20]) await expect(menu.getByRole('menuitemradio', {name: `${speed}× Plus`})).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled entries remain discoverable, but can never set paid speeds.
  await menu.getByRole('menuitemradio', {name: '10× Plus'}).dispatchEvent('click');
  expect(await page.evaluate(() => window.chosenSpeeds)).toEqual([]);
  await menu.getByRole('menuitemradio', {name: '5×', exact: true}).click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveText('5×');
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.chosenSpeeds)).toEqual([5]);
});

test('paid popup supports keyboard selection, Escape and outside close', async ({page}) => {
  await mount(page, 'paid');
  const trigger = page.locator('button.speed');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitemradio', {name: '20×', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('20×');
  expect(await page.evaluate(() => window.chosenSpeeds)).toEqual([20]);
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator('#outside').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('phone popup keeps locked entries inert and offers a separate upgrade action', async ({page}) => {
  await page.setViewportSize({width: 390, height: 740});
  await mount(page, 'free', true);
  await page.locator('button.speed').click();
  const menu = page.getByRole('menu');
  const bounds = await menu.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  await menu.getByRole('menuitemradio', {name: '20× Plus'}).dispatchEvent('click');
  expect(await page.evaluate(() => window.upgradeRequested)).toBe(false);
  await menu.getByRole('menuitem', {name: 'Explore Plus'}).click();
  expect(await page.evaluate(() => window.upgradeRequested)).toBe(true);
  expect(await page.evaluate(() => window.chosenSpeeds)).toEqual([]);
  await expect(page.getByRole('menu')).toHaveCount(0);
});
