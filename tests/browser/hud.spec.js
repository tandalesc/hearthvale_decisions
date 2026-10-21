// The HUD: the Council panel (every body in one place), the Rule Book
// drawer, the notice stack at the top left, the inspector's actions row,
// dismissable notices and title cards, and the tabbed settings.
import {test} from '@playwright/test';
import {expect, hv, open, settle} from './helpers.js';

const box = (page, sel) => hv(page, (s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return r && {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height};
}, sel);
const insets = (page) => hv(page, () => JSON.stringify(window.hearthvale.world.insets?.() ?? null));

test('the Council opens as a HUD panel from its crest: not a dialog, the time strip in reach, Esc closes it', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true, paused: false});
  await hv(page, () => window.hearthvale.setSpeed(3));
  // The dock holds one crest: the Council.
  await expect(page.locator('.dock .crest-btn')).toHaveCount(1);
  const crest = page.locator('.dock [data-body="council"]');
  const frame = await insets(page);
  await crest.click();
  const panel = page.locator('.dk');
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('role', 'dialog');
  await expect(page.locator('.dk-layer')).toHaveCount(0);
  await expect(crest).toHaveAttribute('aria-pressed', 'true');
  // Most of the main area: between the rail and the dock, above the time strip.
  await settle(page);
  const r = await box(page, '.dk');
  const rail = await box(page, '.rail');
  const dock = await box(page, '.dock');
  const strip = await box(page, '.timestrip');
  expect(r.x).toBeGreaterThanOrEqual(rail.right);
  expect(r.right).toBeLessThanOrEqual(dock.x);
  expect(r.bottom).toBeLessThanOrEqual(strip.y);
  expect(r.width / 1440).toBeGreaterThan(0.8);
  // The town keeps its pace while it is open, and the strip's pause button still works.
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  await page.locator('.timestrip .seg .pause').click();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  await page.locator('.timestrip .seg .pause').click();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  // Every waiting card on the Town Council page: one open, the rest folded.
  await expect(page.locator('#dk-title')).toHaveText('Town Council');
  const want = await hv(page, async () => (await window.hearthvale.snapshot()).docket.length);
  await expect(page.locator('.dk .card:not([data-leaving])')).toHaveCount(want);
  await expect(page.locator('.dk .card:not(.is-next)')).toHaveCount(1);
  // Rules are the Rule Book's: none in the Council, on any page.
  await expect(page.locator('.dk .rule, .dk .dk-rules, .dk .body-rules')).toHaveCount(0);
  // How the factions feel lives in the People view, not here.
  await expect(page.locator('.dk .dk-faction, .dk .dk-feel')).toHaveCount(0);
  // Opening it never moved the camera.
  expect(await insets(page)).toBe(frame);
  await page.locator('.brand').click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(crest).toHaveAttribute('aria-pressed', 'false');
  expect(await insets(page)).toBe(frame);
  expect(errors).toEqual([]);
});

