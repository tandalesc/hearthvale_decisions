// Behaviour of the interface: minimal start, rulings, growth and reveals,
// late-game surfaces, phone sheet, moments, settings, saves and keys.
import {test} from '@playwright/test';
import {expect, hv, open, settle} from './helpers.js';

test('a hamlet starts minimal and has no build toolbar', async ({page}) => {
  const errors = await open(page, {fixture: 'hamlet', stub: true});
  const metrics = page.locator('.metric:visible');
  await expect(metrics).toHaveCount(3);
  await expect(page.locator('.metric[data-key="people"]')).toBeVisible();
  await expect(page.locator('.metric[data-key="food"]')).toBeVisible();
  await expect(page.locator('.metric[data-key="coin"]')).toBeVisible();
  await expect(page.locator('.binder .tabstrip')).toHaveCount(0);
  await expect(page.locator('.dock .dock-btn')).toHaveCount(1);
  await expect(page.locator('.rail .rail-btn:not([data-view="fullscreen"]):not([data-view="home"])')).toHaveCount(1);
  await expect(page.locator('.binder .card:not(.is-next)')).toHaveCount(1);
  await expect(page.locator('[data-tool], .build-bar')).toHaveCount(0);
  await expect(page.locator('.feed .feed-line').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('ruling a card folds it away, spends coin and writes the chronicle', async ({page}) => {
  await open(page, {fixture: 'hamlet', stub: true});
  const before = await hv(page, () => window.hearthvale.state().stats?.coin ?? window.hearthvale.state().treasury);
  const card = page.locator('.binder .card:not(.is-next)').first();
  const title = await card.locator('.card-title').textContent();
  await card.locator('.option.is-primary').click();
  await expect(page.locator('.binder .card')).toHaveCount(0);
  await expect(page.locator('.binder .docket .empty')).toBeVisible();
  await expect(page.locator('.feed .feed-line').first()).toContainText(title.trim());
  const after = await hv(page, () => window.hearthvale.state().stats?.coin ?? window.hearthvale.state().treasury);
  expect(after).toBeLessThan(before);
});

test('the interface grows: new surfaces arrive with a reveal, a nudge and an explainer', async ({page}) => {
  await page.addInitScript(() => sessionStorage.setItem('keep-explainers', '1'));
  await page.addInitScript(() => localStorage.removeItem('hearthvale-ui-seen'));
  await open(page, {fixture: 'hamlet', stub: true});
  await hv(page, () => window.hearthvale.dev.advanceEra());
  await settle(page);
  // Village: Rule Book and People open, and wellbeing joins the top bar.
  await expect(page.locator('.rail [data-view="rules"]')).toBeVisible();
  await expect(page.locator('.rail [data-view="rules"]')).toHaveClass(/is-new/);
  await expect(page.locator('.rail [data-view="people"] .dot')).toBeVisible();
  await expect(page.locator('.metric[data-key="wellbeing"]')).toBeVisible();
  await expect(page.locator('.nudge')).toBeVisible();
  // A second body adds its crest to the dock, marked as new.
  await expect(page.locator('.dock .dock-btn')).toHaveCount(2);
  await expect(page.locator('.dock .dock-list .dock-btn').locator('.dot:not([hidden]), .badge:not(:empty)')).toBeVisible();
  await expect(page.locator('.banner').first()).toBeVisible();
  // Opening the Rule Book shows its one-time explainer, and dismissing it sticks.
  await page.locator('.rail [data-view="rules"]').click();
  await expect(page.locator('.drawer .explainer')).toContainText('Rule Book');
  await page.locator('.drawer .explainer button').click();
  await expect(page.locator('.drawer .explainer')).toHaveCount(0);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui-seen')))).toContain('explain:rules');
  await expect(page.locator('.rail [data-view="rules"] .dot')).toBeHidden();
});

test('a late-game city shows many bodies, a long Rule Book, tensions, debates and delegation', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  expect(await page.locator('.dock .dock-btn').count()).toBeGreaterThanOrEqual(8);
  // A crowded dock sinks quiet bodies below busy ones.
  const quiet = await hv(page, () => [...document.querySelectorAll('.dock-list .dock-btn')].map((b) => b.classList.contains('is-quiet')));
  expect(quiet.indexOf(true)).toBeGreaterThan(0);
  expect(quiet.slice(quiet.indexOf(true))).not.toContain(false);
  await expect(page.locator('.binder .debate').first()).toBeVisible();
  await expect(page.locator('.binder .card:not(.is-next) .chip.up').first()).toBeVisible();

  await page.locator('.rail [data-view="rules"]').click();
  expect(await page.locator('.drawer .rule').count()).toBeGreaterThanOrEqual(20);
  await page.locator('.drawer .filter[data-cat="health"]').click();
  await expect(page.locator('.drawer .rule-cat')).toHaveCount(1);
  await expect(page.locator('.drawer .chip.down').first()).toContainText('Pulls against');

  await page.locator('.rail [data-view="tensions"]').click();
  expect(await page.locator('.drawer .tension').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.drawer .tension').first()).toContainText('Nothing moves while both stand');

  await page.locator('.rail [data-view="people"]').click();
  expect(await page.locator('.drawer .faction').count()).toBeGreaterThanOrEqual(5);

  await page.locator('.dock [data-body="agri-council"]').click();
  await expect(page.locator('.binder .metric-row')).toHaveCount(4);
  await expect(page.locator('.binder .metric-row svg.spark').first()).toBeVisible();
  const sw = page.locator('.binder .delegation .switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(page.locator('.binder .view-head .chip')).toContainText('Runs its own affairs');
  expect(await hv(page, () => window.hearthvale.state().bodies?.find((b) => b.id === 'agri-council')?.delegated)).toBe(true);
  expect(errors).toEqual([]);
});

test('desktop stack: a folded card comes forward when chosen', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  const next = page.locator('.binder .card.is-next').first();
  const title = (await next.locator('.next-title').textContent()).trim();
  await next.click();
  await expect(page.locator('.binder .card:not(.is-next):not([data-leaving]) .card-title')).toHaveText(title);
  await expect(page.locator('.binder .card')).toHaveCount(3);
  await page.locator('.binder .card:not(.is-next) .details-btn').click().catch(() => {});
});

test('phone: the sheet peeks, opens to the docket with full-width options, and pages by swipe or buttons', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.sheet-peek .seg')).toBeInViewport();
  await page.locator('.sheet-nav [data-view="moot"]').click();
  await settle(page);
  expect(await hv(page, () => window.hearthvale.app.sheet.index)).toBe(2);
  await expect(page.locator('.sheet .pager .eyebrow')).toHaveText('1 of 6');
  await page.locator('.sheet .pager .next').click();
  await expect(page.locator('.sheet .pager .eyebrow')).toHaveText('2 of 6');
  const option = page.locator('.sheet .card:not(.is-next) .option').first();
  await option.scrollIntoViewIfNeeded();
  const box = await option.boundingBox();
  expect(box.width).toBeGreaterThan(390 - 80);
  expect(box.height).toBeGreaterThanOrEqual(52);
  // Drag the sheet down by its head: it snaps back to the peek.
  const head = await page.locator('.sheet-grip').boundingBox();
  await page.mouse.move(head.x + head.width / 2, head.y + 8);
  await page.mouse.down();
  await page.mouse.move(head.x + head.width / 2, head.y + 300, {steps: 6});
  await page.mouse.move(head.x + head.width / 2, head.y + 700, {steps: 3});
  await page.mouse.up();
  await settle(page);
  expect(await hv(page, () => window.hearthvale.app.sheet.index)).toBe(0);
  // Rule Book sits in the sheet's view strip on phones.
  await page.locator('.sheet-nav [data-view="rules"]').click();
  await expect(page.locator('.sheet .rulebook')).toBeVisible();
});

test('title cards hold the town at 3×, banners do not', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await hv(page, () => { window.hearthvale.setSpeed(3); window.hearthvale.dev.advanceEra(); });
  await expect(page.locator('.moment-layer')).toBeVisible();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  await expect(page.locator('.moment-layer h2')).toContainText('borough');
  // Era and body moments queue; each needs a Continue.
  for (let i = 0; i < 4 && await page.locator('.moment-layer:not(.is-leaving)').count(); i++) {
    await page.locator('.moment-layer:not(.is-leaving) .btn').click();
    await expect(page.locator('.moment-layer.is-leaving')).toHaveCount(0);
  }
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  await hv(page, () => { window.hearthvale.setSpeed(1); window.hearthvale.dev.foundBody(); });
  await settle(page);
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  await expect(page.locator('.banner')).toBeVisible();
});

test('keys: space pauses, digits set speed, C tucks the docket away, Escape closes', async ({page}) => {
  await open(page, {fixture: 'town', paused: false, stub: true});
  await page.locator('.brand').click();
  await page.keyboard.press('Space');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  await page.keyboard.press('2');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  await page.keyboard.press('3');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(8);
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(8);
  await page.locator('.rail [data-view="chronicle"]').click();
  await expect(page.locator('.drawer')).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).not.toHaveClass(/is-open/);
  await page.locator('.dock [data-body="agri-council"]').click();
  await page.keyboard.press('c');
  await expect(page.locator('.ui')).toHaveClass(/docked/);
  await expect(page.locator('.dock')).toBeVisible();
  expect(await hv(page, () => localStorage.getItem('hearthvale-ui'))).toContain('"dock":"collapsed"');
  await page.keyboard.press('c');
  await expect(page.locator('.ui')).not.toHaveClass(/docked/);
});

