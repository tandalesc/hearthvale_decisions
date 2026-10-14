import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,stepAgents,stepDay,queueProject,findSite,restore,serialize} from '../src/simulation.js';
import {createSurface,spatialContext,plotBounds,foundationHeight,validatePlacement,invalidateSpatial} from '../src/spatial.js';
import {findPath,moveOnRoute,accessPoint} from '../src/navigation.js';
import {riverX} from '../src/terrain.js';
const blank=buildings=>({buildings,projects:[]});
const verifyRoute=(surface,route)=>{assert.ok(route?.length>1,'reachable path');for(let i=1;i<route.length;i++)assert.ok(surface.segmentClear(route[i-1],route[i]),`clear segment ${i}`);};
test('all plot interiors and mesh-sized foundation margins are level on slopes',()=>{
 const s=blank([{id:1,type:'home',x:-60,z:30},{id:2,type:'farm',x:-40,z:60}]);const c=createSurface(s);
 for(const b of s.buildings){const r=plotBounds(b,1.05);for(let x=r.minX;x<r.maxX;x+=.35)for(let z=r.minZ;z<r.maxZ;z+=.35)assert.ok(Math.abs(c.terrainHeight(x,z)-foundationHeight(b))<1e-9);}
});
test('roads grade their width to the same support height and ramp to the bridge',()=>{
 const rx=riverX(-1),s=blank([{id:1,type:'road',axis:'x',x:-60,z:30},{id:2,type:'bridge',x:rx,z:-1},{id:3,type:'road',axis:'x',x:rx-12,z:-1}]),c=createSurface(s);
 for(let x=-63;x<=-57;x+=.5)assert.ok(Math.abs(c.terrainHeight(x,29)-c.terrainHeight(x,31))<1e-9);
 assert.ok(c.segmentClear({x:rx-14,z:-1},{x:rx+10,z:-1}));assert.equal(c.walkHeight(rx,-1),1.46);
});
test('placement rejects footprint water and garden or building overlap',()=>{
 const s=blank([{id:1,type:'home',x:-20,z:0}]);assert.equal(validatePlacement(s,'market',-14,0).ok,false);assert.equal(validatePlacement(s,'farm',riverX(30)-8,30).ok,false);assert.equal(validatePlacement(s,'home',-40,0).ok,true);
});
test('routes go around whole building plots, including diagonal corners',()=>{
 const s=blank([{id:1,type:'market',x:-30,z:0}]),c=spatialContext(s),start={x:-40,z:0},goal={x:-20,z:0};assert.equal(c.segmentClear(start,goal),false);const route=findPath(s,start,goal);verifyRoute(c,route);assert.ok(route.some(p=>p.z<-3.27||p.z>4.97));const person={...start,task:{route:route.slice()}};for(let i=0;i<100;i++){moveOnRoute(c,person,.37);assert.ok(c.walkable(person.x,person.z));}assert.ok(Math.hypot(person.x-goal.x,person.z-goal.z)<.001);
});
test('river travel uses completed bridges; unreachable destinations never get straight-line shortcuts',()=>{
 const rx=riverX(-1),s=blank([]),start={x:rx-13,z:-1},goal={x:rx+13,z:-1};assert.equal(findPath(s,start,goal),null);s.projects.push({id:1,type:'bridge',x:rx,z:-1});invalidateSpatial(s);assert.equal(findPath(s,start,goal),null);s.buildings.push(s.projects.pop());invalidateSpatial(s);const route=findPath(s,start,goal);verifyRoute(spatialContext(s),route);assert.ok(route.some(p=>p.x>rx-3&&p.x<rx+3));
});
test('existing routes stop before newly blocked segments and use accessible work destinations',()=>{
 const s=blank([]),p={x:-40,z:0,task:{route:[{x:-20,z:0}]}};s.projects.push({id:1,type:'home',x:-30,z:0});invalidateSpatial(s);const c=spatialContext(s);moveOnRoute(c,p,25);assert.ok(c.walkable(p.x,p.z));assert.equal(p.task.blocked,true);const destination=accessPoint(s,s.projects[0],{x:-40,z:0,id:1},'build');assert.ok(c.walkable(destination.x,destination.z));assert.ok(!c.solidAt(destination.x,destination.z));
});
test('residents remain outside structures while construction changes the town',()=>{
 const s=createState();stepAgents(s,.01);const site=findSite(s,'home');assert.ok(queueProject(s,'home',site.x,site.z).ok);let completed=false;
 for(let frame=0;frame<900;frame++){stepAgents(s,.12);if(frame%50===49)stepDay(s);const c=spatialContext(s);for(const p of s.people)assert.ok(c.walkable(p.x,p.z),`resident ${p.id} at ${p.x},${p.z}`);completed ||= s.history.some(e=>e.text.includes('completed'));}assert.ok(completed);
});
test('legacy saves gain persistent foundations and discard routes that crossed buildings',()=>{
 const s=createState();for(const b of s.buildings){delete b.foundationY;delete b.axis;}s.people[0].task={kind:'work',elapsed:2,dwell:0,route:[{x:0,z:0}]};const loaded=restore(serialize(s));assert.ok(loaded.buildings.every(b=>Number.isFinite(b.foundationY)));assert.equal(loaded.people[0].task,null);assert.equal(loaded.buildings.filter(b=>b.type==='home').length,6);
});
