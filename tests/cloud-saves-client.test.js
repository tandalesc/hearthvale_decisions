import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createCloudSaves} from '../src/cloud-saves.js';

const raw = (name, year = 1) => JSON.stringify({version: 1, townName: name, time: {year, month: 1}, people: [{name: 'A'}]});
const zipped = text => new Blob([gzipSync(text)], {type: 'application/gzip'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

function setup({name = 'Device', cloud = null, account = 'alice', now = Date.now} = {}) {
  let active = account, serial = 0;
  const slots = new Map([['device', {blob: zipped(raw(name)), meta: {id: 'device', name, localRevision: 'local-1', cloud: cloud ? {[account]: structuredClone(cloud)} : {}}}]]);
  const remote = new Map();
  const calls = [];
  const operationsMap = new Map();
  const operations = {getItem: key => operationsMap.get(key) ?? null, setItem: (key, value) => operationsMap.set(key, value), removeItem: key => operationsMap.delete(key)};
  const saves = {
    async read(id) { const value = slots.get(id); return value && {blob: value.blob, meta: structuredClone(value.meta)}; },
    async list() { return [...slots.values()].map(value => structuredClone(value.meta)); },
    async updateCloud(id, scope, patch) {
      const value = slots.get(id); if (!value) return;
      value.meta.cloud[scope] = {...value.meta.cloud[scope], ...structuredClone(patch)};
    },
    async save(id, text, meta) {
      slots.set(id, {blob: zipped(text), meta: {...meta, id, localRevision: `local-${++serial}`, cloud: {}}});
      return true;
    },
    async installCloud(id, blob, meta, scope, binding, expectedRevision) {
      const before = slots.get(id);
      if ((before?.meta.localRevision ?? null) !== expectedRevision) return false;
      const localRevision = `local-${++serial}`;
      slots.set(id, {blob, meta: {...before?.meta, ...meta, id, localRevision, cloud: {...before?.meta.cloud, [scope]: {...binding, cleanRevision: localRevision}}}});
      return true;
    },
  };
  const catalog = scope => ({towns: [...(remote.get(scope)?.values() ?? [])].map(t => ({id: t.id, revision: t.revision, saveId: t.saveId, name: t.name})), recoverable: [], limit: 10, maxBytes: 16 * 1024 * 1024});
  const backend = async (url, options) => {
    const scope = options.headers['X-Cloud-Account'];
    calls.push({url, options, scope});
    if (!remote.has(scope)) remote.set(scope, new Map());
    const towns = remote.get(scope), path = url.replace('/api/cloud/towns', ''), id = path.split('/')[1];
    if (!path) return Response.json(catalog(scope));
    if (options.method === 'PUT') {
      const before = towns.get(id), revision = Number(options.headers['If-Match']);
      if (before && before.saveId === options.headers['X-Save-Id']) return Response.json({town: {id, revision: before.revision, saveId: before.saveId, name: before.name}});
      if ((before?.revision ?? 0) !== revision) return Response.json({code: 'conflict', error: 'Cloud revision changed.', town: before}, {status: 409});
      const meta = JSON.parse(decodeURIComponent(options.headers['X-Town-Meta']));
      const next = {id, revision: revision + 1, saveId: options.headers['X-Save-Id'], name: meta.name, blob: options.body};
      towns.set(id, next); return Response.json({town: {id, revision: next.revision, saveId: next.saveId, name: next.name}});
    }
    const town = towns.get(id);
    if (!town) return Response.json({code: 'missing'}, {status: 404});
    if (options.method === 'POST' && path.endsWith('/restore')) {
      const payload = JSON.parse(options.body);
      if (town.saveId !== payload.saveId) {
        if (town.revision !== payload.baseRevision) return Response.json({code: 'conflict'}, {status: 409});
        town.revision++; town.saveId = payload.saveId;
      }
      return Response.json({town: {id, revision: town.revision, saveId: town.saveId}});
    }
    return new Response(town.blob, {headers: {'X-Town-Meta': encodeURIComponent(JSON.stringify({id, revision: town.revision, saveId: town.saveId, name: town.name}))}});
  };
  let fetcher = backend;
  const client = createCloudSaves({saves, session: () => ({authenticated: !!active, cloudAccountId: active, tier: 'paid'}), fetcher: (...args) => fetcher(...args), operations, now});
  return {client, saves, slots, remote, calls, operationsMap, backend, setFetch: fn => { fetcher = fn; }, setAccount: value => { active = value; }};
}

test('uploads a town once, then skips unchanged bytes and name', async () => {
  const f = setup();
  await f.client.flush('device');
  const binding = f.slots.get('device').meta.cloud.alice;
  assert.equal(binding.revision, 1);
  assert.equal(binding.cleanRevision, 'local-1');
  assert.equal(binding.pending, null);
  assert.equal(f.calls.filter(c => c.options.method === 'PUT').length, 1);
  await f.client.flush('device');
  assert.equal(f.calls.filter(c => c.options.method === 'PUT').length, 1, 'unchanged save should not upload');
  assert.equal(f.client.status('device').state, 'synced');
});

test('a cloud CAS conflict keeps the device bytes and reports conflict', async () => {
  const f = setup({cloud: {id: 'town-1', revision: 1, hash: 'old', name: 'Device'}});
  f.remote.set('alice', new Map([['town-1', {id: 'town-1', revision: 2, saveId: 'other', name: 'Elsewhere', blob: zipped(raw('Elsewhere'))}]]));
  const original = await f.slots.get('device').blob.arrayBuffer();
  await assert.rejects(f.client.flush('device'), error => error.code === 'conflict');
  assert.deepEqual(Buffer.from(await f.slots.get('device').blob.arrayBuffer()), Buffer.from(original));
  assert.equal(f.slots.get('device').meta.cloud.alice.revision, 1);
  assert.equal(f.client.status('device').state, 'conflict');
  assert.equal(f.calls.filter(c => c.options.method === 'PUT').length, 0);
});

test('useCloud preserves the device version and installs remote with local revision CAS', async () => {
  const f = setup({cloud: {id: 'town-1', revision: 1, name: 'Device'}});
  f.remote.set('alice', new Map([['town-1', {id: 'town-1', revision: 2, saveId: 'remote-save', name: 'Cloud', blob: zipped(raw('Cloud', 3))}]]));
  await f.client.useCloud('device');
  const copy = [...f.slots.entries()].find(([id]) => id !== 'device');
  assert.ok(copy, 'device copy exists before replacement');
  assert.equal(copy[1].meta.name, 'Device (device copy)');
  assert.equal(copy[1].meta.cloud.alice.paused, true);
  assert.equal(f.slots.get('device').meta.name, 'Cloud');
  assert.equal(f.slots.get('device').meta.cloud.alice.revision, 2);
  assert.equal(JSON.parse(await new Response(f.slots.get('device').blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()).townName, 'Cloud');
});

test('a changed local revision prevents cloud replacement after device copy', async () => {
  const f = setup({cloud: {id: 'town-1', revision: 1}});
  f.remote.set('alice', new Map([['town-1', {id: 'town-1', revision: 2, saveId: 'remote-save', name: 'Cloud', blob: zipped(raw('Cloud'))}]]));
  const originalInstall = f.saves.installCloud;
  f.saves.installCloud = async (...args) => {
    f.slots.get('device').meta.localRevision = 'local-newer';
    return originalInstall(...args);
  };
  await assert.rejects(f.client.useCloud('device'), error => error.code === 'storage');
  assert.equal(f.slots.get('device').meta.name, 'Device');
  assert.ok([...f.slots.values()].some(t => t.meta.name === 'Device (device copy)'));
});

test('account switch during a request and while another job is queued sends no old bytes to the new account', async () => {
  const f = setup(), gate = deferred();
  let entered = false;
  f.setFetch(async (url, options) => {
    if (!entered) { entered = true; await gate.promise; }
    return f.backend(url, options);
  });
  const first = f.client.flush('device');
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  const queued = f.client.flush('device');
  f.setAccount('bob'); gate.resolve();
  await assert.rejects(first, error => error.code === 'account_changed');
  await assert.rejects(queued, error => error.code === 'account_changed');
  assert.equal(f.calls.filter(c => c.options.method === 'PUT').length, 0);
  assert.equal(f.remote.get('bob')?.size ?? 0, 0);
});

test('a queued timer is discarded when the account changes before it fires', async () => {
  const f = setup({now: () => 120000});
  f.client.queue('device');
  f.setAccount('bob');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.length, 0);
  assert.equal(f.remote.get('bob')?.size ?? 0, 0);
  assert.equal(f.slots.get('device').meta.cloud.bob, undefined);
});

test('lost upload response recovers pending save ID without a second upload', async () => {
  const f = setup(); let lost = true;
  f.setFetch(async (url, options) => {
    const result = await f.backend(url, options);
    if (options.method === 'PUT' && lost) { lost = false; throw new Error('Response lost'); }
    return result;
  });
  await assert.rejects(f.client.flush('device'), /Response lost/);
  const pending = f.slots.get('device').meta.cloud.alice.pending;
  assert.ok(pending?.saveId);
  await f.client.flush('device');
  assert.equal(f.slots.get('device').meta.cloud.alice.saveId, pending.saveId);
  assert.equal(f.slots.get('device').meta.cloud.alice.pending, null);
  assert.equal(f.calls.filter(c => c.options.method === 'PUT').length, 1);
});

test('restore retry uses the persisted operation ID after its response is lost', async () => {
  const f = setup({cloud: {id: 'town-1', revision: 2}});
  f.remote.set('alice', new Map([['town-1', {id: 'town-1', revision: 2, saveId: 'before', name: 'Cloud', blob: zipped(raw('Cloud'))}]]));
  let lost = true;
  f.setFetch(async (url, options) => {
    const result = await f.backend(url, options);
    if (options.method === 'POST' && lost) { lost = false; throw new Error('Response lost'); }
    return result;
  });
  await assert.rejects(f.client.restore('town-1', 'previous'), /Response lost/);
  const key = 'hearthvale-cloud-restore:alice:town-1';
  const pending = JSON.parse(f.operationsMap.get(key));
  assert.equal(pending.backupId, 'previous');
  assert.equal(pending.baseRevision, 2);
  await f.client.restore('town-1', 'previous');
  const posts = f.calls.filter(c => c.options.method === 'POST').map(c => JSON.parse(c.options.body));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(posts[0].saveId, pending.saveId);
  assert.equal(f.remote.get('alice').get('town-1').revision, 3);
  assert.equal(f.operationsMap.has(key), false);
  assert.equal(f.slots.get('device').meta.cloud.alice.revision, 3);
});


test('blocked localStorage does not prevent offline play from starting', async () => {
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('Storage blocked');}});
  try {
    const client=createCloudSaves({saves:{},session:()=>({authenticated:false})});
    assert.equal(client.enabled(),false);
    assert.equal(await client.prepare('local'),'local');
    await client.flush('local');
  } finally {
    if(original)Object.defineProperty(globalThis,'localStorage',original);
    else delete globalThis.localStorage;
  }
});