test('settings: display, sound, pacing and model status persist', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await page.locator('.settings-btn').click();
  await expect(page.locator('.settings')).toBeVisible();
  await page.locator('[data-pref="theme"] [data-value="night"]').click();
  expect(await hv(page, () => document.documentElement.dataset.theme)).toBe('night');
  await page.locator('[data-pref="motion"] [data-value="reduced"]').click();
  expect(await hv(page, () => document.documentElement.dataset.motion)).toBe('reduced');
  await page.locator('[data-pref="textSize"] [data-value="large"]').click();
  expect(await hv(page, () => document.documentElement.dataset.text)).toBe('large');
  await page.locator('[data-decision="mode"]').selectOption('manual');
  await page.locator('[data-decision="cap"]').fill('42');
  await page.locator('[data-decision="cap"]').dispatchEvent('change');
  await expect(page.locator('.settings .status-title')).not.toHaveText('Checking…', {timeout: 8000});
  await expect(page.locator('.decision-stats')).toContainText('Answered a second');
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings')).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  expect(await hv(page, () => document.documentElement.dataset.theme)).toBe('night');
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-decision-settings')))).toEqual({mode: 'manual', cap: 42});
  expect(errors).toEqual([]);
});

test('saves restore, and an old save starts a new town with a notice', async ({page}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('hearthvale-save', JSON.stringify({day: 40, treasury: 900, buildings: [], people: []}));
    }
  });
  await open(page, {stub: true});
  await expect(page.locator('.toast')).toContainText('earlier version');
  await page.locator('.settings-btn').click();
  await page.locator('[data-act="save"]').click();
  await expect(page.locator('.toast')).toContainText('saved');
  // Saves live in IndexedDB now; the reload below proves the round trip.
  const year = await hv(page, () => window.hearthvale.state().time.year);
  await hv(page, () => window.hearthvale.setSpeed(0));
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  expect(await hv(page, () => window.hearthvale.state().time.year)).toBe(year);
});

