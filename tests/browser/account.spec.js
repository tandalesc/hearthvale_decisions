import {test, expect} from '@playwright/test';

async function surface(page, session) {
  await page.route('**/account-test', route => route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
  await page.goto('/account-test');
  await page.evaluate(async session => { const {createAccount,mountAccount}=await import('/src/ui/account.js'); window.account=createAccount(session); mountAccount(session); }, session);
}

test('email sign-in has a focused form and a clear sent state', async ({page}) => {
  let calls=0;
  await page.route('**/api/auth/email', async route => { calls++; await new Promise(r=>setTimeout(r,100)); await route.fulfill({json:{ok:true}}); });
  await surface(page,{tier:'free',authenticated:false,billingEnabled:true});
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Email address'})).toBeFocused();
  await page.getByRole('textbox',{name:'Email address'}).fill('player@example.test');
  await page.getByRole('button',{name:'Send me a sign-in email'}).click();
  await expect(page.getByRole('button',{name:'Send me a sign-in email'})).toBeDisabled();
  await expect(page.getByRole('heading',{name:'Check your email'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'6-digit sign-in code'})).toBeFocused();
  expect(calls).toBe(1);
  await expect(page.locator('.account-foot')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeFocused();
});

test('plans require an explicit checkout confirmation and retain the chosen interval', async ({page}) => {
  const requests=[];
  await page.route('**/api/billing/checkout', async route => { requests.push(route.request().postDataJSON()); await route.fulfill({json:{url:'/account-test?checkout=started'}}); });
  await surface(page,{tier:'free',authenticated:true,billingEnabled:true,email:'player@example.test'});
  await page.evaluate(()=>window.account.open({view:'plans',notice:'You are signed in. Choose a plan when you are ready.'}));
  await expect(page.getByRole('heading',{name:'Hearthvale Plus'})).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole('button',{name:'$10 per year · save $2'}).click();
  await expect(page.getByRole('button',{name:'$10 per year · save $2'})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Continue to checkout'}).click();
  await expect.poll(()=>requests.length).toBe(1);
  expect(requests[0]).toEqual({interval:'year'});
});

test('sign-in errors are inline and a paid account offers subscription management', async ({page}) => {
  await page.route('**/api/auth/email', route=>route.fulfill({status:503,json:{error:'Please try again in a moment.'}}));
  await surface(page,{tier:'free',authenticated:false});
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('textbox',{name:'Email address'}).fill('player@example.test');
  await page.getByRole('button',{name:'Send me a sign-in email'}).click();
  await expect(page.getByRole('status')).toHaveText('Please try again in a moment.');
  await expect(page.getByRole('button',{name:'Send me a sign-in email'})).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{window.account.update({tier:'paid',authenticated:true,billingEnabled:true,email:'player@example.test'});window.account.open();});
  await expect(page.getByRole('button',{name:'Manage subscription'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue to checkout'})).toHaveCount(0);
});

test('plans fit a narrow screen and entry button participates in normal layout', async ({page}) => {
  await page.setViewportSize({width:375,height:667});
  await surface(page,{tier:'free',authenticated:false,billingEnabled:true});
  expect(await page.getByRole('button',{name:'Sign in',exact:true}).evaluate(el=>getComputedStyle(el).position)).toBe('static');
  await page.evaluate(()=>window.account.open({view:'plans'}));
  await expect(page.getByRole('button',{name:'Sign in to continue'})).toBeVisible();
  const box=await page.getByRole('dialog').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(375);
  await page.getByRole('button',{name:'Sign in to continue'}).click();
  await expect(page.getByRole('textbox',{name:'Email address'})).toBeFocused();
});

test('open account reacts to verified session changes and preserves an unchanged email form', async ({page}) => {
  await surface(page,{tier:'free',authenticated:false});
  await page.evaluate(()=>window.account.open());
  await page.getByRole('textbox',{name:'Email address'}).fill('stilltyping@example.test');
  await page.evaluate(()=>window.account.update({tier:'free',authenticated:false}));
  await expect(page.getByRole('textbox',{name:'Email address'})).toHaveValue('stilltyping@example.test');
  await page.evaluate(()=>window.account.update({tier:'free',authenticated:true,billingEnabled:true}));
  await expect(page.getByRole('button',{name:'Continue to checkout'})).toBeVisible();
  await page.evaluate(()=>window.account.update({tier:'paid',authenticated:true,billingEnabled:true}));
  await expect(page.getByRole('button',{name:'Manage subscription'})).toBeVisible();
});

test('pending checkout can refresh access and only a verified paid session reloads', async ({page}) => {
  let paid=false,checks=0;
  await page.route('**/api/session',route=>{checks++;return route.fulfill({json:{tier:paid?'paid':'free',authenticated:true}});});
  await surface(page,{tier:'free',authenticated:true,billingEnabled:true});
  await page.evaluate(()=>window.account.open({view:'plans',pendingPayment:true,notice:'Your payment is still being confirmed. Refresh access in a moment.'}));
  await expect(page.getByText('$1 billed monthly. Renews automatically. Cancel anytime.')).toBeVisible();
  await page.getByRole('button',{name:'$10 per year · save $2'}).click();
  await expect(page.getByText('$10 billed yearly. Renews automatically. Cancel anytime.')).toBeVisible();
  await page.getByRole('button',{name:'Refresh access',exact:true}).click();
  await expect(page.getByText('Your payment is still being confirmed. Give it a moment, then refresh access again.')).toBeVisible();
  expect(checks).toBe(1);
  paid=true;
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Refresh access',exact:true}).click()]);
  expect(checks).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('refreshing access preserves an unavailable checkout',async({page})=>{
  await page.route('**/api/session',route=>route.fulfill({json:{tier:'free',authenticated:true,billingEnabled:false}}));
  await surface(page,{tier:'free',authenticated:true,billingEnabled:false});
  await page.evaluate(()=>window.account.open({view:'plans',pendingPayment:true}));
  const checkout=page.getByRole('button',{name:'Continue to checkout'});
  await expect(checkout).toBeDisabled();
  await page.getByRole('button',{name:'Refresh access'}).click();
  await expect(page.getByText('Your payment is still being confirmed. Give it a moment, then refresh access again.')).toBeVisible();
  await expect(checkout).toBeDisabled();
});
