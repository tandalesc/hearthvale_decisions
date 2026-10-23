import {test, expect} from '@playwright/test';
import {open, hv} from './helpers.js';

for (const tier of ['free','paid']) test(`${tier} account flows through the real app into speed controls`,async({page})=>{
  await page.route('**/api/session',route=>route.fulfill({json:{tier,authenticated:tier==='paid',email:tier==='paid'?'player@example.test':undefined,billingEnabled:true}}));
  const errors=await open(page,{fixture:'town',query:'&simWorker=0'});
  await expect(page.locator('.topbar .account-entry')).toHaveCount(0);
  await hv(page,()=>window.hearthvale.setSpeed(5));
  const speed=page.locator('.timestrip button.speed');
  await expect(speed).toHaveText('5×');
  await speed.click();
  const menu=page.getByRole('menu',{name:'Town speed'});
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
  if(tier==='free') {
    await expect(menu.getByRole('menuitemradio',{name:'10× Plus'})).toHaveAttribute('aria-disabled','true');
    await expect(menu.getByRole('menuitemradio',{name:'20× Plus'})).toHaveAttribute('aria-disabled','true');
  }
  await menu.getByRole('menuitemradio',{name:tier==='paid'?'10×':'1×',exact:true}).click();
  await expect(speed).toHaveText(tier==='paid'?'10×':'1×');
  await expect(menu).toHaveCount(0);
  await hv(page,()=>window.hearthvale.setSpeed(0));
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('tab',{name:'Game',exact:true}).click();
  await page.locator('.settings [data-act="account"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  if(tier==='free') {
    await page.getByRole('button',{name:'Explore Hearthvale Plus'}).click();
    await expect(page.getByRole('button',{name:'$1 per month',exact:true})).toBeVisible();
  }
  else await expect(page.getByRole('button',{name:'Manage subscription'})).toBeVisible();
  expect(errors).toEqual([]);
});