test('tapping a building opens the inspector', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  const point = await hv(page, () => {
    const s = window.hearthvale.state();
    const b = s.buildings.find((x) => {
      const p = window.hearthvale.screenPoint(x.x, x.z);
      return p && p.x > 120 && p.x < 900 && p.y > 140 && p.y < 700 && document.elementFromPoint(p.x, p.y)?.id === 'world';
    });
    const p = window.hearthvale.screenPoint(b.x, b.z);
    return {x: p.x, y: p.y - 4};
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.locator('.inspector h3')).not.toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.locator('.inspector')).toBeHidden();
});

test('private configuration stays blocked', async ({page}) => {
  for (const path of ['/local.env', '/%6cocal.env?raw']) {
    const res = await page.request.get(path);
    expect(res.status()).toBe(403);
  }
  const status = await page.request.get('/api/system1/status');
  expect(status.ok()).toBeTruthy();
  const body = await status.json();
  expect(body.key).toBeUndefined();
  expect(body.API_KEY).toBeUndefined();
});

test('boots with the real renderer when it is present', async ({page}) => {
  test.setTimeout(150000);
  const errors = await open(page, {fixture: 'town', renderer: null, stub: true});
  const kind = await hv(page, () => window.hearthvale.renderer);
  console.log(`renderer: ${kind}, sim: ${await hv(page, () => window.hearthvale.sim)}`);
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.binder .card').first()).toBeVisible();
  // UI errors fail the test; renderer failures fall back to the simple map.
  expect(errors.filter((e) => !/render/i.test(e))).toEqual([]);
});

