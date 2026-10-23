import {state} from './account.js';
const enc = new TextEncoder();
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2,'0')).join('');
export async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))), n => n.toString(16).padStart(2,'0')).join(''); }
export async function hmac(secret, value) { const key = await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']); return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value))), n=>n.toString(16).padStart(2,'0')).join(''); }
export function constantEqual(a,b) { let difference = a.length ^ b.length; for(let i=0;i<Math.max(a.length,b.length);i++) difference |= (a.charCodeAt(i)||0) ^ (b.charCodeAt(i)||0); return difference === 0; }
export function cookie(value, age = 2592000) { return `__Host-hearthvale=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
export async function signSession(env, value) { const payload = btoa(JSON.stringify(value)); return `${payload}.${await hmac(env.AUTH_SECRET,payload)}`; }
export async function session(request,env) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error('Authentication not configured');
  const raw = request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-hearthvale='))?.slice('__Host-hearthvale='.length);
  if (raw) { try { const [payload,signature] = raw.split('.'); if (constantEqual(signature||'',await hmac(env.AUTH_SECRET,payload))) { const value=JSON.parse(atob(payload)); if (value.expires>Date.now() && /^[a-f0-9]{64}$/.test(value.id)) return value; } } catch {} }
  return {id:randomToken(),expires:Date.now()+2592000000};
}
export async function codeHash(env, challenge, code) { return hmac(env.AUTH_SECRET, `signin-code:${challenge}:${code}`); }
function emailCode() {
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= 4294000000);
  return String(value[0] % 1000000).padStart(6, '0');
}
export async function requestEmail(request,env,email,challenge=randomToken()) {
  if (typeof email !== 'string' || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  email=email.toLowerCase().trim();
  if (!env.EMAIL?.send || !env.EMAIL_FROM) throw new Error('Email not configured');
  const token=randomToken(), code=emailCode(), id=await digest(email);
  const codeKey='code:'+await digest(challenge);
  await state(env,'auth','auth-issue',{key:await digest(token),challenge,value:{id,email,emailKey:'email:'+id,codeKey,codeHash:await codeHash(env,challenge,code),attempts:0,expires:Date.now()+900000}});
  const url=new URL('/api/auth/verify',request.url); url.searchParams.set('token',token);
  await env.EMAIL.send({from:{email:env.EMAIL_FROM,name:'Hearthvale'},to:email,subject:'Sign in to Hearthvale',text:`Your Hearthvale sign-in code: ${code}\n\nReturn to Hearthvale and enter this code to sign in, including in the home-screen app.\n\nOr use this sign-in link: ${url.href}\n\nThe code and link expire in 15 minutes. Using either signs you in once and invalidates both. Never share this code. If you did not request it, ignore this email.`});
  return challenge;
}
