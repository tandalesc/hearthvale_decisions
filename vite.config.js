import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {defineConfig} from 'vite';
import {system1Plugin} from './server/system1.js';
import {narratorPlugin} from './server/narrator.js';
// Builds (not the dev server) tell index.html to register the service worker (public/sw.js)
// and list the hashed files it keeps for offline play (sw-assets.json).
const serviceWorkerFlag = {name:'hearthvale-sw-flag', apply:'build',
  // The build id (a hash of the output names) changes the worker's URL, so each deploy installs afresh.
  transformIndexHtml:(html, ctx) => [{tag:'script', injectTo:'head-prepend',
    children:`window.__hearthvaleBuild=${JSON.stringify(createHash('sha256').update(Object.keys(ctx.bundle ?? {}).sort().join('\n')).digest('hex').slice(0, 12))}`}],
  // Scripts, styles and images only: the JSON assets are test fixtures (?fixture=city is 5 MB).
  writeBundle(options, bundle) {
    const assets = Object.keys(bundle).filter((f) => /^assets\/.+\.(js|css|png|jpe?g|webp|svg|woff2?)$/.test(f)).map((f) => '/' + f).sort();
    writeFileSync(join(options.dir, 'sw-assets.json'), JSON.stringify({assets}));
  }};
export default defineConfig({
  plugins:[system1Plugin(), narratorPlugin(), serviceWorkerFlag],
  server:{fs:{deny:['**/.git/**','**/local.env','**/.env*','**/*.{crt,pem}']}},
  preview:{allowedHosts:(process.env.PREVIEW_ALLOWED_HOSTS||'').split(',').filter(Boolean)},
  build:{rollupOptions:{output:{manualChunks:{three:['three'],controls:['three/addons/controls/OrbitControls.js']}}}},
  // Module workers. The sim worker must stay one file (no import() in its graph):
  // tests/sim-worker-bundle.test.js.
  worker:{format:'es'}
});
