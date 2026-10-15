// LEGACY: the pre-v2 simulation, kept only until main.js, world.js and the old tests
// move to src/sim/index.js. Do not build on it. sim-core will delete this file.
import {normalizeProbabilities} from '../routine-policy.js';
import {heightAt,riverX,waterAt} from '../terrain.js';
export {heightAt,riverX,waterAt} from '../terrain.js';
import {prepareSpatialRecord,invalidateSpatial,validatePlacement,spatialContext,plotBounds} from '../spatial.js';
import {findPath,accessPoint,nearestWalkable,moveOnRoute} from '../navigation.js';
export const TYPES = {
  home: { name: 'Cottage', cost: 680, upkeep: 2, capacity: 6, color: '#eee1ca' },
  farm: { name: 'Farmstead', cost: 1150, upkeep: 8, jobs: 10, color: '#d6ba70' },
  market: { name: 'Market', cost: 1800, upkeep: 10, jobs: 12, color: '#e2b196' },
  park: { name: 'Garden', cost: 450, upkeep: 4, color: '#83ac66' },
  utility: { name: 'Workshop', cost: 2400, upkeep: 14, jobs: 16, color: '#97a5a1' },
  road: { name: 'Lane', cost: 60, upkeep: .2, color: '#d9ceb5' },
  bridge: { name: 'Bridge', cost: 1600, upkeep: 5, color: '#e3d1ab' },
};
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const influenceIndexes=new WeakMap(),economyIndexes=new WeakMap();
function valueInfluences(s){const key=`${s.spatialVersion??0}:${s.buildings.length}`;let index=influenceIndexes.get(s);if(index?.key!==key){index={key,buildings:s.buildings.filter(b=>['park','utility','market'].includes(b.type))};influenceIndexes.set(s,index);}return index.buildings;}
function economyIndex(s){const key=`${s.spatialVersion??0}:${s.buildings.length}`;let index=economyIndexes.get(s);if(index?.key!==key){const counts={},byId=new Map(),homeValues=new Map();for(const b of s.buildings){counts[b.type]=(counts[b.type]??0)+1;byId.set(b.id,b);if(b.type==='home')homeValues.set(b.id,landValue(s,b.x,b.z));}index={key,counts,byId,homeValues,mean:homeValues.size?Math.round([...homeValues.values()].reduce((a,b)=>a+b,0)/homeValues.size):0};economyIndexes.set(s,index);}return index;}
export function landValue(state, x, z) {
  const waterfront = Math.max(0, 26 - Math.abs(x - riverX(z))) * 2.2;
  const nature = Math.max(0, heightAt(x, z)) * 4;
  let parks = 0, pollution = 0, commerce = 0;
  for (const b of valueInfluences(state)) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (b.type === 'park') parks += Math.max(0, 26 - d) * 2;
    if (b.type === 'utility') pollution += Math.max(0, 38 - d) * 2.8;
    if (b.type === 'market') commerce += Math.max(0, 24 - d);
  }
  return Math.round(clamp(42 + waterfront + nature + parks + commerce - pollution, 8, 240));
}
export function createState() {
  const state = { version: 1, day: 1, tick: 0, treasury: 14200, food: 210, goods: 90, debt: 0, investorShare: 0, investorDue: 0, nextId: 1, happiness: 78, businessCash: 12000, investorTranches: [], policy: { tax: 10, growth: true }, buildings: [], projects: [], people: [], decisions: [], history: [], ledger: {}, stats: {}, seed: 4817 };
  for (const [type, x, z] of [['home',-20,-8],['home',-30,5],['home',-19,9],['home',-32,-12],['home',-9,-10],['home',-9,8],['farm',-41,14],['market',-22,-21],['park',-4,22],['utility',-45,-24]]) addBuilding(state,type,x,z,false);
  for (let z=-30;z<=24;z+=6) addBuilding(state,'road',-14,z,false,{axis:'z'});
  for (let x=-45;x<=0;x+=6) addBuilding(state,'road',x,-1,false,{axis:'x'});
  const rx=riverX(-1); addBuilding(state,'road',rx-12,-1,false,{axis:'x'});addBuilding(state,'bridge',rx,-1,false);
  for(let x=rx+12;x<rx+39;x+=6) addBuilding(state,'road',x,-1,false,{axis:'x'});
  for(let i=0;i<28;i++) addPerson(state);
  state.decisions.push(proposal('housing',state), proposal('river',state));
  updateStats(state); return state;
}
function random(state) { state.seed = (Math.imul(1664525,state.seed) + 1013904223) >>> 0; return state.seed/4294967296; }
function addPerson(s) {
 const counts=new Map();for(const p of s.people)counts.set(p.home,(counts.get(p.home)??0)+1);
 const homes=s.buildings.filter(b=>b.type==='home'&&(counts.get(b.id)??0)<6);if(!homes.length)return;
 const minimum=Math.min(...homes.map(b=>counts.get(b.id)??0));const available=homes.filter(b=>(counts.get(b.id)??0)===minimum);const home=available[Math.floor(random(s)*available.length)];
 const id=s.nextId++,spawn=accessPoint(s,home,{id,x:home.x,z:home.z+6},'rest')??{x:home.x,z:home.z+5};s.people.push({id,home:home.id,x:spawn.x,z:spawn.z,wealth:110,activity:'Settling in',target:null,energy:65+id%24,fullness:55+id%35,social:45+id%45});
}
export function addBuilding(s,type,x,z,charge=true,options={}) {
  const t=TYPES[type]; if(!t)return {ok:false,error:'Unknown building.'};
  if(charge && s.treasury<t.cost)return {ok:false,error:'The treasury cannot cover this project.'};
  const placement=validatePlacement(s,type,x,z,options.axis,options.ignoreProjectId);if(!placement.ok)return placement;
  if(charge){s.treasury-=t.cost;s.businessCash=(s.businessCash??12000)+t.cost;}
  const b=prepareSpatialRecord({id:s.nextId++,type,x,z,level:1,...(options.axis?{axis:options.axis}:{}),...(Number.isFinite(options.foundationY)?{foundationY:options.foundationY}:{})});s.buildings.push(b);invalidateSpatial(s); updateStats(s); return {ok:true,building:b};
}
function proposal(kind,s) {
 const defs={
 housing:{title:'Room to put down roots',voice:'Mara · village steward',text:'Young families are ready to settle here. Do we build modest cottages together, or leave growth to households?',choices:[{key:'public',label:'Fund three cottages',hint:'−¤2,040 · space for 18 residents'},{key:'organic',label:'Let households build',hint:'No public cost · slower, wealth-dependent growth'}]},
 river:{title:'The river belongs to everyone',voice:'Eli · keeper of the gardens',text:'The east bank could become a riverside garden. The workshop owners would rather keep the funds for expansion.',choices:[{key:'garden',label:'Create a riverside garden',hint:'−¤450 · higher nearby land value'},{key:'industry',label:'Support the workshops',hint:'−¤2,400 · 16 jobs, more pollution'},{key:'wait',label:'Keep our reserves',hint:'No expense · no new facilities'}]},
 food:{title:'A place at every table',voice:'Nora · farmer',text:'Food reserves are thinning. We need another farm, or we will pay to import supplies.',choices:[{key:'farm',label:'Fund a farmstead',hint:'−¤1,150 · 10 jobs, daily food production'},{key:'import',label:'Import 180 food',hint:'−¤720 · buys time; money leaves town'}]},
 debt:{title:'A promise coming due',voice:'Mara · village steward',text:'Debt service is consuming our reserves. Raising taxes helps the treasury but makes life harder for households.',choices:[{key:'tax',label:'Raise tax to 16%',hint:'More public revenue · lower wellbeing'},{key:'hold',label:'Stay the course',hint:'Keep the current tax rate'}]},
 };
 return {id:`${kind}-${s.day}`,kind,created:s.day,...defs[kind]};
}
export function findSite(s,type,side='west') {
 const maxRadius=Math.max(50,Math.sqrt(s.buildings.length)*12);
 for(let r=9;r<maxRadius+100;r+=7)for(let a=0;a<Math.PI*2;a+=.38){const x=Math.round((side==='east'?38:-22)+Math.cos(a)*r),z=Math.round(Math.sin(a)*r);if(validatePlacement(s,type,x,z).ok)return {x,z};}
 return null;
}
export function resolveDecision(s,id,key) {
 const p=s.decisions.find(d=>d.id===id); if(!p||!p.choices.some(c=>c.key===key))return {ok:false,error:'This proposal is no longer available.'};
 const projects=key==='public'?['home','home','home']:key==='garden'?['park']:key==='industry'?['utility']:key==='farm'?['farm']:[];
 const cost=projects.reduce((n,t)=>n+TYPES[t].cost,0)+(key==='import'?720:0);
 if(s.treasury<cost)return {ok:false,error:'Insufficient treasury. Consider a loan or a smaller project.'};
 for(const type of projects){const site=findSite(s,type,key==='garden'?'east':'west');if(!site)return {ok:false,error:'No suitable site found.'};const result=queueProject(s,type,site.x,site.z,{source:'Council decision'});if(!result.ok)return result;}
 if(key==='organic')s.policy.growth=true;
 if(key==='import'){s.treasury-=720;s.food+=180;}
 if(key==='tax')s.policy.tax=16;
 s.history.unshift({day:s.day,text:`${p.title}: ${p.choices.find(c=>c.key===key).label}`}); s.decisions=s.decisions.filter(d=>d.id!==id); updateStats(s);return {ok:true};
}
export function finance(s,kind) {
 if(kind==='loan'){s.treasury+=10000;s.debt+=10000;s.history.unshift({day:s.day,text:'Borrowed ¤10,000 at 0.08% daily interest; 0.2% daily principal repayment.'});}
 if(kind==='investor'){if(s.investorShare>=.45)return {ok:false,error:'Investors already hold the maximum 45% revenue share.'};s.treasury+=15000;s.investorShare+=.15;s.investorDue=s.day+90;s.investorTranches??=[];s.investorTranches.push({share:.15,due:s.day+90});s.history.unshift({day:s.day,text:'Accepted ¤15,000 for an additional permanent 15% share of tax revenue, starting in 90 days.'});}
 if(kind==='grant'){s.treasury+=5000;s.history.unshift({day:s.day,text:'Added a ¤5,000 sandbox cash infusion. This creates money outside the town economy.'});}
 updateStats(s);return {ok:true};
}
export function updateStats(s) {
 const index=economyIndex(s),count=t=>index.counts[t]??0,jobs=count('farm')*10+count('market')*12+count('utility')*16,pop=s.people.length;
 s.stats={population:pop,jobs,employed:Math.min(pop,jobs),capacity:count('home')*6,homes:count('home'),landValue:index.mean,parks:count('park')};
}
export function stepDay(s) {
 s.day++;updateStats(s);const economy=economyIndex(s);const {employed,population}=s.stats;
 // Wage payments circulate from businesses to households. Taxes transfer to the treasury.
 const requestedPayroll=employed*5;const payroll=Math.min(requestedPayroll,Math.max(0,s.businessCash??12000));const wagesPerPerson=population?payroll/population:0;const wageFactor=requestedPayroll?payroll/requestedPayroll:0;
 let tax=0,consumption=0;for(const p of s.people){const wages=wagesPerPerson;const propertyTax=(economy.homeValues.get(p.home)??0)*.001;const paid=Math.min(p.wealth+wages,wages*s.policy.tax/100+propertyTax);p.wealth+=wages-paid;tax+=paid;const spent=Math.min(p.wealth,2);p.wealth-=spent;consumption+=spent;}
 const farms=economy.counts.farm??0;
 const workshops=economy.counts.utility??0;
 const laborRatio=s.stats.jobs?employed/s.stats.jobs*wageFactor:0;
 const produced=farms*24*laborRatio;s.food=Math.max(0,s.food+produced-population*.6);
 s.goods=Math.max(0,s.goods+workshops*10*laborRatio-population*.15);
 const upkeep=s.buildings.reduce((n,b)=>n+TYPES[b.type].upkeep,0);
 const interest=s.debt*.0008;const principal=Math.min(s.debt,s.debt*.002);const tranches=s.investorTranches??[{share:s.investorShare,due:s.investorDue}];const dividend=tax*tranches.filter(t=>s.day>=t.due).reduce((n,t)=>n+t.share,0);
 // Treasury expenses return to the business balance, except external financing service.
 const business=s.businessCash??12000;s.businessCash=business+consumption+upkeep-payroll;
 s.treasury+=tax-upkeep-interest-principal-dividend;s.debt-=principal;
 s.ledger={tax,upkeep,interest,principal,dividend,net:tax-upkeep-interest-principal-dividend,payroll,consumption,produced};
 const pollution=economy.counts.utility??0;
 s.happiness=Math.round(clamp(72+s.stats.parks*4+(s.food>population*2?9:-22)+(population?employed/population*wageFactor-.6:0)*18-s.policy.tax*.5-pollution*1.5,5,98));
 if(s.day%5===0&&s.happiness>55&&s.stats.capacity>population&&s.food>population) {for(let i=0;i<Math.min(3,s.stats.capacity-population);i++)addPerson(s);}
 if(s.day%3===0)autonomousDevelopment(s);
 if(s.day%4===0&&produced>0)s.history.unshift({day:s.day,text:`Farmers harvested ${Math.round(produced)} crates for the village.`});
 if(s.day%12===0){const kind=s.food<population*3?'food':s.debt>5000?'debt':s.stats.capacity-population<8?'housing':'river';if(!s.decisions.some(p=>p.kind===kind))s.decisions.push(proposal(kind,s));}
 if(s.food===0&&s.day%7===0&&population>8){const leaver=s.people.pop();const home=s.buildings.find(b=>b.id===leaver.home);if(home)s.history.unshift({day:s.day,text:'A resident left town because food was unavailable.'});}
 s.history=s.history.slice(0,100);updateStats(s);
}
export function queueProject(s,type,x,z,{payer='treasury',source='Town project'}={}) {
 s.projects??=[];const cost=TYPES[type]?.cost;if(!cost)return {ok:false,error:'Unknown building.'};
 const placement=validatePlacement(s,type,x,z);if(!placement.ok)return placement;
 const available=s.people.reduce((n,p)=>n+Math.max(0,p.wealth-40),0);
 if((payer==='households'?available:s.treasury)<cost)return {ok:false,error:payer==='households'?'Households need more savings.':'The treasury cannot cover this project.'};
 if(payer==='households'){let remaining=cost;for(const p of s.people){const share=Math.min(Math.max(0,p.wealth-40),remaining);p.wealth-=share;remaining-=share;if(remaining<.0001)break;}}else s.treasury-=cost;
 s.businessCash=(s.businessCash??12000)+cost;
 const project={id:s.nextId++,type,x,z,progress:0,workRequired:type==='road'?8:type==='park'?15:30,workers:[],payer,source,started:s.day};prepareSpatialRecord(project);s.projects.push(project);invalidateSpatial(s);
 s.history.unshift({day:s.day,text:`${payer==='households'?'Residents pooled their savings for':'Approved'} a ${TYPES[type].name.toLowerCase()}. Builders are on their way.`});return {ok:true,project};
}
export function autonomousDevelopment(s){
 s.projects??=[];if(!s.policy.growth||s.happiness<45||s.projects.filter(p=>p.payer==='households').length>=2)return;
 const planned=t=>s.buildings.filter(b=>b.type===t).length+s.projects.filter(p=>p.type===t).length;
 const pop=s.people.length;let type;
 if(s.food<pop*4&&planned('farm')<Math.ceil(pop/25))type='farm';
 else if(planned('home')*6-pop<14)type='home';
 else if(s.stats.jobs<pop+5&&planned('market')<Math.ceil(pop/35))type='market';
 else if(s.goods<pop*2&&planned('utility')<Math.ceil(pop/50))type='utility';
 if(type){const site=findSite(s,type);if(site)queueProject(s,type,site.x,site.z,{payer:'households',source:'Resident cooperative'});}
}
function assignBuilders(s){
 const active=s.projects.slice(0,2),allAssigned=new Set(),ids=new Set(active.length?s.people.map(p=>p.id):[]),limit=Math.min(3,Math.max(1,Math.floor(s.people.length/8)));
 for(const project of active){project.workers=project.workers.filter(id=>ids.has(id)&&!allAssigned.has(id));for(const id of project.workers)allAssigned.add(id);
 while(project.workers.length<limit){let nearest=null,best=Infinity;for(const p of s.people)if(!allAssigned.has(p.id)){const d=distance(p,project);if(d<best){best=d;nearest=p;}}if(!nearest)break;project.workers.push(nearest.id);allAssigned.add(nearest.id);}}
}
const simulationIndexes=new WeakMap();
function simulationIndex(s,key){let index=simulationIndexes.get(s);if(index?.key!==key){const byId=new Map(),byType=new Map();for(const b of s.buildings){byId.set(b.id,b);if(!byType.has(b.type))byType.set(b.type,[]);byType.get(b.type).push(b);}index={key,byId,byType};simulationIndexes.set(s,index);}return index;}
function planTaskRoute(s,p,spot,task,planner){
 task.route=[];task.blocked=false;task.pending=false;task.needsRoute=false;
 if(!spot){task.blocked=true;return;}
 if(planner){task.needsRoute=!planner.request(s,p,spot,task);return;}
 const route=findPath(s,p,spot);task.route=route??[];task.blocked=!route;
}
export function stepAgents(s,dt,planner=null) {
 s.projects??=[];assignBuilders(s);s.tick=(s.tick??0)+dt;
 const active=s.projects.slice(0,2);const navigation=spatialContext(s);const index=simulationIndex(s,navigation.key),buildingById=index.byId;
 for(const p of s.people){
 if(!navigation.walkable(p.x,p.z)){const safe=nearestWalkable(navigation,p,12);if(safe){p.x=safe.x;p.z=safe.z;}p.task=null;}
 p.energy=clamp((p.energy??75)-dt*.24,0,100);p.fullness=clamp((p.fullness??75)-dt*.35,0,100);p.social=clamp((p.social??65)-dt*.15,0,100);
 const project=active.find(project=>project.workers.includes(p.id));
 const intent=p.routineIntent&&p.routineIntent.expires>=s.day?p.routineIntent:null;
 const revision=project?`build:${project.id}`:intent?`ai:${intent.activity}`:null;
 // Routine advice applies at task boundaries. Lease renewals and resampling must
 // not discard in-flight paths; only construction or critical needs interrupt.
 const urgent=p.fullness<20?'shop':p.energy<20?'rest':null;
 if(!p.task||p.task.elapsed>65||(project&&p.task.revision!==revision)||(!project&&p.task.kind==='build')||(!project&&urgent&&p.task.kind!==urgent)){
 let kind=project?'build':urgent??intent?.activity??(p.fullness<35?'shop':p.energy<32?'rest':p.social<30?'leisure':['work','shop','work','leisure','rest'][(p.id+(p.routineStep??0))%5]);p.routineStep=(p.routineStep??0)+1;
 const types={rest:['home'],work:['farm','utility'],shop:['market'],leisure:['park','market'],build:[]}[kind];let target;
 if(project)target=project;
 else if(kind==='rest')target=buildingById.get(p.home);
 else{const candidates=types.flatMap(type=>index.byType.get(type)??[]);target=candidates.length?candidates[(p.id+p.routineStep)%candidates.length]:buildingById.get(p.home);}
 if(!target)continue;
 const spot=accessPoint(s,target,p,kind);p.task={kind,revision,target:target.id,elapsed:0,dwell:0,route:[],blocked:false,navRevision:navigation.key};planTaskRoute(s,p,spot,p.task,planner);p.target=target.id;p.phase=intent?`${s.day%4}:${intent.activity}`:s.day%4;
 }
 const task=p.task;if(task.navRevision!==navigation.key||task.needsRoute||(task.blocked&&task.elapsed>=(task.retryAt??3))){const target=active.find(v=>v.id===task.target)??buildingById.get(task.target);const spot=target?accessPoint(s,target,p,task.kind):null;task.navRevision=navigation.key;planTaskRoute(s,p,spot,task,planner);task.retryAt=task.elapsed+3;}if(task.pending||task.needsRoute){p.moving=false;p.activity='Finding a clear route';continue;}task.elapsed+=dt;const labels={rest:'Resting at home',work:'Working',shop:'Shopping at the market',leisure:'Enjoying the gardens',build:'Building '+TYPES[project?.type??'home'].name.toLowerCase()};
 if(task.route.length){p.moving=moveOnRoute(navigation,p,dt*(task.kind==='build'?4:3.4));p.activity=task.kind==='build'?'Carrying building supplies':task.kind==='work'?'Walking to work':task.kind==='shop'?'Heading to the market':task.kind==='rest'?'Going home':'Walking to the gardens';}
 else{p.moving=false;p.activity=task.blocked?'Waiting for a clear route':labels[task.kind];task.dwell+=dt;
 if(!task.blocked&&task.kind==='rest')p.energy=clamp(p.energy+dt*5,0,100);if(!task.blocked&&task.kind==='shop')p.fullness=clamp(p.fullness+dt*6,0,100);if(!task.blocked&&task.kind==='leisure')p.social=clamp(p.social+dt*5,0,100);
 if(!project&&task.dwell>(task.kind==='work'?7:4)+p.id%3)p.task=null;}
 }
 const peopleById=active.length?new Map(s.people.map(p=>[p.id,p])):null;for(const project of active){const working=project.workers.filter(id=>{const p=peopleById.get(id);return p&&p.task?.kind==='build'&&!p.task.blocked&&!p.task.pending&&!p.task.needsRoute&&!p.moving&&distance(p,project)<(project.type==='bridge'?12:Math.hypot(plotBounds(project).maxX-project.x,plotBounds(project).maxZ-project.z)+1.8);}).length;project.progress=clamp(project.progress+dt*working/project.workRequired,0,1);
 if(project.progress>=1){const result=addBuilding(s,project.type,project.x,project.z,false,{ignoreProjectId:project.id,foundationY:project.foundationY,axis:project.axis});if(result.ok){s.projects=s.projects.filter(p=>p.id!==project.id);invalidateSpatial(s);s.history.unshift({day:s.day,text:`${TYPES[project.type].name} completed by the village builders${project.payer==='households'?' · funded by residents':''}.`});for(const p of s.people)if(project.workers.includes(p.id))p.task=null;}}}
 s.history=s.history.slice(0,100);
}
export function serialize(s) { return JSON.stringify(s); }
export function restore(raw) {
 const s=JSON.parse(raw);const invalid=()=>{throw new Error('Unsupported or invalid save');};
 if(!s||s.version!==1||!Array.isArray(s.buildings)||!Array.isArray(s.people)||!Array.isArray(s.decisions)||!Array.isArray(s.history)||!s.policy||!s.ledger)invalid();
 for(const k of ['day','treasury','food','goods','debt','nextId','happiness','seed','investorShare','investorDue'])if(!Number.isFinite(s[k]))invalid();
 if(s.day<1||s.food<0||s.goods<0||s.debt<0||s.investorShare<0||s.investorShare>.451||s.policy.tax<0||s.policy.tax>25||typeof s.policy.growth!=='boolean')invalid();
 const ids=new Set();for(const b of s.buildings){if(!TYPES[b.type]||!Number.isSafeInteger(b.id)||!Number.isFinite(b.x)||!Number.isFinite(b.z)||ids.has(b.id))invalid();ids.add(b.id);}
 for(const p of s.people){if(!Number.isSafeInteger(p.id)||ids.has(p.id)||!Number.isFinite(p.x)||!Number.isFinite(p.z)||!Number.isFinite(p.wealth)||p.wealth<0||!s.buildings.some(b=>b.type==='home'&&b.id===p.home))invalid();if(p.task&&(!['rest','work','shop','leisure','build'].includes(p.task.kind)||!Array.isArray(p.task.route)||!p.task.route.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.z))||!Number.isFinite(p.task.elapsed)||!Number.isFinite(p.task.dwell)))invalid();if(p.routineIntent&&(!['rest','work','shop','leisure'].includes(p.routineIntent.activity)||!Number.isSafeInteger(p.routineIntent.expires)||!Number.isFinite(p.routineIntent.confidence)))invalid();ids.add(p.id);}
 for(const d of s.decisions){if(typeof d.id!=='string'||typeof d.title!=='string'||typeof d.text!=='string'||typeof d.voice!=='string'||!Array.isArray(d.choices)||!d.choices.every(c=>typeof c.key==='string'&&typeof c.label==='string'&&typeof c.hint==='string'))invalid();}
 if(s.investorTranches&&!s.investorTranches.every(t=>Number.isFinite(t.share)&&Number.isFinite(t.due)&&t.share>=0&&t.share<=.45))invalid();
 s.projects??=[];for(const p of s.projects){if(!Number.isSafeInteger(p.id)||!TYPES[p.type]||!Number.isFinite(p.x)||!Number.isFinite(p.z)||!Number.isFinite(p.progress)||p.progress<0||p.progress>1||!Number.isFinite(p.workRequired)||p.workRequired<=0||!Array.isArray(p.workers))invalid();if(ids.has(p.id))invalid();ids.add(p.id);}
 s.businessCash??=12000;if(!Number.isFinite(s.businessCash)||s.businessCash<0)invalid();
 let maximumId=0;for(const id of ids)maximumId=Math.max(maximumId,id);if(s.nextId<=maximumId)invalid();for(const b of [...s.buildings,...s.projects])prepareSpatialRecord(b);for(const p of s.people)if(p.task&&(!p.task.navRevision||p.task.pending||p.task.needsRoute))p.task=null;s.spatialVersion??=0;updateStats(s);return s;
}

export function applyRoutineIntents(s,intents,requestDay){
 if(!Number.isSafeInteger(requestDay)||requestDay>s.day||s.day-requestDay>2||!Array.isArray(intents))return 0;
 let applied=0;const seen=new Set(),peopleById=new Map(s.people.map(p=>[p.id,p]));for(const i of intents){if(!i||seen.has(i.personId)||!['rest','work','shop','leisure'].includes(i.activity)||!Number.isFinite(i.confidence)||i.confidence<0||(i.confidence<.45&&!normalizeProbabilities(i.probabilities))||i.confidence>1)continue;if(i.probabilities){const probabilities=normalizeProbabilities(i.probabilities);if(!probabilities||probabilities[i.activity]<=0)continue;}const p=peopleById.get(i.personId);if(!p)continue;seen.add(p.id);p.routineIntent={activity:i.activity,confidence:i.confidence,expires:requestDay+2};applied++;}return applied;
}