test('C toggles the Council; the bodies down its side switch pages; area chips filter; rulings land from inside', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  await page.locator('.brand').click();
  await page.keyboard.press('c');
  await expect(page.locator('.dk')).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.locator('.dk')).toBeHidden();
  await page.keyboard.press('C');
  await expect(page.locator('.dk')).toBeVisible();
  // Every body sits in the Council's list, after the Town Council.
  const bodies = await hv(page, () => window.hearthvale.app.root.querySelectorAll('.dk-index [data-page]').length);
  expect(bodies).toBeGreaterThanOrEqual(5);
  await expect(page.locator('.dk-index [data-page]').first()).toHaveAttribute('data-page', 'moot');
  // A body's page: its own cards, its dashboard and rules beside them.
  const id = await page.locator('.dk-index [data-page]:not([data-page="moot"])').first().getAttribute('data-page');
  await page.locator(`.dk-index [data-page="${id}"]`).click();
  await expect(page.locator(`.dk-index [data-page="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#dk-title')).toHaveText(await page.locator(`.dk-index [data-page="${id}"]`).getAttribute('title'));
  await expect(page.locator(`.dk-page .body-view[data-body="${id}"]`)).toBeVisible();
  await expect.poll(() => hv(page, async (b) => {
    const docket = (await window.hearthvale.snapshot()).docket;
    return [...document.querySelectorAll('.dk .card[data-id]:not([data-leaving])')]
      .every((c) => { const card = docket.find((x) => x.id === c.dataset.id); return card?.from === b || card?.sides?.includes?.(b); });
  }, id)).toBe(true);
  await page.locator('.dk-index [data-page="moot"]').click();
  const total = await hv(page, async () => (await window.hearthvale.snapshot()).docket.length);
  await expect(page.locator('.dk .card:not([data-leaving])')).toHaveCount(total);
  // By area: only that area's cards, and its rules beside them.
  const chip = page.locator('.dk-areas [data-area]:not([data-area="all"])').first();
  if (await chip.count()) {
    const cat = await chip.getAttribute('data-area');
    await chip.click();
    await expect.poll(() => hv(page, async (k) => {
      const want = (await window.hearthvale.snapshot()).docket.filter((c) => c.category === k).map((c) => c.id);
      const shown = [...document.querySelectorAll('.dk .card[data-id]:not([data-leaving])')].map((c) => c.dataset.id);
      return shown.length === want.length && shown.every((x) => want.includes(x));
    }, cat)).toBe(true);
    await page.locator('.dk-areas [data-area="all"]').click();
  }
  // Rule on the open card from inside: it leaves, the next comes up.
  const card = page.locator('.dk .card:not(.is-next):not([data-leaving])').first();
  const cid = await card.getAttribute('data-id');
  await card.locator('.option:not([disabled]), .minor').first().click();
  await expect.poll(() => hv(page, async (c) => (await window.hearthvale.snapshot()).docket.some((x) => x.id === c), cid)).toBe(false);
  await expect(page.locator('.dk .card:not([data-leaving])')).toHaveCount(total - 1);
  // A card's "The rules" link opens the Rule Book drawer beside the Council.
  await page.locator('.dk .card:not(.is-next):not([data-leaving]) .rules-btn').first().click();
  await expect(page.locator('.drawer')).toHaveClass(/is-open/);
  await expect(page.locator('.drawer .rulebook')).toBeVisible();
  const d = await box(page, '.drawer');
  const p = await box(page, '.dk');
  expect(p.x).toBeGreaterThanOrEqual(d.right);
  expect(errors).toEqual([]);
});

test('new requests linger in the notice stack and open the Council at that card; happenings fade', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await page.locator('.settings-btn').focus();
  await hv(page, () => window.hearthvale.dev.addCard());
  const note = page.locator('.notice-major[data-key="request"]');
  await expect(note).toBeVisible();
  await expect(note.locator('.notice-eyebrow')).toContainText('asks');
  const newest = await hv(page, async () => (await window.hearthvale.snapshot()).docket.at(-1).id);
  await note.locator('.notice-main').click();
  await expect(page.locator('.dk')).toBeVisible();
  await expect(page.locator(`.dk .card:not(.is-next)[data-id="${newest}"]`)).toBeVisible();
  // With the Council open, a new card simply joins it: no notice.
  await hv(page, () => window.hearthvale.dev.addCard());
  await settle(page);
  await expect(page.locator('.notice-major[data-key="request"]')).toHaveCount(0);
  await page.locator('.brand').click();
  await page.keyboard.press('Escape');
  // A happening passes through as a light note and is gone in a few seconds.
  await hv(page, () => window.hearthvale.app.notices.minor({text: 'The bakers took on an apprentice.'}));
  const line = page.locator('.notice-minor', {hasText: 'apprentice'});
  await expect(line).toBeVisible();
  await page.mouse.move(700, 450);
  await expect(line).toHaveCount(0, {timeout: 9000});
});

test('the town keeps running in the Council, even with an old save that asked to pause', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('hearthvale-ui', JSON.stringify({pauseOnDocket: true})));
  await open(page, {fixture: 'city', stub: true, paused: false});
  await page.locator('.dock [data-body="council"]').click();
  await expect(page.locator('.dk')).toBeVisible();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(1);
});

test('phone: the Council is one tab in the sheet, its bodies a strip of chips, the time controls in reach', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await open(page, {fixture: 'city', stub: true});
  // One tab for every body.
  await expect(page.locator('.sheet-nav [data-view="council"]')).toHaveCount(1);
  await expect(page.locator('.sheet-nav [data-view="agri-council"], .sheet-nav [data-view="docket"]')).toHaveCount(0);
  await page.locator('.sheet-nav [data-view="council"]').click();
  await expect.poll(() => hv(page, () => document.querySelector('.ui').dataset.sheet)).toBe('2');
  await expect(page.locator('.sheet .dk .pager')).toBeVisible();
  await expect(page.locator('.sheet .dk-index')).toBeVisible();
  const peek = await box(page, '.sheet-peek .seg .pause');
  expect(peek.y).toBeGreaterThan(0);
  expect(peek.bottom).toBeLessThan(844);
  expect(await hv(page, () => document.documentElement.scrollWidth)).toBe(390);
  // A body chip opens its page in place.
  const id = await page.locator('.sheet .dk-index [data-page]:not([data-page="moot"])').first().getAttribute('data-page');
  await page.locator(`.sheet .dk-index [data-page="${id}"]`).click();
  await expect(page.locator(`.sheet .dk-page .body-view[data-body="${id}"]`)).toBeAttached();
});

test('the Rule Book is the drawer listing; R toggles it; body pages list no rules', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  const tile = page.locator('.rail [data-view="rules"]');
  await tile.click();
  await expect(page.locator('.drawer')).toHaveClass(/is-open/);
  await expect(page.locator('.drawer .rulebook')).toBeVisible();
  expect(await page.locator('.drawer .rule').count()).toBeGreaterThanOrEqual(20);
  await tile.click();
  await expect(page.locator('.drawer')).not.toHaveClass(/is-open/);
  await page.locator('.brand').click();
  await page.keyboard.press('r');
  await expect(page.locator('.drawer .rulebook')).toBeVisible();
  await page.keyboard.press('r');
  await expect(page.locator('.drawer')).not.toHaveClass(/is-open/);
  await hv(page, () => window.hearthvale.app.openView('agri-council'));
  await expect(page.locator('.dk-page .body-view')).toBeVisible();
  await expect(page.locator('.dk-page .rule, .dk-page .book-open')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the notice stack sits at the top left beside the rail, under the top bar; on phones it spans the width', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await hv(page, () => {
    window.hearthvale.app.notices.major({key: 'test', title: 'A test notice', ms: 30000});
    window.hearthvale.app.notices.minor({text: 'A test happening.'});
  });
  let s = await box(page, '.notice-stack');
  const rail = await box(page, '.rail');
  const top = await box(page, '.topbar');
  expect(s.x).toBeGreaterThanOrEqual(rail.right);
  expect(s.x - rail.right).toBeLessThan(30);
  expect(s.y).toBeGreaterThanOrEqual(top.bottom);
  // The majors sit above the happenings.
  const major = await box(page, '.notice-major');
  const minor = await box(page, '.notice-minor');
  expect(major.bottom).toBeLessThanOrEqual(minor.y);
  // An open drawer moves it aside.
  await page.locator('.rail [data-view="chronicle"]').click();
  await settle(page);
  s = await box(page, '.notice-stack');
  expect(s.x).toBeGreaterThanOrEqual((await box(page, '.drawer')).right);
  // Phone: full width under the top bar.
  await page.setViewportSize({width: 390, height: 844});
  await settle(page);
  s = await box(page, '.notice-stack');
  expect(Math.round(s.x)).toBeLessThanOrEqual(12);
  expect(Math.round(390 - s.right)).toBeLessThanOrEqual(12);
  expect(s.y).toBeGreaterThanOrEqual((await box(page, '.topbar')).bottom);
  expect(errors).toEqual([]);
});

test('inspector: one actions row at the foot with 44 px targets', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await hv(page, async () => window.hearthvale.app.inspector.show({buildingId: (await window.hearthvale.snapshot()).buildings[0].id}));
  const row = page.locator('.inspector .inspector-actions');
  await expect(row).toBeVisible();
  await settle(page);
  await expect(row).toHaveAttribute('role', 'toolbar');
  const locate = row.locator('[data-act="locate"]');
  await expect(locate).toBeVisible();
  // The row is the last thing in the popup, and nothing else holds actions.
  expect(await hv(page, () => document.querySelector('.inspector').lastElementChild.classList.contains('inspector-actions'))).toBe(true);
  await expect(page.locator('.inspector header .locate, .inspector .note-stale, .inspector details.why')).toHaveCount(0);
  for (const b of await row.locator('button:visible').all()) {
    const r = await b.boundingBox();
    expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.width).toBeGreaterThanOrEqual(44);
  }
  // Locate moves the camera to the building.
  const before = await hv(page, () => window.hearthvale.world.cameraTarget?.() ?? null);
  await locate.click();
  await page.waitForTimeout(900);
  const after = await hv(page, () => window.hearthvale.world.cameraTarget?.() ?? null);
  if (before && after) expect(after).not.toEqual(before);
  // People get Follow instead of Locate when the renderer can follow; either way one row.
  await hv(page, async () => window.hearthvale.app.inspector.show({personId: (await window.hearthvale.snapshot()).people[0].id}));
  await settle(page);
  const canFollow = await hv(page, () => typeof window.hearthvale.world.follow === 'function');
  await expect(row.locator('[data-act="follow"]')).toBeVisible({visible: canFollow});
  await expect(row.locator('[data-act="locate"]')).toBeVisible({visible: !canFollow});
  const tops = await row.locator('button:visible').evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  expect(errors).toEqual([]);
});

test('toasts and notices have a close control, hold while hovered, and Esc or a swipe puts them away', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await hv(page, () => window.hearthvale.app.notices.toast('A test toast.', 1500));
  const toast = page.locator('.toast', {hasText: 'A test toast.'});
  await expect(toast).toBeVisible();
  const close = toast.locator('.notice-close');
  await expect(close).toHaveAttribute('aria-label', 'Dismiss');
  const r = await close.boundingBox();
  expect(r.width).toBeGreaterThanOrEqual(44);
  expect(r.height).toBeGreaterThanOrEqual(44);
  // Hovering holds it past its time.
  await toast.hover();
  await page.waitForTimeout(2200);
  await expect(toast).toBeVisible();
  await close.click();
  await expect(toast).toHaveCount(0);
  // Toasts sit apart from the notice stack (top centre of the scene).
  await hv(page, () => window.hearthvale.app.notices.toast('Second toast.', 10000));
  const t = await box(page, '.toast');
  const strip = await box(page, '.timestrip');
  expect(t.bottom).toBeLessThan(strip.y - 200);
  // Esc with nothing else open puts notices away.
  await page.locator('.brand').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.toast')).toHaveCount(0);
  // Banners (a year's end) close too.
  await hv(page, () => window.hearthvale.app.notices.banner('Year 9 ends', 'A quiet year.', {ms: 20000, key: 'year'}));
  const banner = page.locator('.notice-major[data-key="year"]');
  await expect(banner).toBeVisible();
  await banner.locator('.notice-close').click();
  await expect(banner).toHaveCount(0);
  // A sideways swipe on touch dismisses a toast.
  await hv(page, () => window.hearthvale.app.notices.toast('Swipe me.', 10000));
  await expect(page.locator('.toast')).toBeVisible();
  await hv(page, () => {
    const el = document.querySelector('.toast');
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, {bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y}));
    ev('pointerdown', r.left + 20);
    for (let i = 1; i <= 6; i++) ev('pointermove', r.left + 20 + i * 25);
    ev('pointerup', r.left + 170);
  });
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('title cards: close button, Esc and the backdrop dismiss them; skip clears a queue; the town resumes', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await hv(page, () => { window.hearthvale.setSpeed(3); window.hearthvale.dev.advanceEra(); });
  const layer = page.locator('.moment-layer:not(.is-leaving)');
  await expect(layer).toBeVisible();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  const close = layer.locator('.moment-close');
  await expect(close).toHaveAttribute('aria-label', 'Close');
  // Several cards queued: the skip link clears them all in one go.
  const skip = layer.locator('.moment-skip');
  if (await skip.isVisible()) {
    await skip.click();
  } else {
    await close.click();
  }
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  // What the card said stays in the chronicle.
  expect(await hv(page, async () => (await window.hearthvale.snapshot()).chronicle.some((e) => /borough|first time/i.test(e.text)))).toBe(true);

  // Esc closes one.
  await hv(page, () => window.hearthvale.dev.foundBody());
  await expect(layer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  // A click on the backdrop closes one, but not in its first moments.
  await hv(page, () => window.hearthvale.dev.foundBody());
  await expect(layer).toBeVisible();
  await page.mouse.click(40, 450);
  await expect(layer).toBeVisible();
  await page.waitForTimeout(800);
  await page.mouse.click(40, 450);
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  expect(errors).toEqual([]);
});

test('settings: ARIA tabs, arrow keys, and the last tab is remembered', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await page.locator('.settings-btn').click();
  const tabs = page.locator('.settings [role="tablist"] [role="tab"]');
  await expect(tabs).toHaveCount(5);
  await expect(tabs).toHaveText(['Game', 'Display', 'Sound', 'Accessibility', 'Decision model']);
  // Focus lands on the selected tab; only it is in the tab order.
  await expect.poll(() => hv(page, () => document.activeElement?.dataset.tab)).toBe('game');
  expect(await tabs.evaluateAll((els) => els.map((e) => e.tabIndex))).toEqual([0, -1, -1, -1, -1]);
  await expect(page.locator('#set-panel-game')).toBeVisible();
  await expect(page.locator('#set-panel-game')).toHaveAttribute('aria-labelledby', 'set-tab-game');
  await expect(page.locator('#set-tab-game')).toHaveAttribute('aria-controls', 'set-panel-game');
  await expect(page.locator('#set-panel-display')).toBeHidden();
  // Arrows move and open; Home and End jump; it wraps around.
  await page.keyboard.press('ArrowRight');
  expect(await hv(page, () => document.activeElement?.dataset.tab)).toBe('display');
  await expect(page.locator('#set-tab-display')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#set-panel-display')).toBeVisible();
  await expect(page.locator('#set-panel-game')).toBeHidden();
  await page.keyboard.press('End');
  expect(await hv(page, () => document.activeElement?.dataset.tab)).toBe('model');
  await page.keyboard.press('ArrowRight');
  expect(await hv(page, () => document.activeElement?.dataset.tab)).toBe('game');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await hv(page, () => document.activeElement?.dataset.tab)).toBe('access');
  await expect(page.locator('[data-pref="motion"]')).toBeVisible();
  // Every setting lives on exactly one tab.
  for (const [tab, sel] of [['game', '[data-act="save"]'], ['display', '[data-pref="quality"]'], ['display', '[data-pref="batterySaver"]'], ['display', '.perf-stats'], ['sound', '[data-range="master"]'], ['access', '[data-pref="textSize"]'], ['model', '[data-decision="mode"]']]) {
    expect(await hv(page, (s) => document.querySelector(s)?.closest('[role="tabpanel"]')?.dataset.panel, sel), sel).toBe(tab);
  }
  // Closed and opened again (and after a reload), the last tab comes back.
  await page.keyboard.press('Escape');
  await page.locator('.settings-btn').click();
  await expect(page.locator('#set-tab-access')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  await page.locator('.settings-btn').click();
  await expect(page.locator('#set-tab-access')).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('settings: Battery saver is Off by default, reaches the world and is remembered', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await page.locator('.settings-btn').click();
  await page.locator('#set-tab-display').click();
  const saver = page.locator('[data-pref="batterySaver"]');
  await expect(saver.locator('[role="radio"]')).toHaveText(['Off', 'On battery', 'Always']);
  await expect(saver.locator('[data-value="off"]')).toHaveAttribute('aria-checked', 'true');
  expect(await hv(page, () => window.hearthvale.world.power().mode)).toBe('off');
  // The stub reports no battery, as Safari and Firefox don't: the hint says so.
  await expect(page.locator('.field', {has: saver})).toContainText("can't tell when you're unplugged");
  await saver.locator('[data-value="always"]').click();
  await expect(saver.locator('[data-value="always"]')).toHaveAttribute('aria-checked', 'true');
  await expect(saver.locator('[data-value="off"]')).toHaveAttribute('aria-checked', 'false');
  expect(await hv(page, () => window.hearthvale.world.power())).toMatchObject({mode: 'always', saving: true});
  await expect(page.locator('.perf-stats')).toContainText('Saving');
  // Choosing Always is not news: no battery toast.
  await expect(page.locator('.toast', {hasText: /battery/i})).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  expect(await hv(page, () => window.hearthvale.world.power().mode)).toBe('always');
  await page.locator('.settings-btn').click();
  await expect(page.locator('[data-pref="batterySaver"] [data-value="always"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-pref="batterySaver"] [data-value="battery"]').click();
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui')).batterySaver)).toBe('battery');
  expect(await hv(page, () => window.hearthvale.world.power())).toMatchObject({mode: 'battery', saving: false});
  expect(errors).toEqual([]);
});

test('phone: settings tabs scroll sideways inside the sheet without widening the page', async ({page}) => {
  await page.setViewportSize({width: 320, height: 568});
  await open(page, {fixture: 'town', stub: true});
  await page.locator('.settings-btn').click();
  const card = await box(page, '.settings-card');
  expect(card.right).toBeLessThanOrEqual(320.5);
  await expect(page.locator('.settings .close')).toBeInViewport();
  await page.locator('#set-tab-model').click();
  await expect(page.locator('#set-tab-model')).toBeInViewport();
  expect(await hv(page, () => document.documentElement.scrollWidth)).toBe(320);
});
