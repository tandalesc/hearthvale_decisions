import {heightAt,waterAt} from './terrain.js';

// Plot bounds include foundations, yards and work areas; collision bounds are
// shared by placement, navigation and rendering. Coordinates are local x/z.
export const FOOTPRINTS={
 home:{minX:-2.85,maxX:2.85,minZ:-3.25,maxZ:3.5},
 farm:{minX:-4.35,maxX:4.35,minZ:-3.95,maxZ:6.8},
 market:{minX:-3.65,maxX:3.65,minZ:-2.95,maxZ:4.65},
 utility:{minX:-3.65,maxX:3.65,minZ:-3.35,maxZ:4.6},
 park:{minX:-4.9,maxX:4.9,minZ:-4.9,maxZ:4.9},
 road:{minX:-3,maxX:3,minZ:-1.25,maxZ:1.25},
 bridge:{minX:-9,maxX:9,minZ:-1.95,maxZ:1.95},
};
export const PERSON_RADIUS=.32;
export function roadAxis(b){return b.axis??(Math.abs(b.x+15)<.1?'z':'x');}
export function plotBounds(b,margin=0){const f=FOOTPRINTS[b.type];if(!f)throw new Error('Unknown footprint');const axis=b.type==='road'&&roadAxis(b)==='z';return {minX:b.x+(axis?f.minZ:f.minX)-margin,maxX:b.x+(axis?f.maxZ:f.maxX)+margin,minZ:b.z+(axis?f.minX:f.minZ)-margin,maxZ:b.z+(axis?f.maxX:f.maxZ)+margin};}
export function contains(r,x,z){return x>=r.minX&&x<=r.maxX&&z>=r.minZ&&z<=r.maxZ;}
export function overlaps(a,b,gap=0){return a.minX<b.maxX+gap&&a.maxX>b.minX-gap&&a.minZ<b.maxZ+gap&&a.maxZ>b.minZ-gap;}
function outsideDistance(r,x,z){return Math.hypot(Math.max(r.minX-x,0,x-r.maxX),Math.max(r.minZ-z,0,z-r.maxZ));}
function smooth(t){return t*t*(3-2*t);}
export function foundationHeight(b){return b.type==='bridge'?1:Number.isFinite(b.foundationY)?b.foundationY:Math.max(.22,heightAt(b.x,b.z));}
export function prepareSpatialRecord(b){if(!Number.isFinite(b.foundationY))b.foundationY=foundationHeight(b);if(b.type==='road'&&!b.axis)b.axis=roadAxis(b);return b;}
export function collisionBounds(b){
 if(b.type==='road'||b.type==='bridge')return [];
 if(b.type==='park'){const result=[{minX:b.x-1.85,maxX:b.x+1.85,minZ:b.z-1.85,maxZ:b.z+1.85}];for(let i=0;i<4;i++){const a=i*Math.PI/2,x=b.x+Math.cos(a)*3.5,z=b.z+Math.sin(a)*3.5;const w=i%2?.4:1,d=i%2?1:.4;result.push({minX:x-w,maxX:x+w,minZ:z-d,maxZ:z+d});}return result;}
 return [plotBounds(b)];
}
function binKey(x,z){return `${Math.floor(x/16)},${Math.floor(z/16)}`;}
function indexItems(items,getBounds){const bins=new Map();for(const item of items){const r=getBounds(item);for(let x=Math.floor(r.minX/16);x<=Math.floor(r.maxX/16);x++)for(let z=Math.floor(r.minZ/16);z<=Math.floor(r.maxZ/16);z++){const key=`${x},${z}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(item);}}return (x,z)=>bins.get(binKey(x,z))??[];}
export function createSurface(s){
 const records=[...s.buildings,...(s.projects??[])];records.forEach(prepareSpatialRecord);
 const pads=records.filter(b=>!['road','bridge'].includes(b.type)).map(b=>({b,bounds:plotBounds(b,1.5),core:plotBounds(b),y:foundationHeight(b)}));
 const nearbyPads=indexItems(pads,p=>({minX:p.bounds.minX-2.2,maxX:p.bounds.maxX+2.2,minZ:p.bounds.minZ-2.2,maxZ:p.bounds.maxZ+2.2}));
 const roads=records.filter(b=>b.type==='road');const nearbyRoads=indexItems(roads,b=>plotBounds(b,.9));const bridges=s.buildings.filter(b=>b.type==='bridge');
 const obstacles=[];for(const b of records){for(const r of collisionBounds(b))obstacles.push({...r,owner:b.id});}
 const nearbyObstacles=indexItems(obstacles,r=>({minX:r.minX-PERSON_RADIUS,maxX:r.maxX+PERSON_RADIUS,minZ:r.minZ-PERSON_RADIUS,maxZ:r.maxZ+PERSON_RADIUS}));
 function padHeight(x,z){const natural=heightAt(x,z);const local=nearbyPads(x,z);const core=local.find(p=>contains(p.core,x,z));if(core)return core.y;let total=0,weighted=0;for(const p of local){const d=outsideDistance(p.bounds,x,z);if(d<2.2){const w=1-smooth(Math.min(1,d/2.2));if(d===0)return p.y;total+=w;weighted+=w*p.y;}}return total?natural+(weighted/total-natural)*Math.min(1,total):natural;}
 function bridgeAt(x,z,margin=0){return bridges.find(b=>Math.abs(x-b.x)<=9+margin&&Math.abs(z-b.z)<=1.58+margin);}
 function roadSupport(x,z){let y=padHeight(x,z);for(const b of bridges){const d=Math.abs(x-b.x);if(Math.abs(z-b.z)<2.1&&d<18){const w=1-smooth(Math.max(0,Math.min(1,(d-9)/9)));y+=(1.46-y)*w;}}return y;}
 function terrainHeight(x,z){if(waterAt(x,z))return heightAt(x,z);const candidates=nearbyPads(x,z);if(candidates.some(p=>contains(p.bounds,x,z)))return padHeight(x,z);
 let total=0,weighted=0;for(const b of nearbyRoads(x,z)){const d=outsideDistance(plotBounds(b),x,z);if(d<.9){const w=1-smooth(Math.min(1,d/.9));const y=roadAxis(b)==='x'?roadSupport(x,b.z):roadSupport(b.x,z);total+=w;weighted+=y*w;}}
 const base=padHeight(x,z);return total?base+(weighted/total-base)*Math.min(1,total):base;
 }
 function solidAt(x,z,clearance=PERSON_RADIUS){return nearbyObstacles(x,z).some(r=>contains({minX:r.minX-clearance,maxX:r.maxX+clearance,minZ:r.minZ-clearance,maxZ:r.maxZ+clearance},x,z));}
 function walkable(x,z){return !solidAt(x,z)&&(!waterAt(x,z)||!!bridgeAt(x,z));}
 function walkHeight(x,z){return bridgeAt(x,z)?.type==='bridge'?1.46:terrainHeight(x,z)+.08;}
 function onRoad(x,z){return nearbyRoads(x,z).some(b=>contains(plotBounds(b,.2),x,z))||!!bridgeAt(x,z);}
 function segmentClear(a,b){const length=Math.hypot(b.x-a.x,b.z-a.z),steps=Math.max(1,Math.ceil(length/.24));let previous=walkHeight(a.x,a.z);for(let i=0;i<=steps;i++){const t=i/steps,x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t;if(!walkable(x,z))return false;const y=walkHeight(x,z);if(Math.abs(y-previous)>.5)return false;previous=y;}return true;}
 return {terrainHeight,walkHeight,walkable,segmentClear,onRoad,solidAt,bridgeAt,pads,obstacles,records};
}
const surfaces=new WeakMap();
export function spatialContext(s){const key=`${s.spatialVersion??0}:${s.buildings.length}:${s.projects?.length??0}`;let cached=surfaces.get(s);if(!cached||cached.key!==key){cached={key,surface:createSurface(s)};surfaces.set(s,cached);}return {...cached.surface,key};}
export function invalidateSpatial(s){s.spatialVersion=(s.spatialVersion??0)+1;}
export function validatePlacement(s,type,x,z,axis,ignoreId){
 if(!FOOTPRINTS[type]||!Number.isFinite(x)||!Number.isFinite(z))return {ok:false,error:'Invalid building location.'};const b={type,x,z,axis},bounds=plotBounds(b);
 if(type==='bridge'){if(!waterAt(x,z))return {ok:false,error:'Place a bridge across the river.'};}
 else{const nx=Math.ceil((bounds.maxX-bounds.minX)/.8),nz=Math.ceil((bounds.maxZ-bounds.minZ)/.8);for(let ix=0;ix<=nx;ix++)for(let iz=0;iz<=nz;iz++)if(waterAt(bounds.minX+(bounds.maxX-bounds.minX)*ix/nx,bounds.minZ+(bounds.maxZ-bounds.minZ)*iz/nz))return {ok:false,error:'The entire footprint must be on dry land.'};if(heightAt(x,z)>4.6&&type!=='road')return {ok:false,error:'The slope is too steep for this building.'};}
 for(const other of [...s.buildings,...(s.projects??[])]){if(other.id===ignoreId)continue;if((type==='road'||type==='bridge')&&(other.type==='road'||other.type==='bridge'))continue;const gap=['road','bridge'].includes(type)||['road','bridge'].includes(other.type)?.35:3.2;if(overlaps(bounds,plotBounds(other),gap))return {ok:false,error:'Leave space for foundations, gardens and access paths.'};}
 return {ok:true};
}

// ---------------------------------------------------------------------------
// LEGACY (pre-v2). The old continuous-space navigation, kept only so that
// src/simulation.js and src/world.js keep building until they are replaced by
// src/sim/ and src/render/. New code uses src/navigation.js and src/sim/roads.js.
import {riverX as legacyRiverX} from './terrain.js';
class LegacyHeap {
 constructor(){this.items=[];}
 push(item){const a=this.items;a.push(item);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p].f<=item.f)break;a[i]=a[p];i=p;}a[i]=item;}
 pop(){const a=this.items,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].f<a[c].f)c++;if(a[c].f>=last.f)break;a[i]=a[c];i=c;}a[i]=last;}return first;}
 get length(){return this.items.length;}
}
export function nearestWalkable(context,point,maxRadius=10){if(context.walkable(point.x,point.z))return {...point};for(let r=.5;r<=maxRadius;r+=.5)for(let i=0;i<24;i++){const a=i*Math.PI/12,p={x:point.x+Math.cos(a)*r,z:point.z+Math.sin(a)*r};if(context.walkable(p.x,p.z))return p;}return null;}
export function accessPoint(s,target,p,kind){const c=spatialContext(s),r=plotBounds(target);const candidates=[];
 if(target.type==='bridge'){const side=Math.sign(p.x-legacyRiverX(p.z))||-1;candidates.push({x:target.x+side*10,z:target.z});}
 else if(target.type==='park'&&kind!=='build'){for(let i=0;i<8;i++){const a=(p.id%8+i)*Math.PI/4+.22;candidates.push({x:target.x+Math.cos(a)*3.1,z:target.z+Math.sin(a)*3.1});}}
 else{const offset=((p.id%5)-2)*.4;candidates.push({x:target.x+offset,z:r.maxZ+.8},{x:r.minX-.8,z:(r.minZ+r.maxZ)/2+offset},{x:r.maxX+.8,z:(r.minZ+r.maxZ)/2+offset},{x:target.x+offset,z:r.minZ-.8});}
 return candidates.filter(p=>c.walkable(p.x,p.z)).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0]??nearestWalkable(c,{x:target.x,z:r.maxZ+1},6);
}
const legacyDirections=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
function legacySearch(context,start,goal,bounds,budget){
 const sx=Math.round(start.x),sz=Math.round(start.z),gx=Math.round(goal.x),gz=Math.round(goal.z);const key=(x,z)=>`${x},${z}`;
 const open=new LegacyHeap(),nodes=new Map(),closed=new Set();const h=(x,z)=>Math.hypot(x-gx,z-gz)*.55;
 const first={x:sx,z:sz,g:0,f:h(sx,sz),parent:null};nodes.set(key(sx,sz),first);open.push(first);let count=0;
 while(open.length&&count++<budget){const current=open.pop(),id=key(current.x,current.z);if(closed.has(id))continue;closed.add(id);
 if(Math.hypot(current.x-goal.x,current.z-goal.z)<1.5&&context.segmentClear(current,goal)){const path=[goal];let n=current;while(n){path.push({x:n.x,z:n.z});n=n.parent;}path.reverse();if(!context.segmentClear(start,path[0]))return null;return [start,...path];}
 for(const [dx,dz]of legacyDirections){const x=current.x+dx,z=current.z+dz;if(x<bounds.minX||x>bounds.maxX||z<bounds.minZ||z>bounds.maxZ||closed.has(key(x,z))||!context.walkable(x,z))continue;
 if(dx&&dz&&(!context.walkable(current.x+dx,current.z)||!context.walkable(current.x,current.z+dz)))continue;
 if(!context.segmentClear(current,{x,z}))continue;const g=current.g+Math.hypot(dx,dz)*(context.onRoad(x,z)?.55:1.2)+Math.abs(context.walkHeight(x,z)-context.walkHeight(current.x,current.z))*.3;
 const known=nodes.get(key(x,z));if(!known||g<known.g){const n={x,z,g,f:g+h(x,z),parent:current};nodes.set(key(x,z),n);open.push(n);}}
 }
 return null;
}
export function findPath(s,start,target){const context=spatialContext(s);if(!context.walkable(start.x,start.z)||!context.walkable(target.x,target.z))return null;
 const candidates=[];for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)candidates.push({x:Math.round(start.x)+dx,z:Math.round(start.z)+dz});const snapped=candidates.sort((a,b)=>Math.hypot(a.x-start.x,a.z-start.z)-Math.hypot(b.x-start.x,b.z-start.z)).find(p=>context.walkable(p.x,p.z)&&context.segmentClear(start,p));if(!snapped)return null;
 const cross=(start.x-legacyRiverX(start.z))*(target.x-legacyRiverX(target.z))<0;const bridge=cross?s.buildings.filter(b=>b.type==='bridge').sort((a,b)=>(Math.hypot(a.x-start.x,a.z-start.z)+Math.hypot(a.x-target.x,a.z-target.z))-(Math.hypot(b.x-start.x,b.z-start.z)+Math.hypot(b.x-target.x,b.z-target.z)))[0]:null;
 if(cross&&!bridge)return null;
 for(const margin of [10,24,48]){const bounds={minX:Math.floor(Math.min(start.x,target.x,bridge?.x??start.x)-margin),maxX:Math.ceil(Math.max(start.x,target.x,bridge?.x??start.x)+margin),minZ:Math.floor(Math.min(start.z,target.z,bridge?.z??start.z)-margin),maxZ:Math.ceil(Math.max(start.z,target.z,bridge?.z??start.z)+margin)};const route=legacySearch(context,snapped,target,bounds,20000);if(route){route[0]={...start};return route;}}
 return null;
}
export function moveOnRoute(context,p,distance){let remaining=distance;while(p.task.route.length&&remaining>0){const point=p.task.route[0],dx=point.x-p.x,dz=point.z-p.z,d=Math.hypot(dx,dz);if(d<.001){p.task.route.shift();continue;}const step=Math.min(d,remaining),next={x:p.x+dx/d*step,z:p.z+dz/d*step};if(!context.segmentClear(p,next)){p.task.route=[];p.task.blocked=true;p.task.navRevision=null;break;}p.x=next.x;p.z=next.z;p.heading=Math.atan2(dx,dz);remaining-=step;if(step===d)p.task.route.shift();}return remaining<distance;}
