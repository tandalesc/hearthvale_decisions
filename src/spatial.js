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
