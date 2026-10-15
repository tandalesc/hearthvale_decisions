// The side dock and resizable panel (desk and tablet), and the phone's view
// strip: every view reachable, no sideways scroll, reveals for new unlocks.
import {test} from '@playwright/test';
import {expect, hv, open, settle} from './helpers.js';

const width = (page) => hv(page, () => Math.round(document.querySelector('.binder').getBoundingClientRect().width));
const rightInset = (page) => hv(page, () => window.hearthvale.world.insets().right);

// Records whether any element matching sel gained is-new after this call.
async function watchReveals(page, sel) {
  await hv(page, (s) => {
    window.__revealed = [];
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.matches?.(s) && n.classList.contains('is-new')) window.__revealed.push(n.dataset.body ?? n.dataset.view);
    }).observe(document.body, {childList: true, subtree: true});
  }, sel);
}

test('the panel resizes by drag, keys and double-click, persists, and the camera reframes live', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  const w0 = await width(page);
  const r0 = await rightInset(page);
  const grip = await page.locator('.binder .panel-resize').boundingBox();
  const y = grip.y + grip.height / 2;
  await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 60, y, {steps: 4});
  // Mid-drag: the panel and the scene insets already follow.
  await expect.poll(() => width(page)).toBeGreaterThan(w0 + 40);
  await expect.poll(() => rightInset(page)).toBeGreaterThan(r0 + 40);
  await page.mouse.move(grip.x - 120, y, {steps: 4});
  await page.mouse.up();
  const w1 = await width(page);
  expect(Math.abs(w1 - (w0 + 128))).toBeLessThan(4);
  await expect.poll(async () => Math.abs(await rightInset(page) - (r0 + w1 - w0))).toBeLessThan(2);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui')).binderWidth)).toBe(w1);

  // Limits: never past min(720, 55 %), never under 320.
  const g = await page.locator('.binder .panel-resize').boundingBox();
  await page.mouse.move(g.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(40, y, {steps: 4});
  await page.mouse.up();
  expect(await width(page)).toBeLessThanOrEqual(720);
  const g2 = await page.locator('.binder .panel-resize').boundingBox();
  await page.mouse.move(g2.x + 8, y);
  await page.mouse.down();
  await page.mouse.move(1430, y, {steps: 4});
  await page.mouse.up();
  expect(await width(page)).toBe(320);

  // Keyboard: arrows step 16 px; the handle reports its value.
  await page.locator('.binder .panel-resize').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await width(page)).toBe(352);
  await expect(page.locator('.binder .panel-resize')).toHaveAttribute('aria-valuenow', '352');
  await page.keyboard.press('ArrowRight');
  expect(await width(page)).toBe(336);

  // The width survives a reload.
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  await settle(page);
  expect(await width(page)).toBe(336);

  // Double-click puts it back.
  await page.locator('.binder .panel-resize').dblclick();
  expect(await width(page)).toBe(w0);
  await expect.poll(async () => Math.abs(await rightInset(page) - r0)).toBeLessThan(2);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui')).binderWidth)).toBeNull();
});

test('left rail mirrors the dock: a view opens its drawer, the open view closes it, and the drawer resizes', async ({page}) => {
  await open(page, {fixture: 'city', stub: true});
  const rules = page.locator('.rail [data-view="rules"]');
  const left = () => hv(page, () => window.hearthvale.world.insets().left);
  const railLeft = await left();
  // Same rail width and surface on both edges.
  const [rw, dw] = await hv(page, () => ['.rail', '.dock'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().width)));
  expect(rw).toBe(dw);
  await rules.hover();
  await expect(page.locator('.tip')).toHaveText('Rule Book');
  await rules.click();
  await expect(page.locator('.drawer')).toHaveClass(/is-open/);
  await expect(rules).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(left).toBeGreaterThan(railLeft + 250);
  const opened = await left();
  // Drag the drawer's inner edge: wider, and the scene reframes.
  const drawerW = () => hv(page, () => Math.round(document.querySelector('.drawer').getBoundingClientRect().width));
  const w0 = await drawerW();
  // Let the drawer finish sliding in before grabbing its edge.
  await expect.poll(() => hv(page, () => getComputedStyle(document.querySelector('.drawer')).transform)).toBe('none');
  const g = await page.locator('.drawer .panel-resize').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 90, g.y + g.height / 2, {steps: 5});
  await page.mouse.up();
  expect(Math.abs(await drawerW() - (w0 + 82))).toBeLessThan(4);
  await expect.poll(left).toBeGreaterThan(opened + 70);
  await page.locator('.drawer .panel-resize').focus();
  await page.keyboard.press('ArrowLeft');
  const w1 = await drawerW();
  expect(Math.abs(w1 - (w0 + 66))).toBeLessThan(4);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui')).drawerWidth)).toBe(w1);
  // The open view's tile closes the drawer again.
  await rules.click();
  await expect(page.locator('.drawer')).not.toHaveClass(/is-open/);
  await expect(rules).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(left).toBe(railLeft);
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  await page.locator('.rail [data-view="people"]').click();
  expect(await drawerW()).toBe(w1);
});

