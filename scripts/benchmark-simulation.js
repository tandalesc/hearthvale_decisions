import {performance} from 'node:perf_hooks';
import {crowdFixture} from './load-fixture.js';
import {createRoutePlanner} from '../src/route-planner.js';
import {stepAgents} from '../src/sim/legacy.js';
const budgeted=process.argv.includes('--budgeted'),populations=process.argv.slice(2).filter(a=>/^\d+$/.test(a)).map(Number);const results=[];
for(const population of populations.length?populations:[28,250,1000]){const s=crowdFixture(population),times=[],planner=budgeted?createRoutePlanner({worker:false}):null;for(let i=0;i<80;i++){const start=performance.now();planner?.tick();stepAgents(s,.1,planner);times.push(performance.now()-start);}const sorted=times.slice().sort((a,b)=>a-b);results.push({population,firstMs:+times[0].toFixed(2),p50Ms:+sorted[40].toFixed(2),p95Ms:+sorted[76].toFixed(2),maxMs:+sorted.at(-1).toFixed(2),totalMs:+times.reduce((a,b)=>a+b).toFixed(2),pending:planner?.stats.pending??0});}console.log(JSON.stringify({fixture:'dense crowd, fixed geography, 80 × 0.1s steps',mode:budgeted?'cooperative 2ms planning slices':'synchronous reference',results},null,2));
