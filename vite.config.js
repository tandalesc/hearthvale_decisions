import {defineConfig} from 'vite';
import {system1Plugin} from './server/system1.js';
export default defineConfig({
  plugins:[system1Plugin()],
  server:{fs:{deny:['**/.git/**','**/local.env','**/.env*','**/*.{crt,pem}']}},
  build:{rollupOptions:{output:{manualChunks:{three:['three'],controls:['three/addons/controls/OrbitControls.js']}}}}
});
