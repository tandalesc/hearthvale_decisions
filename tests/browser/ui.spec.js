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
  await expect(page.locator('.dock .dock-btn')).toHaveCount(1);
  await expect(page.locator('.rail .rail-btn')).toHaveCount(1);
  await expect(page.locator('[data-tool], .build-bar')).toHaveCount(0);
  // The Council opens with the one waiting card.
  await page.keyboard.press('c');
  await expect(page.locator('.dk .card:not(.is-next)')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dk')).toBeHidden();
  expect(errors).toEqual([]);
});

test('ruling a card folds it away, spends coin and writes the chronicle', async ({page}) => {
  await open(page, {fixture: 'hamlet', stub: true});
  const before = await hv(page, async () => { const s = await window.hearthvale.snapshot(); return s.stats?.coin ?? s.treasury; });
  await hv(page, () => window.hearthvale.app.openDocket());
  await settle(page);
  const card = page.locator('.dk .card:not(.is-next)').first();
  const title = await card.locator('.card-title').textContent();
  await card.locator('.option.is-primary').click();
  await expect(page.locator('.dk .card')).toHaveCount(0);
  await expect(page.locator('.dk .docket .empty')).toBeVisible();
  // The ruling passes through the notice stack as a happening.
  await expect(page.locator('.notice-minor', {hasText: title.trim()})).toBeAttached();
  const after = await hv(page, async () => { const s = await window.hearthvale.snapshot(); return s.stats?.coin ?? s.treasury; });
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
  await expect(page.locator('.notice-major').first()).toBeVisible();
  // A second body joins the Council: its crest is marked as new.
  await expect(page.locator('.dock .dock-btn')).toHaveCount(1);
  await expect(page.locator('.dock [data-body="council"]').locator('.dot:not([hidden]), .badge:not(:empty)')).toBeVisible();
  // Opening the Rule Book shows its one-time explainer, and dismissing it sticks.
  await page.locator('.rail [data-view="rules"]').click();
  await expect(page.locator('.drawer .explainer')).toContainText('Rule Book');
  await page.locator('.drawer .explainer button').click();
  await expect(page.locator('.drawer .explainer')).toHaveCount(0);
  expect(await hv(page, () => JSON.parse(localStorage.getItem('hearthvale-ui-seen')))).toContain('explain:rules');
  await expect(page.locator('.rail [data-view="rules"] .dot')).toBeHidden();
});

test('a late-game city shows many bodies, a long Rule Book, tensions and debates', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  await hv(page, () => window.hearthvale.app.openDocket());
  await settle(page);
  expect(await page.locator('.dk-index [data-page]').count()).toBeGreaterThanOrEqual(8);
  // A crowded list puts busy bodies (with requests) above quiet ones.
  const counted = await hv(page, () => [...document.querySelectorAll('.dk-index [data-page]:not([data-page="moot"])')].map((b) => Boolean(b.querySelector('.dk-filter-count'))));
  expect(counted.slice(counted.indexOf(false))).not.toContain(true);
  await expect(page.locator('.dk .card:not(.is-next) .chip.up').first()).toBeVisible();
  // Debates show the town's lean per side, not a for-and-against strip.
  await page.locator('.dk .card.is-next[data-kind="debate"]').first().click();
  await expect(page.locator('.dk .card:not(.is-next):not([data-leaving]) .opinion .op-row').first()).toBeVisible();
  await expect(page.locator('.dk .debate')).toHaveCount(0);
  await page.locator('.dk-close').click();
  await expect(page.locator('.dk')).toBeHidden();

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

  await hv(page, () => window.hearthvale.app.openView('agri-council'));
  await expect(page.locator('.dk-page .metric-row')).toHaveCount(4);
  await expect(page.locator('.dk-page .metric-row svg.spark').first()).toBeVisible();
  // Delegation and standing orders wait for the advisors' work.
  await expect(page.locator('.dk-page .delegation, .dk-page .orders')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('desktop stack: a folded card comes forward when chosen', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await hv(page, () => window.hearthvale.app.openDocket());
  await settle(page);
  const next = page.locator('.dk .card.is-next').first();
  const title = (await next.locator('.next-title').textContent()).trim();
  await next.click();
  await expect(page.locator('.dk .card:not(.is-next):not([data-leaving]) .card-title')).toHaveText(title);
  await expect(page.locator('.dk .card')).toHaveCount(3);
  await page.locator('.dk .card:not(.is-next) .details-btn').click().catch(() => {});
});

test('cards show a town feeling bar and verdict; tapping it lists the factions', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await hv(page, () => window.hearthvale.app.openDocket());
  await settle(page);
  const open1 = page.locator('.dk .card:not(.is-next):not([data-leaving])');
  const row = open1.locator('.opinion .op-row').first();
  await expect(row).toBeVisible();
  await expect(row.locator('.op-verdict')).toHaveText(/^(Popular|Divisive|Unpopular|Indifferent)$/);
  await expect(row.locator('.op-bar .op-for')).toHaveCount(1);
  await expect(open1.locator('.op-detail')).toBeHidden();
  await open1.locator('.op-head').click();
  await expect(open1.locator('.op-detail')).toBeVisible();
  expect(await open1.locator('.op-detail li').count()).toBeGreaterThanOrEqual(3);
  await expect(open1.locator('.op-head')).toHaveAttribute('aria-expanded', 'true');
  // A card whose factions have not answered yet shows a muted forming state.
  await page.locator('.dk .card.is-next[data-kind="petition"]').click();
  await expect(open1.locator('.op-row')).toHaveAttribute('data-verdict', 'forming');
  await expect(open1.locator('.op-verdict')).toHaveText('Opinion forming…');
  expect(errors).toEqual([]);
});

