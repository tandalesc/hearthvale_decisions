// Explicit live-mode provisioning: creates prices, a portal, and a webhook.
// It never charges a card or creates a subscription, and never prints secrets.
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const file=name=>new URL('cloudflare/'+name,root);
const read=name=>fs.existsSync(file(name))?parseEnv(fs.readFileSync(file(name),'utf8')):{};
const existing=read('.dev.vars'), input=read('.dev.vars.live-key');
const key=input.STRIPE_SECRET_KEY;
assert.ok(/^(sk|rk)_live_/.test(key||''), 'Put a Stripe live secret key in cloudflare/.dev.vars.live-key first.');
const stateFile=file('.dev.vars.live-state.json');
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
const save=()=>{fs.writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});fs.chmodSync(stateFile,0o600);};
async function stripe(path,body,idempotencyKey) {
 const response=await fetch('https://api.stripe.com/v1/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key,...(body?{'content-type':'application/x-www-form-urlencoded'}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},...(body?{body:new URLSearchParams(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!response.ok)throw new Error('Stripe '+response.status+' at '+path.split('?')[0].split('/')[0]);
 return response.json();
}
const account=await stripe('account');
assert.ok(account.charges_enabled,'Stripe account must be activated for live charges first.');
if(state.account)assert.equal(state.account,account.id,'Stored setup belongs to another Stripe account.');
state.account=account.id;save();
const origin=new URL(existing.LEARNING_PUBLIC_ORIGIN||'https://hearthvale.shishirtandale.com').origin;
assert.equal(origin,'https://hearthvale.shishirtandale.com');
const keys={month:'hearthvale_plus_month_v1',year:'hearthvale_plus_year_v1'};
const prices=(await stripe('prices?active=true&limit=100&lookup_keys[]='+keys.month+'&lookup_keys[]='+keys.year)).data;
let product=state.product||prices[0]?.product;
if(!product){product=(await stripe('products',{name:'Hearthvale Plus',description:'10× and 20× speed, live decisions and richer town writing.','metadata[app]':'hearthvale'},'hearthvale-live-product-v1')).id;state.product=product;save();}
const priceIds={};
for(const [interval,amount] of [['month',100],['year',1000]]) {
 let price=prices.find(p=>p.lookup_key===keys[interval]);
 if(!price)price=await stripe('prices',{product,currency:'usd',unit_amount:String(amount),'recurring[interval]':interval,lookup_key:keys[interval],'metadata[app]':'hearthvale'},'hearthvale-live-price-'+interval+'-v1');
 assert.equal(price.livemode,true);assert.equal(price.active,true);assert.equal(price.currency,'usd');assert.equal(price.unit_amount,amount);assert.equal(price.recurring.interval,interval);assert.equal(price.recurring.interval_count,1);assert.equal(price.product,product);
 priceIds[interval]=price.id;state[interval]=price.id;save();
}
let portal=state.portal?await stripe('billing_portal/configurations/'+state.portal):null;
if(!portal){portal=await stripe('billing_portal/configurations',{'business_profile[headline]':'Manage your Hearthvale Plus subscription',default_return_url:origin+'/','features[customer_update][enabled]':'true','features[customer_update][allowed_updates][0]':'email','features[invoice_history][enabled]':'true','features[payment_method_update][enabled]':'true','features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'at_period_end','metadata[app]':'hearthvale'},'hearthvale-live-portal-v1');state.portal=portal.id;save();}
assert.equal(portal.livemode,true);assert.equal(portal.active,true);
const webhookUrl=origin+'/api/billing/webhook';
const endpoints=(await stripe('webhook_endpoints?limit=100')).data.filter(e=>e.url===webhookUrl&&e.status==='enabled');
assert.ok(endpoints.length<=1,'Multiple active live webhooks already use this URL; review them before proceeding.');
let endpoint=endpoints[0];
const events=['checkout.session.completed','checkout.session.async_payment_succeeded','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'];
if(!endpoint){endpoint=await stripe('webhook_endpoints',{url:webhookUrl,description:'Hearthvale live billing',...Object.fromEntries(events.map((value,index)=>[`enabled_events[${index}]`,value]))},'hearthvale-live-webhook-v1');state.webhook=endpoint.id;state.webhookSecret=endpoint.secret;save();}
assert.equal(endpoint.livemode,true);
assert.ok(events.every(event=>endpoint.enabled_events.includes(event)||endpoint.enabled_events.includes('*')),'Existing webhook is missing required subscription events.');
const webhookSecret=state.webhook===endpoint.id?state.webhookSecret:input.STRIPE_WEBHOOK_SECRET;
assert.ok(/^whsec_/.test(webhookSecret||''), 'Existing live webhook found. Add its signing secret as STRIPE_WEBHOOK_SECRET to .dev.vars.live-key.');
state.webhook=endpoint.id;state.webhookSecret=webhookSecret;save();
const live={...existing,STRIPE_SECRET_KEY:key,STRIPE_PRICE_MONTH:priceIds.month,STRIPE_PRICE_YEAR:priceIds.year,STRIPE_PORTAL_CONFIGURATION:portal.id,STRIPE_WEBHOOK_SECRET:webhookSecret};
fs.writeFileSync(file('.dev.vars.live'),Object.entries(live).map(([name,value])=>name+'='+JSON.stringify(value)).join('\n')+'\n',{mode:0o600});fs.chmodSync(file('.dev.vars.live'),0o600);
console.log(JSON.stringify({ready:true,chargesEnabled:true,monthUSD:1,yearUSD:10,webhookConfigured:true,portalConfigured:true,output:'cloudflare/.dev.vars.live'}));
