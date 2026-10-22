import {defineConfig} from 'vite';
import {system1Plugin} from './server/system1.js';
import {narratorPlugin} from './server/narrator.js';
export default defineConfig({
  plugins:[system1Plugin(), narratorPlugin()],
  server:{fs:{deny:['**/.git/**','**/local.env','**/.env*','**/*.{crt,pem}']}},
  preview:{allowedHosts:(process.env.PREVIEW_ALLOWED_HOSTS||'').split(',').filter(Boolean)},
  build:{rollupOptions:{output:{manualChunks:{three:['three'],controls:['three/addons/controls/OrbitControls.js']}}}},
  // Module workers. The sim worker must stay one file (no import() in its graph):
  // tests/sim-worker-bundle.test.js.
  worker:{format:'es'}
});
