// Shared helpers for the browser tests. Most tests use the stub renderer
// (?renderer=stub) so layout checks are fast and deterministic; one smoke
// test boots the real renderer.
import {expect} from '@playwright/test';

export const VIEWPORTS = [[1440, 900], [1164, 703], [1024, 600], [768, 1024], [390, 844], [320, 568], [844, 390]];

export async function open(page, {fixture, paused = true, renderer = 'stub', stub = false, query = ''} = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Other agents edit files while tests run; keep Vite's HMR socket quiet so
  // the page is not reloaded under a test.
  await page.routeWebSocket(/.*/, () => {});
  await page.addInitScript(() => {
    localStorage.setItem('hearthvale-model-enabled', 'false');
    // Explainers are one-time notes; mark them seen unless a test wants them.
    if (!sessionStorage.getItem('keep-explainers')) localStorage.setItem('hearthvale-ui-seen', JSON.stringify(['explain:docket', 'explain:rules', 'explain:people', 'explain:chronicle', 'explain:tensions', 'explain:overlays', 'explain:council']));
  });
  const params = new URLSearchParams();
  if (fixture) params.set('fixture', fixture);
  if (paused) params.set('paused', '1');
  if (renderer) params.set('renderer', renderer);
  if (stub) params.set('stub', '1');
  // play=1 skips the main menu and goes straight to the town.
  params.set('play', '1');
  await page.goto(`/?${params}${query}`);
  await page.waitForFunction(() => window.hearthvale?.app);
  await settle(page);
  return errors;
}

export async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(450);
}

export const hv = (page, fn, arg) => page.evaluate(fn, arg);

// Rects of the visible fixed regions, for overlap and bounds checks.
export async function regionIssues(page) {
  return page.evaluate(() => {
    const layout = document.querySelector('.ui').dataset.layout;
    const selectors = ['.topbar', '.rail', '.timestrip', '.dk', '.dock', '.notice-stack', '.sheet'];
    const rects = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.hidden) continue;
      // The Council in the phone sheet is part of the sheet.
      if (sel === '.dk' && layout === 'phone') continue;
      let r = el.getBoundingClientRect();
      if (sel === '.sheet') r = {x: r.x, y: r.y, right: r.right, bottom: Math.min(r.bottom, innerHeight), width: r.width, height: innerHeight - r.y};
      if (sel === '.notice-stack') {
        const lines = [...el.querySelectorAll('.notice')].filter((c) => getComputedStyle(c).display !== 'none');
        if (!lines.length) continue;
        const rs = lines.map((l) => l.getBoundingClientRect());
        r = {x: Math.min(...rs.map((q) => q.x)), y: Math.min(...rs.map((q) => q.y)), right: Math.max(...rs.map((q) => q.right)), bottom: Math.max(...rs.map((q) => q.bottom))};
      }
      if (!r.right || !r.bottom) continue;
      rects.push({sel, x: r.x, y: r.y, right: r.right, bottom: r.bottom});
    }
    const issues = [];
    for (const r of rects) {
      if (r.x < -0.5 || r.y < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) issues.push(`${r.sel} outside viewport`);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) issues.push(`${a.sel} overlaps ${b.sel}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('page scrolls sideways');
    // Top bar: the name, the numbers and the settings button never touch.
    const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth && getComputedStyle(e).display !== 'none').map((e) => e.getBoundingClientRect());
    const brand = shown('.brand h1, .brand .date > *'), metrics = shown('.metric'), end = shown('.topbar-end');
    if (metrics.length && brand.length && Math.max(...brand.map((r) => r.right)) > Math.min(...metrics.map((r) => r.left)) + 0.5) issues.push('top bar name runs into the numbers');
    if (metrics.length && end.length && Math.max(...metrics.map((r) => r.right)) > end[0].left + 0.5) issues.push('top bar numbers run into settings');
    for (const el of document.querySelectorAll('.metric, .brand h1, .era-progress .label, .date-chip, .sheet-nav, .dock')) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right > innerWidth + 0.5) issues.push(`${el.className} past the edge`);
    }
    return issues;
  });
}

// Every visible, enabled button in the chrome is at least 44×44.
export async function smallTargets(page) {
  return page.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll('.ui button')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || cs.visibility === 'hidden' || el.closest('[hidden]') || el.disabled) continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (el.closest('.explainer')) continue; // close button has an enlarged hit area via ::after
      // These have hit areas enlarged by ::before / ::after.
      if (el.classList.contains('switch') || el.classList.contains('filter') || el.classList.contains('sheet-grip') || el.classList.contains('here-chip')) continue;
      if (r.width < 43.5 || r.height < 43.5) small.push(`${el.className || el.tagName} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return small;
  });
}

export {expect};