test('real sim: proposals read the town from the factions\' stances (offline fallback)', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await hv(page, () => window.hearthvale.app.openDocket());
  await settle(page);
  const card = page.locator('.dk .card:not(.is-next):not([data-leaving])').first();
  await expect(card.locator('.opinion .op-row').first()).toBeVisible();
  await expect(card.locator('.op-verdict').first()).toHaveText(/^(Popular|Divisive|Unpopular|Indifferent|Opinion forming…)$/);
  await card.locator('.op-head').click();
  expect(await card.locator('.op-detail li').count()).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('phone: the sheet peeks, opens to the Council with full-width options, and pages by swipe or buttons', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.sheet-peek .seg')).toBeInViewport();
  // The Council opens tall in the sheet, the time controls above it: one card at a time, paged.
  await page.locator('.sheet-nav [data-view="council"]').click();
  await settle(page);
  expect(await hv(page, () => window.hearthvale.app.sheet.index)).toBe(2);
  await expect(page.locator('.sheet-peek .seg')).toBeInViewport();
  await expect(page.locator('.dk .pager .eyebrow')).toHaveText('1 of 6');
  await page.locator('.dk .pager .next').click();
  await expect(page.locator('.dk .pager .eyebrow')).toHaveText('2 of 6');
  const option = page.locator('.dk .card:not(.is-next) .option').first();
  await option.scrollIntoViewIfNeeded();
  const box = await option.boundingBox();
  expect(box.width).toBeGreaterThan(390 - 80);
  expect(box.height).toBeGreaterThanOrEqual(52);
  // Drag the raised sheet down by its head: it snaps back to the peek.
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
    await page.locator('.moment-layer:not(.is-leaving) .moment-go').click();
    await expect(page.locator('.moment-layer.is-leaving')).toHaveCount(0);
  }
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  await hv(page, () => { window.hearthvale.setSpeed(1); window.hearthvale.dev.foundBody(); });
  await settle(page);
  await expect(page.locator('.moment-layer')).toHaveCount(0);
  await expect(page.locator('.notice-major').first()).toBeVisible();
});

test('keys: space pauses, digits set speed, C opens and closes the Council, Escape closes', async ({page}) => {
  await open(page, {fixture: 'town', paused: false, stub: true});
  await page.locator('.brand').click();
  await page.keyboard.press('Space');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  await page.keyboard.press('2');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
  await page.keyboard.press('3');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(5);
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(5);
  await page.locator('.rail [data-view="chronicle"]').click();
  await expect(page.locator('.drawer')).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).not.toHaveClass(/is-open/);
  await page.keyboard.press('c');
  await expect(page.locator('.dk')).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.locator('.dk')).toBeHidden();
  await page.keyboard.press('d');
  await expect(page.locator('.dk')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dk')).toBeHidden();
});

