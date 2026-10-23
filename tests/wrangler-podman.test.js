import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('Podman adapter strips Docker flags and reports the converted pushed digest',()=>{
 const root=mkdtempSync(join(tmpdir(),'hearthvale-podman-test-'));
 try {
  const fake=join(root,'podman'),record=join(root,'args.json');
  writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.writeFileSync(process.env.RECORD,JSON.stringify(args));if(args[0]==='push')fs.writeFileSync(args[args.indexOf('--digestfile')+1],'sha256:'+'a'.repeat(64));else console.log('local-digest-should-not-be-used');\n`,{mode:0o755});
  const run=args=>spawnSync(process.execPath,[resolve('scripts/wrangler-podman.mjs'),...args],{encoding:'utf8',env:{...process.env,PODMAN_BIN:fake,PODMAN_DIGEST_CACHE_DIR:join(root,'cache'),RECORD:record}});
  assert.equal(run(['build','--load','--provenance=false','--platform','linux/amd64','.']).status,0);
  assert.deepEqual(JSON.parse(readFileSync(record)),['build','--layers','--platform','linux/amd64','.']);
  const image='registry.cloudflare.com/account/training:tag';assert.equal(run(['push',image]).status,0);
  const pushed=JSON.parse(readFileSync(record));assert.deepEqual(pushed.slice(0,3),['push','--format','v2s2']);assert.ok(pushed.includes('--digestfile'));
  const inspect=run(['image','inspect',image,'--format','{{ json .RepoDigests }}']);assert.equal(inspect.status,0);assert.deepEqual(JSON.parse(inspect.stdout),['registry.cloudflare.com/account/training@sha256:'+'a'.repeat(64)]);
 } finally {rmSync(root,{recursive:true,force:true});}
});