test('side dock: crests switch bodies, the open crest tucks the panel away, badges and tips show', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.binder .tabstrip')).toHaveCount(0);
  const moot = page.locator('.dock [data-body="moot"]');
  await expect(moot).toHaveAttribute('aria-pressed', 'true');
  await expect(moot.locator('.badge')).toHaveText(/^\d+$/);
  // Every busy body shows its own count.
  for (const b of await page.locator('.dock-list .dock-btn:not(.is-quiet)').all()) await expect(b.locator('.badge')).not.toBeEmpty();

  const farms = page.locator('.dock [data-body="agri-council"]');
  await farms.hover();
  await expect(page.locator('.tip')).toBeVisible();
  await expect(page.locator('.tip')).toContainText('Agricultural');
  await farms.click();
  await expect(page.locator('.binder .body-view[data-body="agri-council"]')).toBeVisible();
  await expect(farms).toHaveAttribute('aria-pressed', 'true');
  await expect(moot).toHaveAttribute('aria-pressed', 'false');
  // The open body's crest tucks the panel away; the dock stays.
  await farms.click();
  await expect(page.locator('.ui')).toHaveClass(/docked/);
  await expect(page.locator('.binder')).toBeHidden();
  await expect(page.locator('.dock')).toBeVisible();
  await expect(farms).toHaveAttribute('aria-pressed', 'false');
  // Any crest opens the panel to its body.
  await moot.click();
  await expect(page.locator('.ui')).not.toHaveClass(/docked/);
  await expect(page.locator('.binder .body-view[data-body="moot"]')).toBeVisible();
  expect(await hv(page, () => window.hearthvale.app.docked)).toBe(false);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui')).dock)).toBe('open');
  expect(errors).toEqual([]);
});