test('speed popup selects each paid speed beside pause and keyboard shortcuts still work', async ({page}) => {
  await page.route('**/api/session', route => route.fulfill({json: {tier: 'paid', authenticated: true, email: 'player@example.test', billingEnabled: true}}));
  await open(page, {fixture: 'town', paused: false, stub: true});
  const seg = page.locator('.timestrip .seg');
  await expect(seg.locator('button')).toHaveCount(2);
  const speed = seg.locator('.speed');
  await expect(speed).toHaveText('1×');
  for (const value of [3, 5, 10, 20, 1]) {
    await speed.click();
    await page.getByRole('menu', {name: 'Town speed'}).getByRole('menuitemradio', {name: `${value}×`, exact: true}).click();
    expect(await hv(page, () => window.hearthvale.speed())).toBe(value);
    await expect(speed).toHaveText(`${value}×`);
  }
  await page.keyboard.press('5');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(20);
  await page.keyboard.press('4');
  expect(await hv(page, () => window.hearthvale.speed())).toBe(10);
  await page.keyboard.press('1');
  await seg.locator('.pause').click();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  await expect(speed).toHaveText('1×');
  await speed.click();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(0);
  await page.getByRole('menuitemradio', {name: '3×', exact: true}).click();
  expect(await hv(page, () => window.hearthvale.speed())).toBe(3);
});

test('settings: display and accessibility persist, with the student shown under Game', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  await page.locator('.settings-btn').click();
  await expect(page.locator('.settings')).toBeVisible();
  await page.locator('.settings [role="tab"][data-tab="display"]').click();
  await page.locator('[data-pref="theme"] [data-value="night"]').click();
  expect(await hv(page, () => document.documentElement.dataset.theme)).toBe('night');
  await page.locator('.settings [role="tab"][data-tab="access"]').click();
  await page.locator('[data-pref="motion"] [data-value="reduced"]').click();
  expect(await hv(page, () => document.documentElement.dataset.motion)).toBe('reduced');
  await page.locator('[data-pref="textSize"] [data-value="large"]').click();
  expect(await hv(page, () => document.documentElement.dataset.text)).toBe('large');
  await page.locator('.settings [role="tab"][data-tab="game"]').click();
  await expect(page.locator('.model-ver')).toBeVisible();
  await expect(page.locator('.settings [data-act="menu"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings')).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  expect(await hv(page, () => document.documentElement.dataset.theme)).toBe('night');
  expect(await hv(page, () => document.documentElement.dataset.text)).toBe('large');
  await page.locator('.settings-btn').click();
  await page.locator('.settings [role="tab"][data-tab="access"]').click();
  await expect(page.locator('[data-pref="motion"] [data-value="reduced"]')).toHaveAttribute('aria-checked', 'true');
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
  const year = await hv(page, async () => (await window.hearthvale.snapshot()).time.year);
  await hv(page, () => window.hearthvale.setSpeed(0));
  await page.reload();
  await page.waitForFunction(() => window.hearthvale?.app);
  expect(await hv(page, async () => (await window.hearthvale.snapshot()).time.year)).toBe(year);
});

