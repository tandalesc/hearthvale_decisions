import {test,expect} from '@playwright/test';

async function session(page,value) {
  await page.routeWebSocket(/.*/,()=>{});
  await page.route('**/api/session',route=>route.fulfill({json:value}));
}

test('sign-in belongs to the main menu and Escape preserves the underlying screen',async({page})=>{
  await session(page,{tier:'free',authenticated:false,billingEnabled:true});
  await page.goto('/?renderer=stub');
  const menu=page.locator('.mm');
  await expect(menu.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await expect(menu.locator('.mm-head [data-act="account"]')).toHaveCount(0);
  await expect(menu.locator('.mm-foot .mm-account')).toBeVisible();
  await menu.locator('[data-go="play"]').click();
  await menu.getByRole('button',{name:/New town/}).click();
  await menu.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Sign in with email'})).toBeVisible();
  await expect(page.locator('.account-eyebrow')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menu).toHaveAttribute('data-screen','new');
  await expect(menu.getByRole('button',{name:'Sign in',exact:true})).toBeFocused();
});

test('email return restores selected plan without starting checkout',async({page})=>{
  await session(page,{tier:'free',authenticated:true,email:'player@example.test',billingEnabled:true});
  await page.addInitScript(()=>localStorage.setItem('hearthvale.plan','year'));
  let checkouts=0;
  await page.route('**/api/billing/checkout',route=>{checkouts++;return route.fulfill({json:{url:'/?checkout=mock'}});});
  await page.goto('/?signin=success&renderer=stub');
  await expect(page.getByRole('dialog',{name:'Hearthvale Plus'})).toBeVisible();
  await expect(page.getByRole('button',{name:'$10 per year · save $2'})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByText('You’re signed in. Your town saves stay on this device.')).toBeVisible();
  expect(checkouts).toBe(0);
  expect(new URL(page.url()).searchParams.has('signin')).toBe(false);
});

test('checkout success URL cannot grant paid access while confirmation is pending',async({page})=>{
  await session(page,{tier:'free',authenticated:true,email:'player@example.test',billingEnabled:true});
  await page.goto('/?billing=success&renderer=stub');
  await expect(page.getByText('Your payment is still being confirmed. Refresh access in a moment.')).toBeVisible({timeout:12000});
  await expect(page.getByRole('button',{name:'Refresh access'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Manage subscription'})).toHaveCount(0);
  await expect(page.locator('.mm-account-tier')).toBeHidden();
});

test('verified paid checkout return shows account management',async({page})=>{
  await session(page,{tier:'paid',authenticated:true,email:'player@example.test',billingEnabled:true});
  await page.goto('/?billing=success&renderer=stub');
  await expect(page.getByRole('button',{name:'Manage subscription'})).toBeVisible();
  await expect(page.getByText('Welcome to Hearthvale Plus. Thank you for supporting the town.')).toBeVisible();
  await expect(page.locator('.mm-account-tier')).toHaveText('Hearthvale Plus');
  await expect(page.locator('.mm-account')).toHaveText('Manage account');
  await page.keyboard.press('Escape');
  const tier = page.getByRole('button', {name: 'Hearthvale Plus', exact: true});
  await tier.click();
  await expect(page.getByText('Your current tier: Hearthvale Plus.')).toBeVisible();
  await expect(page.locator('.account-features li')).toHaveText(['10× and 20× speed', 'Live decisions for your townspeople', 'Richer writing in the Council and town notes']);
  await expect(page.getByRole('button', {name: 'Manage subscription'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Continue to checkout'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(tier).toBeFocused();
});

test('email code resumes after app reload and signs in within the same browser', async ({page}) => {
  await page.setViewportSize({width:375,height:740});
  let signedIn=false, emails=0;const attempts=[];const challenge='c'.repeat(64);
  await page.routeWebSocket(/.*/,()=>{});
  await page.route('**/api/session',route=>route.fulfill({json:{tier:'free',authenticated:signedIn,...(signedIn?{email:'player@example.test'}:{}),billingEnabled:true}}));
  await page.route('**/api/auth/email',route=>{emails++;return route.fulfill({json:{ok:true,challenge}});});
  await page.route('**/api/auth/code',route=>{
    const body=route.request().postDataJSON();attempts.push(body);
    if(body.code!=='012345')return route.fulfill({status:400,json:{error:'Invalid or expired code. Check the code or request a new email.'}});
    signedIn=true;return route.fulfill({json:{ok:true}});
  });
  await page.goto('/?renderer=stub');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('textbox',{name:'Email address'}).fill('player@example.test');
  await page.getByRole('button',{name:'Send me a sign-in email'}).click();
  let code=page.getByRole('textbox',{name:'6-digit sign-in code'});
  await expect(code).toBeFocused();await expect(code).toHaveAttribute('autocomplete','one-time-code');
  await code.fill('999999');
  await page.getByRole('dialog').getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Invalid or expired code.');
  await page.reload();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  code=page.getByRole('textbox',{name:'6-digit sign-in code'});
  await expect(code).toBeVisible();
  await code.fill('012 345');await expect(code).toHaveValue('012345');
  await page.getByRole('dialog').getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Continue to checkout'})).toBeVisible();
  await expect(page.getByText('You’re signed in. Your town saves stay on this device.')).toBeVisible();
  expect(attempts).toEqual([{challenge,code:'999999'},{challenge,code:'012345'}]);expect(emails).toBe(1);
  expect(await page.evaluate(()=>localStorage.getItem('hearthvale.pending-signin'))).toBeNull();
  await expect(page.locator('.mm-account')).toHaveText('Manage account');
});


test('existing email code can be entered without sending another email', async ({page}) => {
  await session(page,{tier:'free',authenticated:false,billingEnabled:true});
  let emails=0,body;
  await page.route('**/api/auth/email',route=>{emails++;return route.fulfill({json:{ok:true}});});
  await page.route('**/api/auth/code',route=>{body=route.request().postDataJSON();return route.fulfill({status:400,json:{error:'Invalid or expired code. Check the code or request a new email.'}});});
  await page.goto('/?renderer=stub');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('textbox',{name:'Email address'}).fill('player@example.test');
  await page.getByRole('button',{name:'I already have a code'}).click();
  await page.getByRole('textbox',{name:'6-digit sign-in code'}).fill('012345');
  await page.getByRole('dialog').getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Invalid or expired code.');
  expect(body).toEqual({email:'player@example.test',code:'012345'});expect(emails).toBe(0);
});
