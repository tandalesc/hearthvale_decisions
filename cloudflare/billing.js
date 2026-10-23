import {constantEqual,hmac,randomToken} from './auth.js';
import {state} from './account.js';
export const liveBilling = env => /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
// Existing test records stay in place; live customers, locks and events never reuse them.
export const billingState = (env, id, op, args) => state(env, liveBilling(env) ? `stripe:live:${id}` : id, op, args);
export const billingEnabled = env => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTH && env.STRIPE_PRICE_YEAR);
export const isPaid = billing => Boolean(billing?.active && Number.isFinite(billing.paidThrough) && billing.paidThrough > Date.now());
export async function stripe(env,path,values,method='POST',idempotencyKey) {
  const response=await fetch(`https://api.stripe.com/v1/${path}`,{method,headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{}),...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(method==='POST'?{body:new URLSearchParams(values)}:{}),signal:AbortSignal.timeout(10000),redirect:'manual'});
  if(!response.ok) { await response.body?.cancel(); throw new Error('Billing unavailable'); }
  return response.json();
}
function paidSubscription(env,subscription) {
 const items=subscription.items?.data||[];
 const valid=items.length===1&&[env.STRIPE_PRICE_MONTH,env.STRIPE_PRICE_YEAR].includes(items[0].price?.id);
 const end=subscription.status==='trialing'?subscription.trial_end:(subscription.current_period_end??items[0]?.current_period_end);
 return {active:valid&&['active','trialing'].includes(subscription.status)&&Number.isFinite(end)&&end*1000>Date.now(),paidThrough:Number.isFinite(end)?end*1000:0,subscription:subscription.id};
}
async function reconcile(env,customer) {
 const result=await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`,{},'GET');
 // Never revoke a replacement subscription because an older one was cancelled.
 return (result.data||[]).map(s=>paidSubscription(env,s)).sort((a,b)=>Number(b.active)-Number(a.active)||b.paidThrough-a.paidThrough)[0]||{active:false,paidThrough:0};
}
export async function checkout(env,account,origin,interval) {
  if(!['month','year'].includes(interval)) throw new Error('Invalid interval');
  const existing=await billingState(env,account.id,'read',{key:'billing'});
  if(isPaid(existing)) throw Object.assign(new Error('Subscription already active'),{status:409});
  if(existing?.customer && (await reconcile(env,existing.customer)).active) throw Object.assign(new Error('Subscription already active'),{status:409});
  const priceId=interval==='month'?env.STRIPE_PRICE_MONTH:env.STRIPE_PRICE_YEAR;
  const price=await stripe(env,`prices/${encodeURIComponent(priceId)}`,{},'GET');
  if(price.livemode!==liveBilling(env)||price.currency!=='usd'||price.unit_amount!==(interval==='month'?100:1000)||price.recurring?.interval!==interval||price.recurring?.interval_count!==1||!price.active) throw new Error('Invalid configured price');
  const lock=await billingState(env,account.id,'checkout',{key:randomToken(),interval});
  if(!lock.fresh) {if(lock.url) return {url:lock.url};throw Object.assign(new Error('Checkout already being prepared'),{status:409});}
  if (lock.previousSessionId) {
    const path = `checkout/sessions/${encodeURIComponent(lock.previousSessionId)}`;
    try {
      await stripe(env, `${path}/expire`, {}, 'POST', `expire:${account.id}:${lock.previousSessionId}`);
    } catch {
      // Expiration can race completion or a previous retry. Only an expired
      // session is safe to replace; unknown state stays locked and fails closed.
      const previous = await stripe(env, path, {}, 'GET');
      if (previous.status !== 'expired') throw Object.assign(new Error('Previous checkout must expire before changing plans'), {status: 409});
    }
  }
  const customer=existing?.customer||(await stripe(env,'customers',{email:account.email,'metadata[account]':account.id},'POST',`customer:${account.id}`)).id;
  if(!existing?.customer) await billingState(env,account.id,'write',{key:'billing',value:{active:false,paidThrough:0,customer,at:0}});
  const result=await stripe(env,'checkout/sessions',{mode:'subscription',customer,'line_items[0][price]':priceId,'line_items[0][quantity]':'1',client_reference_id:account.id,'subscription_data[metadata][account]':account.id,'metadata[account]':account.id,expires_at:String(lock.stripeExpiresAt),success_url:`${origin}/?billing=success`,cancel_url:`${origin}/?billing=cancelled`},'POST',`checkout:${account.id}:${lock.key}`);
  if (typeof result.id !== 'string' || typeof result.url !== 'string') throw new Error('Invalid checkout session');
  await billingState(env,account.id,'checkout-result',{key:lock.key,url:result.url,sessionId:result.id});
  return {url:result.url};
}
export async function webhook(request,env,readText) {
  const raw=await readText(request,262144), header=request.headers.get('stripe-signature')||'';
  const timestamp=header.split(',').find(x=>x.startsWith('t='))?.slice(2);
  const signatures=header.split(',').filter(x=>x.startsWith('v1=')).map(x=>x.slice(3));
  if(!timestamp||!Number.isFinite(Number(timestamp))||Math.abs(Date.now()/1000-Number(timestamp))>300) throw new Error('Invalid signature');
  const expected=await hmac(env.STRIPE_WEBHOOK_SECRET,`${timestamp}.${raw}`);
  if(!signatures.some(signature=>constantEqual(signature,expected))) throw new Error('Invalid signature');
  const event=JSON.parse(raw), object=event.data?.object;
  if(!event.id||!Number.isFinite(event.created)||event.livemode!==liveBilling(env)) throw new Error('Invalid event');
  if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
    const id=object.metadata?.account;
    if(!/^[a-f0-9]{64}$/.test(id||'')||typeof object.customer!=='string') return;
    if(await billingState(env,id,'read',{key:`event:${event.id}`})) return;
    const previous=await billingState(env,id,'read',{key:'billing'});
    if(!previous?.customer||previous.customer!==object.customer) return;
    const value=await reconcile(env,object.customer);
    await billingState(env,id,'event',{id:event.id,value:{...value,at:event.created,customer:object.customer}});
  }
}
