import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
const chromePath=process.env.CHROME_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
export default defineConfig({testDir:'./tests/browser',workers:1,use:{baseURL:process.env.HEARTHVALE_TEST_URL||'http://127.0.0.1:5173',viewport:{width:1440,height:1000},launchOptions:{executablePath:chromePath,args:['--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist']}},reporter:'list'});
