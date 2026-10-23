import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudAlarm} from '../cloudflare/cloud-saves.js';

const id='a'.repeat(64), townId='11111111-1111-4111-8111-111111111111';
function fake() {
 const kv=new Map(), r2=new Map(), alarms=[];
 const bucket={
  fail:false,
  async put(key,value,options={}){if(this.fail){this.fail=false;throw new Error('R2 unavailable');}if(options.onlyIf&&r2.has(key))return null;r2.set(key,value);return {key};},
  async get(key){const value=r2.get(key);return value==null?null:{json:async()=>JSON.parse(value)};},
  async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])r2.delete(key);},
  async list({prefix}){return {objects:[...r2.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false};}
 };
 const object={accountId:id,get:key=>kv.get(key)||null,put:(key,value)=>kv.set(key,value),ctx:{storage:{setAlarm:async at=>alarms.push(at)}},env:{STUDENT_ARTIFACTS:bucket}};
 const key=`cloud-saves/v1/${id}/towns/${townId}/1-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.gz`;
 const town={id:townId,revision:1,saveId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Town',year:1,month:1,people:20,savedAt:'2026-10-01T00:00:00.000Z',bytes:4,key};
 kv.set('cloud:catalog',{towns:{[townId]:town},receipts:{},writes:{}});r2.set(key,new Uint8Array([31,139,8,0]));
 return {object,bucket,r2,kv,alarms,key};
}
test('failed backup keeps prior snapshots and retries; retention keeps seven daily catalogs and referenced blobs',async()=>{
 const f=fake(), original=Date.now;
 try {
  let day=Date.parse('2026-10-01T04:00:00.000Z');Date.now=()=>day;
  f.bucket.fail=true;
  await assert.rejects(cloudAlarm(f.object),/Cloud backup failed/);
  assert.deepEqual(f.kv.get('cloud:snapshots'),undefined);
  assert.equal(f.alarms.at(-1),day+3600000);
  for(let i=0;i<8;i++){day=Date.parse('2026-10-01T04:00:00.000Z')+i*86400000;await cloudAlarm(f.object);}
  const snapshots=f.kv.get('cloud:snapshots');assert.equal(snapshots.length,7);
  assert.equal(snapshots[0].date,'2026-10-02');assert.equal(snapshots.at(-1).date,'2026-10-08');
  assert.equal([...f.r2.keys()].filter(key=>key.includes('/catalog/')).length,7);
  assert.ok(f.r2.has(f.key),'live town blob retained');
  await cloudAlarm(f.object);
  assert.equal([...f.r2.keys()].filter(key=>key.includes('/catalog/')).length,7,'repeat alarm cannot grow the same day');
 }finally{Date.now=original;}
});
test('expired deleted towns and their blobs leave private storage after the recovery window',async()=>{
 const f=fake(), original=Date.now;
 try {
  const cat=f.kv.get('cloud:catalog');cat.towns[townId]={...cat.towns[townId],revision:2,deleted:true,savedAt:'2026-10-01T00:00:00.000Z',previous:cat.towns[townId]};
  f.kv.set('cloud:catalog',cat);
  Date.now=()=>Date.parse('2026-10-09T04:00:00.000Z');
  await cloudAlarm(f.object);
  assert.equal(f.kv.get('cloud:catalog').towns[townId],undefined);
  assert.equal(f.r2.has(f.key),false);
 }finally{Date.now=original;}
});
test('daily snapshot protects its previous revision after current catalog changes',async()=>{
 const f=fake(), original=Date.now;
 try {
  const first=f.kv.get('cloud:catalog').towns[townId];
  const newer={...first,revision:2,key:first.key.replace('/1-','/2-'),previous:first};
  f.kv.get('cloud:catalog').towns[townId]=newer;
  f.r2.set(newer.key,new Uint8Array([31,139,8,0]));
  Date.now=()=>Date.parse('2026-10-01T04:00:00.000Z');await cloudAlarm(f.object);
  f.kv.get('cloud:catalog').towns[townId]={...newer,revision:3,key:newer.key.replace('/2-','/3-'),previous:newer};
  f.r2.set(f.kv.get('cloud:catalog').towns[townId].key,new Uint8Array([31,139,8,0]));
  Date.now=()=>Date.parse('2026-10-02T04:00:00.000Z');await cloudAlarm(f.object);
  assert.ok(f.r2.has(first.key),'day-one snapshot previous revision must remain restorable');
 }finally{Date.now=original;}
});
test('SQLite failure after R2 snapshot cannot overwrite that day on retry after progress',async()=>{
 const f=fake(), original=Date.now;
 try {
  Date.now=()=>Date.parse('2026-10-01T04:00:00.000Z');
  const put=f.object.put;let fail=true;
  f.object.put=(key,value)=>{if(key==='cloud:snapshots'&&fail){fail=false;throw new Error('SQLite unavailable');}put(key,value);};
  await assert.rejects(cloudAlarm(f.object),/Cloud backup failed/);
  const catalogKey=[...f.r2.keys()].find(key=>key.includes('/catalog/'));
  assert.ok(catalogKey);assert.equal(JSON.parse(f.r2.get(catalogKey)).towns[townId].revision,1);
  const first=f.kv.get('cloud:catalog').towns[townId];
  const newKey=first.key.replace('/1-','/2-');
  f.kv.get('cloud:catalog').towns[townId]={...first,key:newKey,revision:2,previous:first};
  f.r2.set(newKey,new Uint8Array([31,139,8,0]));
  await cloudAlarm(f.object);
  assert.equal(JSON.parse(f.r2.get(catalogKey)).towns[townId].revision,1,'R2 catalog stays at original recovery point');
  assert.equal(f.kv.get('cloud:snapshots')[0].towns[townId].revision,1,'SQLite adopts original R2 snapshot');
  assert.ok(f.r2.has(first.key));assert.ok(f.r2.has(newKey));
 }finally{Date.now=original;}
});
test('cleanup failure is logged without account or object identifiers',async()=>{
 const f=fake(), originalNow=Date.now, originalWarn=console.warn, warnings=[];
 try {
  Date.now=()=>Date.parse('2026-10-09T04:00:00.000Z');console.warn=value=>warnings.push(value);
  f.r2.set(`cloud-saves/v1/${id}/towns/orphan.gz`,new Uint8Array([1]));
  f.bucket.delete=async()=>{throw new Error('private key must stay out of logs');};
  await cloudAlarm(f.object);
  assert.equal(warnings.length,1);assert.match(warnings[0],/cloud_backup_cleanup_failed/);
  assert.equal(warnings[0].includes(id),false);assert.equal(warnings[0].includes('orphan'),false);
 }finally{Date.now=originalNow;console.warn=originalWarn;}
});