test('tapping a building opens the inspector', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  const point = await hv(page, async () => {
    const s = await window.hearthvale.snapshot();
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
  await expect(page.locator('.dock [data-body="council"]')).toBeVisible();
  // UI errors fail the test; renderer failures fall back to the simple map.
  expect(errors.filter((e) => !/render/i.test(e))).toEqual([]);
});

test('real renderer: Battery saver lowers pixels and Auto detail, and draws only some frames', async ({page}) => {
  test.setTimeout(150000);
  await page.addInitScript(() => {
    localStorage.removeItem('hearthvale-quality');
    // An unplugged laptop at half charge, as Chrome's Battery API reports it.
    Object.defineProperty(navigator, 'getBattery', {configurable: true, value: () => Promise.resolve({charging: false, level: 0.5, addEventListener() {}})});
  });
  const errors = await open(page, {fixture: 'town', renderer: null, stub: true, paused: false});
  test.skip(await hv(page, () => window.hearthvale.renderer) !== 'real', 'real renderer not present');
  const before = await hv(page, () => ({tier: window.hearthvale.world.quality(), ...window.hearthvale.world.power()}));
  expect(before).toMatchObject({mode: 'off', saving: false, unplugged: true, batteryKnown: true});
  // 'On battery' engages at once, with a quiet note.
  await hv(page, () => window.hearthvale.world.setBatterySaver('battery'));
  await expect(page.locator('.toast', {hasText: 'On battery'})).toBeVisible();
  const down = {high: 'medium', medium: 'low', low: 'low'};
  const after = await hv(page, () => ({tier: window.hearthvale.world.quality(), pixelRatio: window.hearthvale.world.internals.renderer.getPixelRatio(), ...window.hearthvale.world.power()}));
  expect(after.saving).toBe(true);
  expect(after.tier).toBe(down[before.tier]);
  expect(after.pixelRatio).toBeLessThanOrEqual(1.25);
  // Watching (no input for over a second): at most 30 drawn frames a second,
  // and the loop skips its sim step and drawing on the other animation frames.
  await page.waitForTimeout(1500);
  const rate = await hv(page, () => new Promise((resolve) => {
    const w = window.hearthvale.world;
    const update = w.update;
    let draws = 0, ticks = 0;
    w.update = (...args) => { draws++; return update(...args); };
    const t0 = performance.now();
    const step = () => {
      ticks++;
      if (performance.now() - t0 < 2000) requestAnimationFrame(step);
      else { w.update = update; resolve({draws: draws / 2, ticks: ticks / 2}); }
    };
    requestAnimationFrame(step);
  }));
  console.log(`saver: ${rate.draws} drawn / ${rate.ticks} animation frames a second`);
  expect(rate.draws).toBeLessThanOrEqual(32);
  if (rate.ticks > 45) expect(rate.draws).toBeLessThan(rate.ticks * 0.75);
  await hv(page, () => window.hearthvale.world.setBatterySaver('off'));
  expect(await hv(page, () => window.hearthvale.world.quality())).toBe(before.tier);
  expect(errors.filter((e) => !/render/i.test(e))).toEqual([]);
});

test('real sim: fixtures drive the docket, bodies and Rule Book, and rulings land', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await hv(page, () => window.hearthvale.app.openCouncil());
  expect(await page.locator('.dk-index [data-page]').count()).toBeGreaterThanOrEqual(4);
  await hv(page, () => window.hearthvale.app.council.close());
  await page.locator('.rail [data-view="rules"]').click();
  await expect.poll(() => page.locator('.drawer .rule').count()).toBeGreaterThanOrEqual(5);
  await page.keyboard.press('Escape');
  await hv(page, () => window.hearthvale.app.openDocket());
  await settle(page);
  const cards = page.locator('.dk .card:not(.is-next):not([data-leaving])');
  // Bring forward a card the town can afford to rule on.
  for (let i = 0; i < 8 && await cards.count(); i++) {
    if (await cards.first().locator('.minor, .option:not([disabled])').count()) break;
    await expect(cards.first().locator('.stuck')).toBeVisible();
    if (!await page.locator('.dk .card.is-next').count()) break;
    await page.locator('.dk .card.is-next').first().click();
  }
  if (await cards.count() && await cards.first().locator('.minor, .option:not([disabled])').count()) {
    const before = await page.locator('.dk .card').count();
    // Follow the card by id: two cards can share a title ("Which first?").
    const label = await cards.first().getAttribute('aria-labelledby');
    const option = cards.first().locator('.minor, .option:not([disabled])').first();
    await option.click();
    await expect.poll(async () => page.locator(`.dk .card:not([data-leaving])[aria-labelledby="${label}"]`).count()).toBe(0);
    expect(await page.locator('.dk .card:not([data-leaving])').count()).toBeLessThan(before);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.dk')).toBeHidden();
  await page.locator('.settings-btn').click();
  await expect(page.locator('.settings')).toBeVisible();
  expect(errors).toEqual([]);
});

test('real sim: a fresh town runs at 5× without UI errors', async ({page}) => {
  test.setTimeout(90000);
  await page.addInitScript(() => localStorage.setItem('hearthvale-ui', JSON.stringify({moments: 'never'})));
  const errors = await open(page, {paused: false});
  await hv(page, () => window.hearthvale.setSpeed(5));
  // Poll rather than sleep: a busy machine gives the page few frames.
  await expect.poll(() => hv(page, async () => { const t = (await window.hearthvale.snapshot()).time; return t.month + t.year * 12; }), {timeout: 45000}).toBeGreaterThan(2);
  await hv(page, () => window.hearthvale.setSpeed(0));
  await settle(page);
  const t = await hv(page, async () => (await window.hearthvale.snapshot()).time);
  await expect(page.locator('.topbar .when')).toContainText(`Year ${t.year}`);
  expect(errors).toEqual([]);
});

test('a new card opens nothing and keeps focus; the Council stays where the player left it', async ({page}) => {
  await open(page, {fixture: 'town', stub: true});
  await expect(page.locator('.dock [data-body="council"] .badge')).toHaveText('3');
  await page.locator('.settings-btn').focus();
  await hv(page, () => window.hearthvale.dev.addCard());
  await expect(page.locator('.notice-major[data-key="request"]')).toBeVisible();
  await expect(page.locator('.dk')).toBeHidden();
  expect(await hv(page, () => document.activeElement?.className)).toContain('settings-btn');
  await expect(page.locator('.dock [data-body="council"] .badge')).toHaveText('4');
});

test('town management lives on the main menu rather than in Settings', async ({page}) => {
  await open(page, {stub: true});
  await page.locator('.settings-btn').click();
  const settings = page.locator('.settings');
  await expect(settings.locator('[data-act="new"], [data-act="seed-town"], [data-act="export"], [data-act="import"]')).toHaveCount(0);
  await expect(settings).not.toContainText('Your other towns wait on the main menu.');
  await settings.locator('[data-act="save"]').click();
  await Promise.all([page.waitForNavigation(), settings.locator('[data-act="menu"]').click()]);
  await expect(page.locator('.mm')).toBeVisible();
  await expect(page.locator('.mm [data-act="import"]')).toHaveCount(0);
  await page.locator('.mm [data-go="play"]').click();
  await page.locator('.mm [data-go="towns"]').click();
  await expect(page.locator('.mm [data-act="export"]')).toBeVisible();
  await page.locator('.mm .mm-back').click();
  await expect(page.locator('.mm')).toHaveAttribute('data-screen','play');
  await page.locator('.mm [data-go="new"]').click();
  await expect(page.locator('#mm-seed')).toBeVisible();
});

test('real sim: tapping a building opens the inspector with a header, a note and its reasons', async ({page}) => {
  test.setTimeout(60000);
  // Force the narrator's local fallback so the test does not need the model.
  await page.route('**/api/narrate', (route) => route.abort());
  await open(page, {fixture: 'town'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  const point = await hv(page, async () => {
    const s = await window.hearthvale.snapshot();
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
  // Locate, Why and Refresh share one actions row at the foot.
  const row = page.locator('.inspector .inspector-actions');
  await expect(row.locator('[data-act="locate"]')).toBeVisible();
  await expect(row.locator('[data-act="refresh"]')).toBeVisible();
  await row.locator('[data-act="why"]').click();
  await expect(row.locator('[data-act="why"]')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.locator('.inspector .why li').count()).toBeGreaterThan(0);
});

for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
  test(`at ${width}×${height} the Council sits beside the dock, capped in width, and the scene does not reframe`, async ({page}) => {
    await page.setViewportSize({width, height});
    await open(page, {fixture: 'town', stub: true});
    const before = await hv(page, () => JSON.stringify(window.hearthvale.world.insets()));
    await hv(page, () => window.hearthvale.app.openCouncil());
    await settle(page);
    const r = await hv(page, () => {
      const b = (s) => document.querySelector(s).getBoundingClientRect();
      return {dk: b('.dk'), dock: b('.dock')};
    });
    expect(r.dk.width).toBeLessThanOrEqual(1400);
    expect(r.dock.left - r.dk.right).toBeLessThan(20);
    expect(await hv(page, () => JSON.stringify(window.hearthvale.world.insets()))).toBe(before);
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
  // No full-screen tile on the rail; the F key still does it.
  await expect(page.locator('.rail [data-view="fullscreen"]')).toHaveCount(0);
  if (supported) {
    await page.keyboard.press('f');
    await expect.poll(() => hv(page, () => Boolean(document.fullscreenElement))).toBe(true);
    await page.keyboard.press('f');
    await expect.poll(() => hv(page, () => Boolean(document.fullscreenElement))).toBe(false);
  }
});

test('a body can be dissolved after a confirm, and the Council goes back to the Town Council', async ({page}) => {
  await open(page, {fixture: 'city', stub: true});
  await hv(page, () => window.hearthvale.app.openView('agri-council'));
  await expect(page.locator('.dk-page .orders')).toHaveCount(0);
  await page.locator('.dk-page .dissolve-btn').click();
  await expect(page.locator('.confirm-layer')).toContainText('Dissolve');
  await page.locator('.confirm-layer [data-act="dissolve"]').click();
  await expect(page.locator('.dk-index [data-page="agri-council"]')).toHaveCount(0);
  await expect(page.locator('.dk-index [data-page="moot"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#dk-title')).toHaveText('Town Council');
});

test('places: a second centre opens the Places view, a camera chip, and ward council pages', async ({page}) => {
  await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.rail [data-view="places"]')).toBeVisible();
  await expect(page.locator('.topbar .here-chip')).toBeVisible();
  await page.locator('.topbar .here-chip').click();
  await expect(page.locator('.drawer .place')).toHaveCount(3);
  await expect(page.locator('.drawer .place').first()).toContainText('The seat');
  await page.locator('.drawer .place[data-centre="c2"] [data-body]').click();
  // A ward council's page opens in the Council, named for its place.
  await expect(page.locator('.dk-index [data-page="ward:c2"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.dk-index [data-page="ward:c2"]')).toHaveAttribute('title', /Millbridge/);
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
    await page.locator('.moment-layer:not(.is-leaving) .moment-go').click();
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