test('real sim: fixtures drive the docket, bodies and Rule Book, and rulings land', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  expect(await page.locator('.dock .dock-btn').count()).toBeGreaterThanOrEqual(4);
  await page.locator('.rail [data-view="rules"]').click();
  expect(await page.locator('.drawer .rule').count()).toBeGreaterThanOrEqual(5);
  await page.keyboard.press('Escape');
  const cards = page.locator('.binder .card:not(.is-next):not([data-leaving])');
  // Bring forward a card the town can afford to rule on.
  for (let i = 0; i < 8 && await cards.count(); i++) {
    if (await cards.first().locator('.minor, .option:not([disabled])').count()) break;
    await expect(cards.first().locator('.stuck')).toBeVisible();
    if (!await page.locator('.binder .card.is-next').count()) break;
    await page.locator('.binder .card.is-next').first().click();
  }
  if (await cards.count() && await cards.first().locator('.minor, .option:not([disabled])').count()) {
    const before = await page.locator('.binder .card').count();
    const title = (await cards.first().locator('.card-title').textContent()).trim();
    const option = cards.first().locator('.minor, .option:not([disabled])').first();
    await option.click();
    await expect.poll(async () => page.locator('.binder .card:not([data-leaving]) .card-title', {hasText: title}).count()).toBe(0);
    expect(await page.locator('.binder .card:not([data-leaving])').count()).toBeLessThan(before);
  }
  await page.locator('.settings-btn').click();
  await expect(page.locator('.settings')).toBeVisible();
  expect(errors).toEqual([]);
});

test('real sim: a fresh town runs at 8× without UI errors', async ({page}) => {
  test.setTimeout(90000);
  await page.addInitScript(() => localStorage.setItem('hearthvale-ui', JSON.stringify({pauseOnSession: false, moments: 'never'})));
  const errors = await open(page, {paused: false});
  await hv(page, () => window.hearthvale.setSpeed(8));
  // Poll rather than sleep: a busy machine gives the page few frames.
  await expect.poll(() => hv(page, () => window.hearthvale.state().time.month + window.hearthvale.state().time.year * 12), {timeout: 45000}).toBeGreaterThan(2);
  await hv(page, () => window.hearthvale.setSpeed(0));
  await settle(page);
  const t = await hv(page, () => window.hearthvale.state().time);
  await expect(page.locator('.topbar .when')).toContainText(`Year ${t.year}`);
  expect(errors).toEqual([]);
});

test('docked: the binder tucks into crests, the camera reframes, and a petitioner chip announces new cards', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  const openInsets = await hv(page, () => window.hearthvale.world.insets().right);
  await page.locator('.binder .collapse-btn').click();
  await expect(page.locator('.dock')).toBeVisible();
  await expect(page.locator('.binder')).toBeHidden();
  await expect.poll(() => hv(page, () => window.hearthvale.world.insets().right)).toBeLessThan(openInsets);
  expect(await page.locator('.dock .dock-btn[data-body]').count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.dock [data-body="moot"] .badge')).toHaveText('3');
  // A new card: no panel opens and focus stays put; a chip slides out instead.
  await page.locator('.settings-btn').focus();
  await hv(page, () => window.hearthvale.dev.addCard());
  await expect(page.locator('.petition')).toBeVisible();
  await expect(page.locator('.petition')).toContainText('asks');
  await expect(page.locator('.ui')).toHaveClass(/docked/);
  expect(await hv(page, () => document.activeElement?.className)).toContain('settings-btn');
  await page.locator('.petition').click();
  await expect(page.locator('.ui')).not.toHaveClass(/docked/);
  await expect(page.locator('.binder')).toBeVisible();
  // The choice persists across reloads.
  await page.locator('.binder .collapse-btn').click();
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  await expect(page.locator('.ui')).toHaveClass(/docked/);
});

test('starting a new town asks first, then begins at year 0 with a hamlet', async ({page}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('hearthvale-ui', JSON.stringify({pauseOnSession: false, moments: 'never'})));
  await open(page, {paused: false, stub: true});
  await hv(page, () => window.hearthvale.setSpeed(8));
  await expect.poll(() => hv(page, () => window.hearthvale.state().time.year), {timeout: 20000}).toBeGreaterThan(0);
  await page.locator('.settings-btn').click();
  await page.locator('[data-act="save"]').click();
  await page.locator('.settings [data-act="new"]').click();
  await expect(page.locator('.confirm-layer')).toBeVisible();
  await expect(page.locator('.confirm-layer')).toContainText('Start a new town?');
  await page.locator('.confirm-layer [data-act="cancel"]').click();
  await expect(page.locator('.confirm-layer')).toHaveCount(0);
  expect(await hv(page, () => window.hearthvale.state().time.year)).toBeGreaterThan(0);
  await page.locator('.settings-btn').click();
  await page.locator('.settings [data-act="new"]').click();
  await Promise.all([page.waitForNavigation(), page.locator('.confirm-layer [data-act="start"]').click()]);
  await page.waitForFunction(() => window.hearthvale?.app);
  expect(await hv(page, () => window.hearthvale.state().time.year)).toBe(0);
  expect(await page.locator('.metric[data-key="people"] .metric-val').textContent()).toBe('28');
});