test('side dock: a new card shows a petitioner chip unless its docket is open, and a new body slides in', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  // Open to another body: the chip slides out beside the panel, nothing else moves.
  await page.locator('.dock [data-body="agri-council"]').click();
  await page.locator('.settings-btn').focus();
  await hv(page, () => window.hearthvale.dev.addCard());
  await expect(page.locator('.petition')).toBeVisible();
  await expect(page.locator('.dock [data-body="agri-council"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await hv(page, () => document.activeElement?.className)).toContain('settings-btn');
  // Once it has slid out, it sits clear of the panel.
  await expect.poll(() => hv(page, () => document.querySelector('.binder').getBoundingClientRect().left - document.querySelector('.petition').getBoundingClientRect().right)).toBeGreaterThanOrEqual(0);
  await page.locator('.petition').click();
  await expect(page.locator('.dock [data-body="moot"]')).toHaveAttribute('aria-pressed', 'true');

  // A founded body's crest arrives with the reveal and a dot until visited.
  await watchReveals(page, '.dock-btn');
  const before = await page.locator('.dock .dock-btn').count();
  await hv(page, () => window.hearthvale.dev.foundBody());
  await expect(page.locator('.dock .dock-btn')).toHaveCount(before + 1);
  expect(await hv(page, () => window.__revealed.length)).toBe(1);
  const id = await hv(page, () => window.__revealed[0]);
  await expect(page.locator(`.dock [data-body="${id}"] .dot`)).toBeVisible();
  await page.locator(`.dock [data-body="${id}"]`).click();
  await expect(page.locator(`.dock [data-body="${id}"] .dot`)).toBeHidden();
});

test('side dock: on a short tablet the crests scroll with a fade and stay on screen', async ({page}) => {
  await page.setViewportSize({width: 844, height: 390});
  await open(page, {fixture: 'city', stub: true});
  const info = await hv(page, () => {
    const list = document.querySelector('.dock-list');
    const dock = document.querySelector('.dock').getBoundingClientRect();
    return {scrolls: list.scrollHeight > list.clientHeight, fade: list.classList.contains('fade-end'), bottom: dock.bottom, right: dock.right};
  });
  expect(info.scrolls).toBe(true);
  expect(info.fade).toBe(true);
  expect(info.bottom).toBeLessThanOrEqual(390);
  expect(info.right).toBeLessThanOrEqual(844);
  await hv(page, () => { const l = document.querySelector('.dock-list'); l.scrollTop = l.scrollHeight; });
  await expect(page.locator('.dock-list')).toHaveClass(/fade-start/);
  await expect(page.locator('.dock-list')).not.toHaveClass(/fade-end/);
});

for (const [w, h] of [[390, 844], [320, 568]]) {
  test(`phone ${w}×${h}: the view strip reaches every unlocked view without sideways scroll`, async ({page}) => {
    await page.setViewportSize({width: w, height: h});
    const errors = await open(page, {fixture: 'city', stub: true});
    const nav = page.locator('.sheet-nav');
    await expect(nav).toBeInViewport();
    const ids = await nav.locator('.nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    const views = {rules: '.rulebook', people: '.people', tensions: '.tensions', chronicle: '.chronicle', places: '.places'};
    for (const want of ['moot', 'map', ...Object.keys(views)]) expect(ids, want).toContain(want);
    // The docket first, then every body (the dock's crests), then the views and the map.
    const crests = await hv(page, () => window.hearthvale.app.layout === 'phone' && [...document.querySelectorAll('.dock .dock-btn')].map((b) => b.dataset.body));
    const bodies = ids.filter((i) => !views[i] && i !== 'map');
    expect(bodies[0]).toBe('moot');
    expect(bodies.length).toBeGreaterThanOrEqual(8);
    expect(ids.slice(0, bodies.length)).toEqual(bodies);
    expect(ids.at(-1)).toBe('map');
    if (crests && crests.length) expect([...crests].sort()).toEqual([...bodies].sort());
    for (const id of ids) {
      const item = nav.locator(`[data-view="${id}"]`);
      const box = await item.boundingBox();
      expect(box.height, `${id} target`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${id} target`).toBeGreaterThanOrEqual(44);
      if (id === 'map') {
        await item.click();
        await expect(page.locator('.pop')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.pop')).toHaveCount(0);
        continue;
      }
      await item.click();
      const sel = views[id] ? `.sheet ${views[id]}` : `.sheet .body-view[data-body="${id}"]`;
      await expect(page.locator(sel), id).toBeVisible();
      await expect(item).toHaveAttribute('aria-current', 'true');
      expect(await hv(page, () => window.hearthvale.app.sheet.index), id).toBeGreaterThan(0);
      expect(await hv(page, () => document.documentElement.scrollWidth), id).toBe(w);
    }
    // The docket opens tall; tapping it again lowers the sheet to its peek.
    await nav.locator('[data-view="moot"]').click();
    await expect.poll(() => hv(page, () => window.hearthvale.app.sheet.index)).toBe(2);
    await nav.locator('[data-view="moot"]').click();
    await expect.poll(() => hv(page, () => window.hearthvale.app.sheet.index)).toBe(0);
    expect(await hv(page, () => document.documentElement.scrollWidth)).toBe(w);
    expect(errors).toEqual([]);
  });
}

test('phone: views unlocked while playing slide into the strip with the reveal', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await open(page, {fixture: 'hamlet', stub: true});
  const before = await page.locator('.sheet-nav .nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
  await watchReveals(page, '.nav-item');
  await hv(page, () => window.hearthvale.dev.advanceEra());
  await settle(page);
  const after = await page.locator('.sheet-nav .nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
  expect(after).toContain('rules');
  expect(after.length).toBeGreaterThan(before.length);
  const revealed = await hv(page, () => window.__revealed);
  expect(revealed).toContain('rules');
  await expect(page.locator('.sheet-nav [data-view="rules"] .dot')).toBeVisible();
  await page.locator('.sheet-nav [data-view="rules"]').click();
  await expect(page.locator('.sheet .rulebook')).toBeVisible();
  await expect(page.locator('.sheet-nav [data-view="rules"] .dot')).toBeHidden();
});
