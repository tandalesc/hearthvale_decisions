// Approval (from Borough): the top bar's metric on desktop and phone, the
// People view's Approval section (figure, chart, reasons, breakdowns), and the
// year-end notice's line. Real sim on the city fixture.
import {test} from '@playwright/test';
import {expect, hv, open, regionIssues, settle, smallTargets} from './helpers.js';

const metricBox = (page, key) => page.locator(`.topbar .metric[data-key="${key}"]`).boundingBox();
// A few years on, headless (no walkers), so the chart and the reasons fill in.
const years = (page, n) => hv(page, async (k) => {
  const sim = await import('/src/sim/index.js');
  sim.fastForward(window.hearthvale.state(), k);
  window.hearthvale.app.refresh();
}, n);

test('desktop: Approval sits after Wellbeing and opens People at its section', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await years(page, 2);
  await settle(page);
  // The town's news pills are not what this checks.
  await hv(page, () => window.hearthvale.app.notices.dismissAll());
  await settle(page);
  const metric = page.locator('.topbar .metric[data-key="approval"]');
  await expect(metric).toBeVisible();
  const want = await hv(page, () => Math.round(window.hearthvale.state().approval.overall * 100));
  await expect(metric.locator('.metric-val')).toHaveText(`${want}%`);
  await expect(metric.locator('.metric-cap')).toHaveText(/this year|approve/);
  await expect(metric).toHaveAttribute('aria-label', new RegExp(`^Approval ${want}%`));
  // Right after Wellbeing, and at least 44 px.
  const [well, ap] = [await metricBox(page, 'wellbeing'), await metricBox(page, 'approval')];
  expect(ap.x).toBeGreaterThan(well.x);
  expect(ap.width).toBeGreaterThanOrEqual(44);
  expect(ap.height).toBeGreaterThanOrEqual(44);
  expect(await regionIssues(page)).toEqual([]);

  await metric.click();
  await settle(page);
  await expect(page.locator('.drawer.is-open .people')).toBeVisible();
  const section = page.locator('.drawer .approval');
  await expect(section).toBeVisible();
  await expect(section.locator('.ap-value')).toHaveText(`${want}%`);
  // Scrolled into view, clear of the drawer's close button.
  const head = await section.locator('.section-head').boundingBox();
  const close = await page.locator('.drawer .panel-head').boundingBox();
  const drawer = await page.locator('.drawer .panel-body').boundingBox();
  expect(head.y).toBeGreaterThanOrEqual(close.y + close.height - 1);
  expect(head.y + head.height).toBeLessThanOrEqual(drawer.y + drawer.height);
  // Its history, why it moved, and the groups.
  await expect(section.locator('.hchart svg path.line')).toHaveCount(1);
  await expect(section.locator('.hchart-to')).toHaveText(/^Year \d+$/);
  const drivers = await hv(page, () => window.hearthvale.state().approval.drivers.length);
  if (drivers) await expect(section.locator('.ap-why li')).toHaveCount(drivers);
  else await expect(section.locator('.ap-why .ap-empty')).toBeVisible();
  await expect(section.locator('.ap-tabs .filter[aria-pressed="true"]')).toHaveText('Groups');
  expect(await section.locator('.ap-row').count()).toBeGreaterThanOrEqual(3);
  // Another breakdown.
  await section.locator('.ap-tabs .filter', {hasText: 'Wealth'}).click();
  await expect(section.locator('.ap-tabs .filter[aria-pressed="true"]')).toHaveText('Wealth');
  expect((await section.locator('.ap-name').allInnerTexts()).sort()).toEqual(['Middling', 'Poor', 'Wealthy']);
  await section.locator('.ap-tabs .filter', {hasText: 'Districts'}).click();
  expect(await section.locator('.ap-row').count()).toBeLessThanOrEqual(8);
  // Each group in town shows its figure beside its mood.
  expect(await page.locator('.drawer .faction .faction-approval').count()).toBeGreaterThanOrEqual(3);
  await hv(page, () => window.hearthvale.app.notices.dismissAll());
  await settle(page);
  expect(await smallTargets(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the year-end notice says where approval stands', async ({page}) => {
  const errors = await open(page, {fixture: 'city'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  await years(page, 1);
  await settle(page);
  const notice = page.locator('.notice-major[data-key="year"]');
  await expect(notice).toBeVisible();
  const top = await hv(page, () => {
    const s = window.hearthvale.state(), h = s.approval.history;
    return {v: Math.round(s.approval.overall * 100), d: Math.round(s.approval.overall * 100) - Math.round(h.at(-2).all * 100)};
  });
  const change = top.d === 0 ? '±0' : `${top.d > 0 ? '+' : '−'}${Math.abs(top.d)}`;
  await expect(notice.locator('.notice-body')).toContainText(`Approval ${top.v}% (${change}).`);
  // It opens People at Approval.
  await notice.locator('.notice-main').click();
  await settle(page);
  await expect(page.locator('.drawer .approval')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [width, height] of [[390, 844], [320, 568]]) {
  test(`phone ${width}: Approval takes Wellbeing's place in the top bar and opens the People tab`, async ({page}) => {
    await page.setViewportSize({width, height});
    const errors = await open(page, {fixture: 'city'});
    test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
    expect(await hv(page, () => window.hearthvale.app.layout)).toBe('phone');
    await years(page, 1);
    await settle(page);
    await hv(page, () => window.hearthvale.app.notices.dismissAll());
    await settle(page);
    const metric = page.locator('.topbar .metric[data-key="approval"]');
    await expect(metric).toBeVisible();
    await expect(page.locator('.topbar .metric[data-key="wellbeing"]')).toBeHidden();
    // The date chip, four numbers and settings, apart and in reach.
    const shown = await hv(page, () => [...document.querySelectorAll('.topbar .date-chip, .topbar .metric, .topbar-end')]
      .filter((e) => e.offsetWidth && getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return {key: e.dataset.key ?? e.className, left: r.left, right: r.right, w: r.width, h: r.height}; }));
    expect(shown.map((s) => s.key).filter((k) => !k.includes('date-chip') && !k.includes('topbar-end'))).toEqual(['people', 'food', 'coin', 'approval']);
    for (let i = 1; i < shown.length; i++) expect(shown[i].left, `${shown[i - 1].key} / ${shown[i].key}`).toBeGreaterThanOrEqual(shown[i - 1].right - 0.5);
    for (const s of shown) expect(Math.min(s.w, s.h), s.key).toBeGreaterThanOrEqual(43.5);
    expect(await regionIssues(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);

    await metric.click();
    await settle(page);
    await expect(page.locator('.sheet .people')).toBeVisible();
    const section = page.locator('.sheet .approval');
    await expect(section).toBeVisible();
    const box = await section.locator('.ap-value').boundingBox();
    const sheet = await page.locator('.sheet .panel-body').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(sheet.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(sheet.y + sheet.height);
    await expect(section.locator('.hchart')).toBeVisible();
    // The breakdown rows fit the width; the tabs scroll sideways inside their row.
    const rows = await section.locator('.ap-row').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    for (const r of rows) expect(r).toBeLessThanOrEqual(width + 0.5);
    expect(await hv(page, () => document.documentElement.scrollWidth)).toBe(width);
    expect(await smallTargets(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('before Borough there is no Approval metric or section', async ({page}) => {
  const errors = await open(page, {fixture: 'town'});
  test.skip(await hv(page, () => window.hearthvale.sim) !== 'real', 'real sim not present');
  expect(await hv(page, () => window.hearthvale.state().era)).toBeLessThan(3);
  await expect(page.locator('.topbar .metric[data-key="approval"]')).toBeHidden();
  await page.locator('.topbar .metric[data-key="wellbeing"]').click();
  await settle(page);
  await expect(page.locator('.drawer .people')).toBeVisible();
  await expect(page.locator('.drawer .approval')).toBeHidden();
  await expect(page.locator('.drawer .faction-approval')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reaching Borough brings the metric in with a reveal and a "New: Approval" nudge that opens it', async ({page}) => {
  const errors = await open(page, {fixture: 'town', stub: true});
  while (await hv(page, () => window.hearthvale.state().era) < 2) await hv(page, () => window.hearthvale.dev.advanceEra());
  await settle(page);
  await expect(page.locator('.topbar .metric[data-key="approval"]')).toBeHidden();
  // Borough brings several nudges at once and the stack keeps two: note them all.
  await hv(page, () => {
    const n = window.hearthvale.app.notices, nudge = n.nudge;
    window.__nudges = [];
    n.nudge = (text, opts) => { window.__nudges.push({text, opts}); return nudge(text, opts); };
  });
  await hv(page, () => window.hearthvale.dev.advanceEra());
  await settle(page);
  await expect(page.locator('.topbar .metric[data-key="approval"]')).toBeVisible();
  await expect(page.locator('.topbar .metric[data-key="approval"]')).toHaveClass(/is-new/);
  expect(await hv(page, () => window.__nudges.map((x) => x.text))).toContain('New: Approval');
  // Its click opens People at Approval.
  await hv(page, () => window.__nudges.find((x) => x.text === 'New: Approval').opts.onClick());
  await settle(page);
  await expect(page.locator('.drawer .approval')).toBeVisible();
  expect(errors).toEqual([]);
});

test('stub sim: the Approval section renders from the stub view at Borough', async ({page}) => {
  const errors = await open(page, {fixture: 'city', stub: true});
  await expect(page.locator('.topbar .metric[data-key="approval"]')).toBeVisible();
  await page.locator('.topbar .metric[data-key="approval"]').click();
  await settle(page);
  await expect(page.locator('.drawer .approval .ap-why li')).toHaveCount(3);
  expect(errors).toEqual([]);
});