test('real sim: tapping a building opens the inspector with a header, a note and its reasons', async ({page}) => {
  test.setTimeout(60000);
  // Force the narrator's local fallback so the test does not need the model.
  await page.route('**/api/narrate', (route) => route.abort());
  await open(page, {fixture: 'town'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  const point = await hv(page, () => {
    const s = window.hearthvale.state();
    for (const b of s.buildings) {
      const p = window.hearthvale.screenPoint(b.x, b.z);
      if (p && p.x > 120 && p.x < 900 && p.y > 140 && p.y < 700 && document.elementFromPoint(p.x, p.y)?.id === 'world') return {x: p.x, y: p.y - 4};
    }
    return null;
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.locator('.inspector h3')).not.toBeEmpty();
  await expect(page.locator('.inspector .note-text')).not.toBeEmpty({timeout: 15000});
  await expect(page.locator('.inspector .note')).not.toHaveClass(/is-waiting/);
  await page.locator('.inspector .why summary').click();
  expect(await page.locator('.inspector .why li').count()).toBeGreaterThan(0);
});

for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
  test(`the docket tucks away at ${width}×${height}, stays tucked after a reload, and the scene reframes`, async ({page}) => {
    await page.setViewportSize({width, height});
    await open(page, {fixture: 'town', stub: true});
    await expect(page.locator('.binder')).toBeVisible();
    const before = await hv(page, () => window.hearthvale.world.insets().right);
    await page.locator('.binder .collapse-btn').click();
    await expect(page.locator('.dock')).toBeVisible();
    await expect.poll(() => hv(page, () => window.hearthvale.world.insets().right)).toBeLessThan(before - 200);
    await page.reload();
    await page.waitForFunction(() => window.hearthvale?.app);
    await settle(page);
    await expect(page.locator('.ui')).toHaveClass(/docked/);
    await expect(page.locator('.binder')).toBeHidden();
    const after = await hv(page, () => window.hearthvale.world.insets().right);
    expect(after).toBeLessThan(90);
    // Resizing does not undo the choice.
    await page.setViewportSize({width: 900, height: 700});
    await settle(page);
    await expect(page.locator('.ui')).toHaveClass(/docked/);
  });
}

test('H hides every layer and brings it back; F toggles full screen where supported', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await page.keyboard.press('h');
  await expect(page.locator('.ui')).toHaveClass(/clean/);
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.clean-hint')).toBeVisible();
  expect(await hv(page, () => window.hearthvale.world.insets())).toEqual({top: 0, right: 0, bottom: 0, left: 0});
  await page.keyboard.press('h');
  await expect(page.locator('.ui')).not.toHaveClass(/clean/);
  await expect(page.locator('.topbar')).toBeVisible();
  expect(await hv(page, () => window.hearthvale.world.insets().top)).toBeGreaterThan(40);
  const supported = await hv(page, () => Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled));
  await expect(page.locator('.rail [data-view="fullscreen"]')).toHaveCount(supported ? 1 : 0);
  if (supported) {
    await page.keyboard.press('f');
    await expect.poll(() => hv(page, () => Boolean(document.fullscreenElement))).toBe(true);
    await page.keyboard.press('f');
    await expect.poll(() => hv(page, () => Boolean(document.fullscreenElement))).toBe(false);
  }
});

