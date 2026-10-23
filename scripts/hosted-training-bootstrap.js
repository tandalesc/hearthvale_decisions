// Prepare a private R2 bootstrap upload plan. This script never trains, contacts a
// teacher, uploads data, or embeds developer-machine paths into production config.
// node scripts/hosted-training-bootstrap.js INPUT_CONFIG.json OUTPUT_DIRECTORY
// Input: {root:'/asset/source', current:{version,run:'checkpoint',bundle:'current.json'},
// train:['corpus/train.jsonl'],realplay:'eval/realplay.jsonl',realplayQuestions:'eval/questions.jsonl',
// baseline:'corpus/baseline.jsonl',reference:['reference'],config:{excludeKinds:['enterprise_type_for_site']}}
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {packBootstrapAsset} from '../cloudflare/training/assets.js';
const [configFile, output] = process.argv.slice(2);
if (!configFile || !output) throw new Error('Usage: node scripts/hosted-training-bootstrap.js INPUT_CONFIG.json OUTPUT_DIRECTORY');
const source = JSON.parse(readFileSync(configFile, 'utf8')), root = resolve(source.root ?? dirname(configFile)), out = resolve(output);
const config = {...source}; delete config.root;
if (!config.current?.run || !config.current?.bundle || !Array.isArray(config.train) || !config.train.length || !config.realplay || !config.realplayQuestions || !config.baseline) throw new Error('Missing corpus, checkpoint, baseline or frozen evaluation assets');
const files = [...new Set([`${config.current.run}/model.pt`, config.current.bundle, ...config.train, config.realplay, config.realplayQuestions, config.baseline, ...(config.reference ?? []).map(path => `${path}/states.jsonl`)])];
config.files = [];
for (const path of files) {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`Asset path must be relative: ${path}`);
  const src = resolve(root, path); if (!existsSync(src)) throw new Error(`Unavailable bootstrap asset: ${src}`);
  const packed = await packBootstrapAsset(src, join(out, 'assets'));
  config.files.push({path, key: `bootstrap/assets/${packed.sha256}`, ...packed});
}
const bundle = JSON.parse(readFileSync(resolve(root, config.current.bundle), 'utf8'));
if (!bundle.kinds.includes('strike_resolve')) throw new Error('Bootstrap bundle must cover active strike_resolve decisions');
if (bundle.teacher && bundle.teacher !== 'd1' && !(config.teacherMigration?.approved === true && config.teacherMigration.to === 'd1' && config.teacherMigration.from?.includes(bundle.teacher))) throw new Error('Legacy teacher corpus requires explicit teacherMigration:{approved:true,from:[bundle teacher],to:d1} in bootstrap config; frozen historical evaluation remains unchanged');
if (bundle.version !== config.current.version) throw new Error('Checkpoint configuration and bundle version mismatch');
mkdirSync(out, {recursive: true});
writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');
// Replace only this generator's obsolete content-addressed assets after the new plan is complete.
const active = new Set(config.files.map(file => file.sha256));
for (const name of readdirSync(join(out, 'assets'))) if (/^[a-f0-9]{64}$/.test(name) && !active.has(name)) unlinkSync(join(out, 'assets', name));
const commands = config.files.map(f => `npx wrangler r2 object put "$BUCKET/${f.key}" --file '${join(out, 'assets', f.sha256).replaceAll("'", "'\\''")}' --remote`);
commands.push(`npx wrangler r2 object put "$BUCKET/bootstrap/config.json" --file '${join(out, 'config.json').replaceAll("'", "'\\''")}' --remote`);
writeFileSync(join(out, 'upload.sh'), '#!/bin/sh\nset -eu\n: "${BUCKET:?Set private R2 bucket name}"\n' + commands.join('\n') + '\n');
console.log(`Prepared ${config.files.length} private assets in ${out}; review config.json and upload.sh. No upload performed.`);
