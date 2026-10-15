import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';

// Browser tests start their own Vite server on a free-ish port unless
// HEARTHVALE_TEST_URL points at one that is already running.
const PORT = Number(process.env.HEARTHVALE_TEST_PORT ?? 5197);
const url = process.env.HEARTHVALE_TEST_URL ?? `http://127.0.0.1:${PORT}`;
const chromePath = process.env.CHROME_PATH
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60000,
  reporter: 'list',
  webServer: process.env.HEARTHVALE_TEST_URL ? undefined : {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url,
    reuseExistingServer: true,
    timeout: 30000,
  },
  use: {
    baseURL: url,
    viewport: {width: 1440, height: 900},
    launchOptions: {executablePath: chromePath, args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']},
  },
});