test('standing orders can be added and removed, and a body can be dissolved after a confirm', async ({page}) => {
  await open(page, {fixture: 'city', stub: true});
  await page.locator('.dock [data-body="agri-council"]').click();
  const orders = page.locator('.binder .orders');
  await orders.scrollIntoViewIfNeeded();
  await orders.locator('[data-f="action"]').selectOption('approve');
  await orders.locator('[data-f="cap"]').selectOption('400');
  await orders.locator('[data-add]').click();
  await expect(orders.locator('.order')).toHaveCount(1);
  await expect(orders.locator('.order')).toContainText('up to 400 coin');
  await orders.locator('.order [data-remove]').click();
  await expect(orders.locator('.order')).toHaveCount(0);
  await page.locator('.binder .dissolve-btn').click();
  await expect(page.locator('.confirm-layer')).toContainText('Dissolve');
  await page.locator('.confirm-layer [data-act="dissolve"]').click();
  await expect(page.locator('.dock [data-body="agri-council"]')).toHaveCount(0);
  await expect(page.locator('.dock [data-body="moot"]')).toHaveAttribute('aria-pressed', 'true');
});

test('places: a second centre opens the Places view, a camera chip, and ward council crests', async ({page}) => {
  await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.rail [data-view="places"]')).toBeVisible();
  await expect(page.locator('.topbar .here-chip')).toBeVisible();
  await expect(page.locator('.dock [data-body="ward:c2"]')).toHaveAttribute('data-tip', /Millbridge/);
  await page.locator('.topbar .here-chip').click();
  await expect(page.locator('.drawer .place')).toHaveCount(3);
  await expect(page.locator('.drawer .place').first()).toContainText('The seat');
  await page.locator('.drawer .place[data-centre="c2"] [data-body]').click();
  await expect(page.locator('.dock [data-body="ward:c2"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.drawer .place[data-centre="c3"] [data-go]').click();
  await expect.poll(() => page.locator('.topbar .here-chip').textContent(), {timeout: 5000}).toContain('Eastbank');
});

test('world name labels hide in clean view and behind title cards and dialogs', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await hv(page, () => {
    window.__labels = [];
    window.hearthvale.world.setLabelsVisible = (on) => window.__labels.push(on);
    window.hearthvale.app.refresh();
  });
  const last = () => hv(page, () => window.__labels.at(-1));
  expect(await last()).toBe(true);
  await page.keyboard.press('h');
  expect(await last()).toBe(false);
  await page.keyboard.press('h');
  expect(await last()).toBe(true);
  await page.locator('.settings-btn').click();
  await expect.poll(last).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(last).toBe(true);
  await hv(page, () => { window.hearthvale.setSpeed(3); window.hearthvale.dev.advanceEra(); });
  await expect(page.locator('.moment-layer')).toBeVisible();
  expect(await last()).toBe(false);
  for (let i = 0; i < 4 && await page.locator('.moment-layer:not(.is-leaving)').count(); i++) {
    await page.locator('.moment-layer:not(.is-leaving) .btn').click();
    await expect(page.locator('.moment-layer.is-leaving')).toHaveCount(0);
  }
  await expect.poll(last).toBe(true);
  // The label layer never sits over the panels or takes a click.
  const z = await hv(page, () => {
    const l = document.createElement('div');
    l.className = 'hv-centre-labels';
    document.body.append(l);
    const cs = getComputedStyle(l);
    return {pe: cs.pointerEvents, z: Number(cs.zIndex), ui: Number(getComputedStyle(document.querySelector('.ui')).zIndex)};
  });
  expect(z.pe).toBe('none');
  expect(z.z).toBeLessThan(z.ui);
});

test('places draw a growth line only with a history; chronicle lines name their place and filter by it', async ({page}) => {
  await open(page, {fixture: 'city', stub: true});
  await page.locator('.rail [data-view="places"]').click();
  await expect(page.locator('.drawer .place[data-centre="c2"] svg.spark')).toHaveCount(1);
  // Eastbank has no population history yet: nothing, not an empty frame.
  await expect(page.locator('.drawer .place[data-centre="c3"] svg.spark')).toHaveCount(0);
  await page.locator('.rail [data-view="chronicle"]').click();
  const tag = page.locator('.drawer .entry', {hasText: 'covered market'}).locator('.place-tag');
  await expect(tag).toHaveText('Millbridge');
  await expect(page.locator('.drawer .chronicle .filter')).toHaveCount(4);
  await page.locator('.drawer .chronicle .filter[data-place="c3"]').click();
  await expect(page.locator('.drawer .entry')).toHaveCount(1);
  await expect(page.locator('.drawer .entry')).toContainText('pear trees');
  await expect(page.locator('.drawer .entry .place-tag')).toHaveCount(0);
  await page.locator('.drawer .chronicle .filter[data-place="all"]').click();
  expect(await page.locator('.drawer .entry').count()).toBeGreaterThan(5);
});
