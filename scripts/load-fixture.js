import {createState} from '../src/sim/legacy.js';
// Dense crowd fixture: identical geography at each population isolates resident
// simulation/render cost; it deliberately exceeds ordinary housing capacity.
export function crowdFixture(population){const s=createState(),seed=s.people.map(p=>({...p}));s.people=Array.from({length:population},(_,i)=>({...seed[i%seed.length],id:s.nextId++,task:null,routineStep:i%5}));s.policy.growth=false;return s;}
export function compatibleCrowdFixture(population){const s=crowdFixture(population),home=s.people[0].home;for(const p of s.people)Object.assign(p,{home,x:-30,z:0,energy:80,fullness:80,social:80,wealth:100});return s;}
