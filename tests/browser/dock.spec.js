// The left rail and its resizable drawer, the dock's Council crest (desk and
// tablet), and the phone's view strip: every view reachable, no sideways
// scroll, reveals for new unlocks. Panels never move the camera.
import {test} from '@playwright/test';
import {expect, hv, open, settle} from './helpers.js';

const insets = (page) => hv(page, () => JSON.stringify(window.hearthvale.world.insets()));

// Records whether any element matching sel gained is-new after this call.
async function watchReveals(page, sel) {
  await hv(page, (s) => {
    window.__revealed = [];
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.matches?.(s) && n.classList.contains('is-new')) window.__revealed.push(n.dataset.body ?? n.dataset.view);
    }).observe(document.body, {childList: true, subtree: true});
  }, sel);
}

test('opening, closing and resizing panels never moves the camera', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  const frame = await insets(page);
  await page.locator('.rail [data-view="rules"]').click();
  await expect(page.locator('.drawer')).toHaveClass(/is-open/);
  await expect.poll(() => hv(page, () => getComputedStyle(document.querySelector('.drawer')).transform)).toBe('none');
  const g = await page.locator('.drawer .panel-resize').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 90, g.y + g.height / 2, {steps: 5});
  await page.mouse.up();
  await page.locator('.dock [data-body="council"]').click();
  await expect(page.locator('.dk')).toBeVisible();
  await settle(page);
  expect(await insets(page)).toBe(frame);
  await page.locator('.dk-close').click();
  await page.locator('.rail [data-view="rules"]').click();
  await settle(page);
  expect(await insets(page)).toBe(frame);
  expect(errors).toEqual([]);
});

test('left rail: a view opens its drawer, the open view closes it, the drawer resizes, and only views and the map sit on it', async ({page}) => {
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
  // No locate or full-screen tiles: views, then the map.
  await expect(page.locator('.rail [data-view="home"], .rail [data-view="fullscreen"]')).toHaveCount(0);
  // Drag the drawer's inner edge: wider; the scene stays put.
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
  expect(await left()).toBe(railLeft);
  await page.locator('.drawer .panel-resize').focus();
  await page.keyboard.press('ArrowLeft');
  const w1 = await drawerW();
  expect(Math.abs(w1 - (w0 + 66))).toBeLessThan(4);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui')).drawerWidth)).toBe(w1);
  // The open view's tile closes the drawer again.
  await rules.click();
  await expect(page.locator('.drawer')).not.toHaveClass(/is-open/);
  await expect(rules).toHaveAttribute('aria-pressed', 'false');
  expect(await left()).toBe(railLeft);
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  await page.locator('.rail [data-view="people"]').click();
  expect(await drawerW()).toBe(w1);
});

test('the dock holds one crest, the Council: a badge for every request, a tip, and it opens and closes the panel', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.dock .crest-btn')).toHaveCount(1);
  const crest = page.locator('.dock [data-body="council"]');
  const want = await hv(page, () => window.hearthvale.state().docket.filter((c) => c.kind !== 'report').length);
  await expect(crest.locator('.badge')).toHaveText(String(want));
  await crest.hover();
  await expect(page.locator('.tip')).toContainText('Council');
  await crest.click();
  await expect(page.locator('.dk')).toBeVisible();
  await expect(crest).toHaveAttribute('aria-pressed', 'true');
  await crest.click();
  await expect(page.locator('.dk')).toBeHidden();
  await expect(crest).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('a new body joins the Council\'s list with the reveal dot until visited', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await hv(page, () => window.hearthvale.app.openCouncil());
  const before = await page.locator('.dk-index [data-page]').count();
  const known = await page.locator('.dk-index [data-page]').evaluateAll((els) => els.map((e) => e.dataset.page));
  await hv(page, () => window.hearthvale.dev.foundBody());
  await expect(page.locator('.dk-index [data-page]')).toHaveCount(before + 1);
  const id = await page.locator('.dk-index [data-page]').evaluateAll((els, k) => els.map((e) => e.dataset.page).find((x) => !k.includes(x)), known);
  await expect(page.locator(`.dk-index [data-page="${id}"] .dot`)).toBeVisible();
  await page.locator(`.dk-index [data-page="${id}"]`).click();
  await expect(page.locator(`.dk-index [data-page="${id}"] .dot`)).toHaveCount(0);
});

test('short tablet: the Council fits between the top bar and the time strip', async ({page}) => {
  await page.setViewportSize({width: 844, height: 390});
  await open(page, {fixture: 'city', stub: true});
  await hv(page, () => window.hearthvale.app.openCouncil());
  const r = await hv(page, () => {
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    return {dk: b('.dk'), top: b('.topbar'), strip: b('.timestrip'), dock: b('.dock')};
  });
  expect(r.dk.top).toBeGreaterThanOrEqual(r.top.bottom);
  expect(r.dk.bottom).toBeLessThanOrEqual(r.strip.top);
  expect(r.dk.right).toBeLessThanOrEqual(r.dock.left);
  expect(r.dock.bottom).toBeLessThanOrEqual(390);
});

for (const [w, h] of [[390, 844], [320, 568]]) {
  test(`phone ${w}×${h}: the view strip reaches every unlocked view without sideways scroll`, async ({page}) => {
    await page.setViewportSize({width: w, height: h});
    const errors = await open(page, {fixture: 'city', stub: true});
    const nav = page.locator('.sheet-nav');
    await expect(nav).toBeInViewport();
    const ids = await nav.locator('.nav-item').evaluateAll((els) => els.map((e) => e.dataset.view));
    const views = {rules: '.rulebook', people: '.people', tensions: '.tensions', chronicle: '.chronicle', places: '.places'};
    for (const want of ['council', 'map', ...Object.keys(views)]) expect(ids, want).toContain(want);
    // The Council first (every body lives inside it), then the views and the map.
    expect(ids[0]).toBe('council');
    expect(ids.filter((i) => !views[i] && i !== 'map' && i !== 'council')).toEqual([]);
    expect(ids.at(-1)).toBe('map');
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
      const sel = views[id] ? `.sheet ${views[id]}` : '.sheet .dk';
      await expect(page.locator(sel), id).toBeVisible();
      await expect(item).toHaveAttribute('aria-current', 'true');
      expect(await hv(page, () => window.hearthvale.app.sheet.index), id).toBeGreaterThan(0);
      expect(await hv(page, () => document.documentElement.scrollWidth), id).toBe(w);
    }
    // The Rule Book opens tall; tapping it again lowers the sheet to its peek.
    await nav.locator('[data-view="rules"]').click();
    await expect.poll(() => hv(page, () => window.hearthvale.app.sheet.index)).toBe(2);
    await nav.locator('[data-view="rules"]').click();
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
