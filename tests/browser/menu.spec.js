// The main menu: founding a town, continuing it, managing kept towns, and
// coming back to the menu from the game.
import {test, expect} from '@playwright/test';
import {hv} from './helpers.js';

async function openMenu(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => {
    localStorage.setItem('hearthvale-model-enabled', 'false');
    localStorage.setItem('hearthvale-ui-seen', JSON.stringify(['explain:docket', 'explain:rules', 'explain:people', 'explain:chronicle', 'explain:tensions', 'explain:overlays', 'explain:council']));
  });
  await page.goto('/?renderer=stub');
  await expect(page.locator('.mm')).toBeVisible();
  return errors;
}

const booted = (page) => page.waitForFunction(() => window.hearthvale?.app && !document.querySelector('.mm'));

test('a first visit shows the menu without Continue, and founds a named town in the chosen valley', async ({page}) => {
  test.setTimeout(90000);
  const errors = await openMenu(page);
  await expect(page.locator('.mm-word')).toHaveText('Hearthvale');
  await expect(page.locator('[data-go="continue"]')).toHaveCount(0);
  await page.locator('[data-go="new"]').click();
  await expect(page.locator('#mm-new-title')).toBeVisible();
  await page.locator('#mm-name').fill('Testbrook');
  await page.locator('#mm-seed').fill('Riverbend');
  await page.locator('[data-landscape="lake"]').click();
  await expect(page.locator('[data-landscape="lake"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.mm-cart-name')).toHaveText('Testbrook');
  await expect(page.locator('.mm-cart-sub')).toContainText('Lake valley');
  await expect(page.locator('.mm-map')).toHaveAttribute('data-loading', 'false', {timeout: 15000});
  await page.locator('[data-crowd="light"]').click();
  await expect(page.locator('[data-act="found"]')).toHaveText('Found Testbrook');
  await page.locator('[data-act="found"]').click();
  await booted(page);
  const s = await hv(page, () => {
    const st = window.hearthvale.state();
    return {name: st.townName, year: st.time.year, archetype: st.terrainArchetype ?? null, cap: st.settings?.individualCap};
  });
  expect(s.name).toBe('Testbrook');
  expect(s.year).toBe(0);
  if (await hv(page, () => window.hearthvale.sim) === 'real') {
    expect(s.archetype).toBe('lake');
    expect(s.cap).toBe(800);
  }
  await expect(page.locator('.brand h1')).toHaveText('Testbrook');
  expect(errors).toEqual([]);
});

test('Continue reopens the last town, and Your towns can rename and delete', async ({page}) => {
  test.setTimeout(90000);
  const errors = await openMenu(page);
  await page.locator('[data-go="new"]').click();
  await page.locator('#mm-name').fill('Keepsake');
  await page.locator('[data-act="found"]').click();
  await booted(page);
  // Save from the game, then go back to the menu the way a player would.
  await page.locator('.settings-btn').click();
  await page.locator('.settings [data-act="save"]').click();
  await expect(page.locator('.toast')).toContainText('saved');
  await Promise.all([page.waitForNavigation(), page.locator('.settings [data-act="menu"]').click()]);
  await expect(page.locator('.mm')).toBeVisible();
  await expect(page.locator('[data-go="continue"]')).toContainText('Keepsake, year 0');

  await page.locator('[data-go="continue"]').click();
  await booted(page);
  expect(await hv(page, () => window.hearthvale.state().townName)).toBe('Keepsake');

  await Promise.all([page.waitForNavigation(), hv(page, () => window.hearthvale.toMenu())]);
  await page.locator('[data-go="towns"]').click();
  const row = page.locator('.mm-town', {hasText: 'Keepsake'});
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-act="rename"]').click();
  await page.locator('.mm-rename').fill('Heirloom');
  await page.locator('.mm-rename').press('Enter');
  await expect(page.locator('.mm-town-name')).toHaveText(['Heirloom']);
  await page.locator('[data-act="delete"]').click();
  await expect(page.locator('.mm-confirm')).toContainText('Delete Heirloom');
  await page.locator('[data-act="delete-yes"]').click();
  await expect(page.locator('.mm-status')).toContainText('Heirloom was deleted');
  await expect(page.locator('.mm-town')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-go="continue"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the menu is usable with the keyboard and fits a phone', async ({page}) => {
  await page.setViewportSize({width: 375, height: 740});
  await openMenu(page);
  await expect(page.locator('[data-go="new"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-go="settings"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mm-set-title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mm-list')).toBeVisible();
  expect(await hv(page, () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
