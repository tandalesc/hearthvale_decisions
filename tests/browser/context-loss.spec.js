import {test, expect} from '@playwright/test';
import {open, hv, settle} from './helpers.js';

// iOS drops the WebGL context of a backgrounded home-screen app. When it comes
// back the town must draw as before; in particular the ground, whose height
// texture otherwise uploads only changed rows into fresh (zeroed) storage and
// the whole terrain is discarded.

// Mean colour of the middle of the screen, where the valley floor is drawn.
async function sceneColour(page) {
  const png = await page.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(Math.round(img.width * 0.3), Math.round(img.height * 0.4), Math.round(img.width * 0.4), Math.round(img.height * 0.2)).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  }, png.toString('base64'));
}

test('the town draws again after the WebGL context is lost and restored', async ({page}) => {
  const errors = await open(page, {fixture: 'town', renderer: null});
  const world = () => hv(page, () => ({lost: window.hearthvale.world.internals.contextLost(), losses: window.hearthvale.world.internals.contextLosses()}));
  await page.waitForTimeout(1500);
  const before = await sceneColour(page);

  await hv(page, () => {
    const gl = document.getElementById('world').getContext('webgl2');
    window.__loseContext = gl.getExtension('WEBGL_lose_context');
    window.__loseContext.loseContext();
  });
  await expect.poll(world).toEqual({lost: true, losses: 1});
  // A building pad changes while the context is gone: its rows queue for upload.
  await hv(page, () => {
    const {ground} = window.hearthvale.world.internals;
    ground.setPad('context-loss-test', {x: 0, z: 0, w: 6, d: 6, y: ground.sample(0, 0) + 0.2});
    ground.flush();
  });
  await hv(page, () => window.__loseContext.restoreContext());
  await expect.poll(world).toEqual({lost: false, losses: 1});
  await settle(page);
  await page.waitForTimeout(1500);

  const after = await sceneColour(page);
  const distance = Math.hypot(...before.map((v, i) => v - after[i]));
  expect(distance, `scene colour before ${before.map(Math.round)} vs after ${after.map(Math.round)}`).toBeLessThan(20);
  expect(errors).toEqual([]);
});
