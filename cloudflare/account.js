import {handleCloudState, cloudAlarm} from './cloud-saves.js';

// SQLite-backed serialized account state. No in-isolate counters grant credit.
export class AccountState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql; this.cloudQueue = Promise.resolve(); this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); }
  get(key) { const rows = [...this.sql.exec('SELECT value FROM kv WHERE key = ?', key)]; return rows.length ? JSON.parse(rows[0].value) : null; }
  put(key, value) { this.sql.exec('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  async fetch(request) {
    if (new URL(request.url).pathname.startsWith('/cloud/')) {
      const run = this.cloudQueue.then(() => handleCloudState(this, request));
      this.cloudQueue = run.catch(() => {});
      return run;
    }
    const {op, ...args} = await request.json();
    const result = this.ctx.storage.transactionSync(() => {
      if (op === 'read') return this.get(args.key);
      if (op === 'write') { this.put(args.key, args.value); return true; }
      if (op === 'auth-issue') {
        this.put(args.key, args.value);
        this.put(args.value.codeKey, {tokenKey: args.key});
        this.put(args.value.emailKey, {tokenKey: args.key, codeKey: args.value.codeKey, challenge: args.challenge});
        return true;
      }
      if (op === 'auth-code' || op === 'consume') {
        const key = op === 'auth-code' ? this.get(args.key)?.tokenKey : args.key;
        if (!key) return null;
        const value = this.get(key);
        if (!value) return null;
        const remove = () => {
          this.sql.exec('DELETE FROM kv WHERE key = ?', key);
          if (value.codeKey) this.sql.exec('DELETE FROM kv WHERE key = ?', value.codeKey);
          if (value.emailKey && this.get(value.emailKey)?.tokenKey === key) this.sql.exec('DELETE FROM kv WHERE key = ?', value.emailKey);
        };
        if (value.expires <= Date.now()) { remove(); return null; }
        if (op === 'auth-code') {
          if (!value.codeHash || value.attempts >= 5) return null;
          // Both hashes have fixed length; do not compare submitted digits here.
          let difference = value.codeHash.length ^ String(args.hash || '').length;
          for (let i = 0; i < value.codeHash.length; i++) difference |= value.codeHash.charCodeAt(i) ^ (String(args.hash || '').charCodeAt(i) || 0);
          if (difference) { this.put(key, {...value, attempts: value.attempts + 1}); return null; }
        }
        remove();
        return {id: value.id, email: value.email, expires: value.expires};
      }
      if (op === 'reserve') {
        const key = `budget:${args.period}:${args.kind}`; const used = this.get(key) || 0;
        if (!Number.isSafeInteger(args.amount) || args.amount < 1 || !Number.isSafeInteger(args.cap) || args.cap < 1 || used + args.amount > args.cap) return false;
        this.put(key, used + args.amount); return true;
      }
      if (op === 'checkout') {
        const previous = this.get('checkout');
        const now = Date.now();
        if (previous?.expires > now) {
          if (previous.interval === args.interval && previous.url) return {...previous, fresh: false};
          // A timed-out preparation resumes with the same Stripe idempotency key.
          // Another interval cannot replace an unresolved session creation.
          if (!previous.url) {
            if (previous.interval !== args.interval || previous.busyUntil > now ||
                !Number.isSafeInteger(previous.stripeExpiresAt) || previous.stripeExpiresAt * 1000 - now < 1860000) return {fresh: false};
            const value = {...previous, busyUntil: now + 60000};
            this.put('checkout', value);
            return {...value, fresh: true};
          }
          if (!previous.sessionId) return {fresh: false};
        }
        const stripeExpiresAt = Math.floor(now / 1000) + 3600;
        const value = {key: args.key, interval: args.interval, stripeExpiresAt, expires: stripeExpiresAt * 1000 + 60000, busyUntil: now + 60000,
          ...(previous?.expires > now ? {previousSessionId: previous.sessionId} : {})};
        this.put('checkout', value);
        return {...value, fresh: true};
      }
      if (op === 'checkout-result') {
        const value = this.get('checkout');
        if (value?.key !== args.key) return false;
        this.put('checkout', {...value, url: args.url, sessionId: args.sessionId, previousSessionId: null, busyUntil: 0});
        return true;
      }
      if (op === 'event') {
        if (this.get(`event:${args.id}`)) return false;
        const previous = this.get('billing');
        // Ignore stale delivery, including a delayed checkout after cancellation.
        if (!previous || args.value.at >= previous.at) this.put('billing', args.value);
        this.put(`event:${args.id}`, true); return true;
      }
      throw new Error('Unknown state operation');
    });
    return Response.json(result);
  }
  async alarm() {
    const run = this.cloudQueue.then(() => cloudAlarm(this));
    this.cloudQueue = run.catch(() => {});
    return run;
  }
}
export async function state(env, id, op, args = {}) {
  const stub = env.ACCOUNT_STATE.get(env.ACCOUNT_STATE.idFromName(id));
  const response = await stub.fetch('https://state.internal/', {method:'POST', body:JSON.stringify({op,...args})});
  if (!response.ok) throw new Error('State unavailable');
  return response.json();
}
export async function reserve(env, id, kind, amount, cap) {
  return state(env,id,'reserve',{kind,amount,cap,period:new Date().toISOString().slice(0,10)});
}
