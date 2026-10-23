#!/usr/bin/env node
// Adapt Docker BuildKit flags and registry digest reporting for Podman.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const args = process.argv.slice(2).filter(arg => arg !== '--provenance=false' && arg !== '--load');
const cacheDir=process.env.PODMAN_DIGEST_CACHE_DIR||join(tmpdir(),`hearthvale-podman-digests-${process.getuid?.()??'user'}`);
const cachePath=image=>join(cacheDir,createHash('sha256').update(image).digest('hex')+'.json');
// Podman's local OCI digest can differ from the registry digest after compression
// and Docker manifest conversion. Wrangler requires the actual pushed digest.
if(args[0]==='image'&&args[1]==='inspect'&&args.includes('{{ json .RepoDigests }}')) {
 try {const saved=JSON.parse(readFileSync(cachePath(args[2]),'utf8'));if(/^sha256:[a-f0-9]{64}$/.test(saved.digest)){console.log(JSON.stringify([`${saved.repository}@${saved.digest}`]));process.exit(0);}} catch {}
}
if (args[0] === 'build' && !args.includes('--layers')) args.splice(1, 0, '--layers');
let digestFile,image;
if(args[0]==='push') {
 image=args.at(-1);mkdirSync(cacheDir,{recursive:true,mode:0o700});digestFile=join(cacheDir,`push-${process.pid}.digest`);
 args.splice(1,0,'--format','v2s2','--digestfile',digestFile);
}
const child = spawn(process.env.PODMAN_BIN || 'podman', args, {stdio:'inherit'});
child.on('error', error => {console.error(error.message);process.exitCode=1;});
child.on('exit', (code,signal) => {
 if(code===0&&digestFile) {
  try {
   const digest=readFileSync(digestFile,'utf8').trim();if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('Podman did not return a valid pushed manifest digest');
   const repository=image.split('@')[0].replace(/:[^/:]+$/,'');writeFileSync(cachePath(image),JSON.stringify({repository,digest}),{mode:0o600});
  } catch(error){console.error(error.message);process.exitCode=1;return;}
  finally{try{unlinkSync(digestFile);}catch{}}
 }
 if(signal)process.kill(process.pid,signal);else process.exitCode=code ?? 1;
});
