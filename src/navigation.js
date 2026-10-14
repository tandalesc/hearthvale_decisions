import {plotBounds,spatialContext} from './spatial.js';
import {riverX} from './terrain.js';

class Heap {
 constructor(){this.items=[];}
 push(item){const a=this.items;a.push(item);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p].f<=item.f)break;a[i]=a[p];i=p;}a[i]=item;}
 pop(){const a=this.items,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].f<a[c].f)c++;if(a[c].f>=last.f)break;a[i]=a[c];i=c;}a[i]=last;}return first;}
 get length(){return this.items.length;}
}
export function nearestWalkable(context,point,maxRadius=10){if(context.walkable(point.x,point.z))return {...point};for(let r=.5;r<=maxRadius;r+=.5)for(let i=0;i<24;i++){const a=i*Math.PI/12,p={x:point.x+Math.cos(a)*r,z:point.z+Math.sin(a)*r};if(context.walkable(p.x,p.z))return p;}return null;}
export function accessPoint(s,target,p,kind){const c=spatialContext(s),r=plotBounds(target);const candidates=[];
 if(target.type==='bridge'){const side=Math.sign(p.x-riverX(p.z))||-1;candidates.push({x:target.x+side*10,z:target.z});}
 else if(target.type==='park'&&kind!=='build'){for(let i=0;i<8;i++){const a=(p.id%8+i)*Math.PI/4+.22;candidates.push({x:target.x+Math.cos(a)*3.1,z:target.z+Math.sin(a)*3.1});}}
 else{const offset=((p.id%5)-2)*.4;candidates.push({x:target.x+offset,z:r.maxZ+.8},{x:r.minX-.8,z:(r.minZ+r.maxZ)/2+offset},{x:r.maxX+.8,z:(r.minZ+r.maxZ)/2+offset},{x:target.x+offset,z:r.minZ-.8});}
 return candidates.filter(p=>c.walkable(p.x,p.z)).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0]??nearestWalkable(c,{x:target.x,z:r.maxZ+1},6);
}
const directions=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
function* search(context,start,goal,bounds,budget){
 const sx=Math.round(start.x),sz=Math.round(start.z),gx=Math.round(goal.x),gz=Math.round(goal.z);const key=(x,z)=>`${x},${z}`;
 const open=new Heap(),nodes=new Map(),closed=new Set();const h=(x,z)=>Math.hypot(x-gx,z-gz)*.55;
 const first={x:sx,z:sz,g:0,f:h(sx,sz),parent:null};nodes.set(key(sx,sz),first);open.push(first);let count=0;
 while(open.length&&count++<budget){const current=open.pop(),id=key(current.x,current.z);if(closed.has(id))continue;closed.add(id);if(count%32===0)yield;
 if(Math.hypot(current.x-goal.x,current.z-goal.z)<1.5&&context.segmentClear(current,goal)){const path=[goal];let n=current;while(n){path.push({x:n.x,z:n.z});n=n.parent;}path.reverse();if(!context.segmentClear(start,path[0]))return null;return [start,...path];}
 for(const [dx,dz]of directions){const x=current.x+dx,z=current.z+dz;if(x<bounds.minX||x>bounds.maxX||z<bounds.minZ||z>bounds.maxZ||closed.has(key(x,z))||!context.walkable(x,z))continue;
 if(dx&&dz&&(!context.walkable(current.x+dx,current.z)||!context.walkable(current.x,current.z+dz)))continue;
 if(!context.segmentClear(current,{x,z}))continue;const g=current.g+Math.hypot(dx,dz)*(context.onRoad(x,z)?.55:1.2)+Math.abs(context.walkHeight(x,z)-context.walkHeight(current.x,current.z))*.3;
 const known=nodes.get(key(x,z));if(!known||g<known.g){const n={x,z,g,f:g+h(x,z),parent:current};nodes.set(key(x,z),n);open.push(n);}}
 }
 return null;
}
export function* findPathJob(s,start,target){const context=spatialContext(s);if(!context.walkable(start.x,start.z)||!context.walkable(target.x,target.z))return null;
 const candidates=[];for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)candidates.push({x:Math.round(start.x)+dx,z:Math.round(start.z)+dz});const snapped=candidates.sort((a,b)=>Math.hypot(a.x-start.x,a.z-start.z)-Math.hypot(b.x-start.x,b.z-start.z)).find(p=>context.walkable(p.x,p.z)&&context.segmentClear(start,p));if(!snapped)return null;
 const cross=(start.x-riverX(start.z))*(target.x-riverX(target.z))<0;const bridge=cross?s.buildings.filter(b=>b.type==='bridge').sort((a,b)=>(Math.hypot(a.x-start.x,a.z-start.z)+Math.hypot(a.x-target.x,a.z-target.z))-(Math.hypot(b.x-start.x,b.z-start.z)+Math.hypot(b.x-target.x,b.z-target.z)))[0]:null;
 if(cross&&!bridge)return null;
 for(const margin of [10,24,48]){const bounds={minX:Math.floor(Math.min(start.x,target.x,bridge?.x??start.x)-margin),maxX:Math.ceil(Math.max(start.x,target.x,bridge?.x??start.x)+margin),minZ:Math.floor(Math.min(start.z,target.z,bridge?.z??start.z)-margin),maxZ:Math.ceil(Math.max(start.z,target.z,bridge?.z??start.z)+margin)};const route=yield* search(context,snapped,target,bounds,20000);if(route){route[0]={...start};return route;}}
 return null;
}
export function findPath(s,start,target){const job=findPathJob(s,start,target);let next;do{next=job.next();}while(!next.done);return next.value;}
// Shared by the navigation worker and cooperative fallback. Each slice yields
// after 32 A* expansions; request queues and cached paths are both bounded.
export class RouteScheduler {
 constructor({clock=()=>performance.now(),maxPending=128,maxCache=256}={}){this.clock=clock;this.maxPending=maxPending;this.maxCache=maxCache;this.jobs=new Map();this.queue=[];this.cache=new Map();this.revision=null;this.stats={completed:0,cacheHits:0,slices:0};}
 reset(s){const revision=spatialContext(s).key;if(this.revision===revision)return;for(const job of this.jobs.values())for(const cb of job.callbacks)cb(null);this.jobs.clear();this.queue=[];this.cache.clear();this.revision=revision;}
 request(s,start,target,callback){this.reset(s);const context=spatialContext(s),key=`${Math.round(start.x*2)},${Math.round(start.z*2)}:${target.x.toFixed(2)},${target.z.toFixed(2)}`;
 const adapt=route=>{if(!route)return null;const copy=route.map(p=>({...p}));if(copy.length>1&&!context.segmentClear(start,copy[1]))return null;copy[0]={x:start.x,z:start.z};return copy;};
 if(this.cache.has(key)){const cached=this.cache.get(key),route=adapt(cached);if(route||cached===null){this.stats.cacheHits++;callback(route);return true;}}
 const existing=this.jobs.get(key);if(existing){if(existing.callbacks.length>=this.maxPending)return false;existing.callbacks.push(route=>callback(adapt(route)));return true;}
 if(this.jobs.size>=this.maxPending)return false;const job={key,iterator:findPathJob(s,{x:start.x,z:start.z},{...target}),callbacks:[route=>callback(adapt(route))]};this.jobs.set(key,job);this.queue.push(job);return true;
 }
 tick(budgetMs=2,maxSlices=64){const deadline=this.clock()+budgetMs;let slices=0;while(this.queue.length&&slices<maxSlices&&this.clock()<deadline){const job=this.queue.shift(),result=job.iterator.next();slices++;this.stats.slices++;if(result.done){this.jobs.delete(job.key);this.cache.set(job.key,result.value);while(this.cache.size>this.maxCache)this.cache.delete(this.cache.keys().next().value);for(const cb of job.callbacks)cb(result.value);this.stats.completed++;}else this.queue.push(job);}return slices;}
 get pending(){return this.jobs.size;}
}
export function moveOnRoute(context,p,distance){let remaining=distance;while(p.task.route.length&&remaining>0){const point=p.task.route[0],dx=point.x-p.x,dz=point.z-p.z,d=Math.hypot(dx,dz);if(d<.001){p.task.route.shift();continue;}const step=Math.min(d,remaining),next={x:p.x+dx/d*step,z:p.z+dz/d*step};if(!context.segmentClear(p,next)){p.task.route=[];p.task.blocked=true;p.task.navRevision=null;break;}p.x=next.x;p.z=next.z;p.heading=Math.atan2(dx,dz);remaining-=step;if(step===d)p.task.route.shift();}return remaining<distance;}
