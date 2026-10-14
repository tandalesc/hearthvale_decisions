import {createStaticTown} from './static-town.js';
import {createPeopleRenderer} from './people-renderer.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { heightAt, riverX, waterAt, landValue, TYPES } from './simulation.js';
import {spatialContext,foundationHeight,plotBounds,roadAxis,contains,validatePlacement} from './spatial.js';

export function createWorld(canvas, initialState, onPick) {
  const renderer = new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));
  renderer.shadowMap.enabled=true;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.96;
  const scene=new THREE.Scene();scene.background=new THREE.Color('#b6d6dd');scene.fog=new THREE.Fog('#bdd5ca',170,400);
  const camera=new THREE.PerspectiveCamera(40,1,.3,800);
  const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.dampingFactor=.075;controls.maxPolarAngle=Math.PI*.46;controls.minDistance=28;controls.maxDistance=330;controls.target.set(-14,0,0);
  canvas.tabIndex=0;controls.listenToKeyEvents(canvas);
  controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.PAN};
  const ambient=new THREE.HemisphereLight('#eaf7ff','#59683c',1.65);scene.add(ambient);
  const sun=new THREE.DirectionalLight('#ffe4b1',3.1);sun.position.set(-65,95,50);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-90,right:90,top:90,bottom:-90,near:1,far:250});sun.shadow.bias=-.0003;sun.shadow.normalBias=.045;sun.shadow.radius=3;scene.add(sun);scene.add(sun.target);
  const materials=new Map(),geometries=new Map();
  const mat=(color,extra={})=>{const key=color+JSON.stringify(extra);if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color,roughness:.87,...extra}));return materials.get(key);};
  const geometry=(key,build)=>{if(!geometries.has(key))geometries.set(key,build());return geometries.get(key);};
  const boxGeometry=geometry('box',()=>new THREE.BoxGeometry(1,1,1));
  const sphere=geometry('sphere',()=>new THREE.SphereGeometry(1,8,6));
  const temp=new THREE.Object3D();const motion=[];const windows=[];let night=false,tool=null,overlay='beauty',state=initialState,revision=-1,lastTime=0,lastShadow=0,surface=spatialContext(initialState);
  function mesh(geo,color,parent,x=0,y=0,z=0,extra){const m=new THREE.Mesh(geo,mat(color,extra));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
  function box(parent,w,h,d,color,x=0,y=0,z=0,extra){const m=mesh(boxGeometry,color,parent,x,y,z,extra);m.scale.set(w,h,d);return m;}
  function ball(parent,size,color,x,y,z,extra){const m=mesh(sphere,color,parent,x,y,z,extra);m.scale.setScalar(size);return m;}
  function cylinder(parent,r,h,color,x=0,y=0,z=0){return mesh(geometry(`cyl:${r}:${h}`,()=>new THREE.CylinderGeometry(r,r,h,12)),color,parent,x,y,z);}
  function roof(parent,w,h,d,color,y){const key=`roof:${w}:${h}:${d}`;const geo=geometry(key,()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-w/2,0,-d/2,w/2,0,-d/2,0,h,-d/2,-w/2,0,d/2,w/2,0,d/2,0,h,d/2],3));g.setIndex([0,2,1,3,4,5,0,3,5,0,5,2,1,2,5,1,5,4]);g.computeVertexNormals();return g;});return mesh(geo,color,parent,0,y,0);}
  function beam(parent,a,b,width,color){const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b);const m=box(parent,width,start.distanceTo(end),width,color,...start.clone().add(end).multiplyScalar(.5).toArray());m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),end.sub(start).normalize());return m;}
  function windowPane(g,x,y,z,w=.8,h=1){box(g,w+.18,h+.18,.13,'#f1e8cd',x,y,z);const pane=box(g,w,h,.15,'#78aab0',x,y,z+.03,{roughness:.25,emissive:'#e9ae52',emissiveIntensity:night?.7:0});windows.push(pane);box(g,w,.065,.19,'#f1e8cd',x,y,z+.12);box(g,.065,h,.19,'#f1e8cd',x,y,z+.12);}
  function smoke(g,x,y,z){const puffs=[];for(let i=0;i<4;i++){const p=ball(g,.35,'#b2b7a9',x,y+i*.65,z,{transparent:true,opacity:.22,depthWrite:false});p.castShadow=false;puffs.push(p);}motion.push({kind:'smoke',puffs,x,y,z,seed:x+z});}
  function fence(g,x,z,w){for(const dx of [-w/2,0,w/2])box(g,.14,.85,.14,'#bdac7b',x+dx,.45,z);for(const y of [.35,.68])box(g,w,.12,.13,'#d6c49a',x,y,z);}
  function flowerbed(g,x,z){box(g,1.3,.18,.5,'#6d6e3d',x,.15,z);for(let i=0;i<5;i++)ball(g,.15,i%2?'#e6b05e':'#c5d58a',x-.5+i*.25,.38,z);}
  function buildingModel(b){const g=new THREE.Group();g.userData.building=b;const wall=['#e8d6ad','#eddfc6','#d8cab1','#d8d8bc'][b.id%4];
    if(b.type==='home'){
      box(g,5.4,.22,6.2,'#a69d7f',0,.11,.2);box(g,4.6,3.4,4.8,wall,0,1.85,0);box(g,4.7,.32,4.9,'#b6a88c',0,.38,0);
      roof(g,5.3,2.2,5.6,['#a85d45','#965c46','#77876a'][b.id%3],3.55);box(g,.2,.22,5.7,'#6a5941',0,5.76,0);
      box(g,.65,2,.65,'#bc8a66',1.35,5,-.9);box(g,.85,.18,.85,'#d9bb91',1.35,6,-.9);if(b.id%3===0)smoke(g,1.35,6.2,-.9);
      box(g,.95,1.9,.16,'#6c7052',0,1.25,2.46);ball(g,.06,'#e8c470',.3,1.2,2.59);windowPane(g,-1.5,2.25,2.45,.85,.95);windowPane(g,1.5,2.25,2.45,.85,.95);
      box(g,2.3,.12,1.2,'#d3bc8d',0,.28,3);fence(g,0,-3,5.2);flowerbed(g,-1.5,2.95);flowerbed(g,1.5,2.95);
    }
    if(b.type==='market'){
      box(g,7,.25,6,'#bdb18b',0,.12,1);box(g,6,3.5,4.6,'#e2c89e',0,1.9,0);roof(g,6.8,2.1,5.3,'#a7604f',3.65);
      for(let i=0;i<7;i++)box(g,.86,.12,2.1,i%2?'#f3e5bb':'#cf8064',-2.58+i*.86,2.65,3.15);
      for(const x of [-3,3])box(g,.12,2.8,.12,'#766743',x,1.4,4);box(g,6,.7,1.2,'#9b764c',0,.7,3.5);
      for(let i=0;i<5;i++){box(g,.85,.25,.75,'#bd945b',-2.1+i*1.05,1.2,3.5);for(let j=0;j<4;j++)ball(g,.17,['#bd6451','#b4bd65','#dcbd61'][i%3],-2.35+i*1.05+j*.17,1.45,3.5);}
      windowPane(g,-1.7,2,2.4,1,1);windowPane(g,1.7,2,2.4,1,1);
    }
    if(b.type==='farm'){
      box(g,6.5,.15,8.5,'#8e7948',0,.1,1.2);box(g,4.7,3.1,3.9,'#b58358',0,1.7,-1.5);roof(g,5.5,2.1,4.7,'#71765a',3.2);box(g,1.5,2,.1,'#75593c',0,1.1,.5);
      const crops=new THREE.InstancedMesh(geometry('crop',()=>new THREE.ConeGeometry(.17,.85,4)),mat('#c9b84e'),70);let k=0;
      for(let row=0;row<7;row++){box(g,6.3,.08,.23,'#665b32',0,.21,1.3+row*.65);for(let j=0;j<10;j++){temp.position.set(-2.8+j*.62,.62,1.3+row*.65);temp.scale.setScalar(.8+(j+row)%3*.1);temp.updateMatrix();crops.setMatrixAt(k++,temp.matrix);}}crops.castShadow=true;g.add(crops);
      cylinder(g,.9,4,'#c5b99c',3,2,-1.6);mesh(geometry('silo-roof',()=>new THREE.ConeGeometry(1.1,1.2,12)),'#77867a',g,3,4.6,-1.6);
      const rotor=new THREE.Group();rotor.position.set(-1.6,5.4,-1.5);for(let i=0;i<4;i++){const sail=new THREE.Group();sail.rotation.z=i*Math.PI/2;box(sail,.18,2,.14,'#675c42',0,.9,0);box(sail,.55,1.3,.12,'#e9dfb5',.22,1.15,0);rotor.add(sail);}g.add(rotor);motion.push({kind:'rotor',object:rotor});fence(g,0,6.3,7);
    }
    if(b.type==='park'){
      cylinder(g,4.7,.2,'#8eab65',0,.12,0);cylinder(g,1.7,.65,'#d4c9a5',0,.43,0);cylinder(g,1.4,.12,'#63aeb2',0,.79,0);cylinder(g,.22,1.4,'#c9c3a0',0,1.1,0);ball(g,.3,'#b4c7bd',0,1.9,0);
      const drops=[];for(let i=0;i<10;i++)drops.push(ball(g,.055,'#b9e2db',0,2,0,{metalness:.1,roughness:.25}));motion.push({kind:'fountain',drops});
      for(let i=0;i<4;i++){const a=i*Math.PI/2;const bench=new THREE.Group();bench.position.set(Math.cos(a)*3.5,0,Math.sin(a)*3.5);bench.rotation.y=-a;box(bench,1.8,.16,.65,'#ac8352',0,.65,0);box(bench,1.8,.6,.13,'#a17a4a',0,1,-.3);for(const x of [-.65,.65])box(bench,.12,.7,.45,'#6a7455',x,.35,0);g.add(bench);flowerbed(g,Math.cos(a+.55)*3.7,Math.sin(a+.55)*3.7);}
    }
    if(b.type==='utility'){
      box(g,6.8,.25,6.4,'#a4a18a',0,.12,0);box(g,6,3.8,5.4,'#bdbea6',0,2,0);roof(g,6.9,1.9,6.1,'#566c63',3.9);box(g,1,8,1,'#9f8a70',2,4.1,-1.3);box(g,1.3,.3,1.3,'#c1ad8c',2,8.2,-1.3);smoke(g,2,8.5,-1.3);
      for(const x of [-1.7,0,1.7])windowPane(g,x,2.2,2.8,.8,1.1);for(let i=0;i<3;i++)box(g,1.1,.9,1.1,'#9f8251',-2+i*1.3,.55,3.8);
    }
    if(b.type==='road'){
      const points=[],colors=[],color=new THREE.Color();const axis=roadAxis(b);const uStep=.5,vStep=.625;
      const point=(u,v)=>{const x=b.x+(axis==='x'?u:v),z=b.z+(axis==='x'?v:u);return [x-b.x,surface.terrainHeight(x,z)+.12-foundationHeight(b),z-b.z];};
      for(let u=-3;u<3-.01;u+=uStep)for(let v=-1.25;v<1.25-.01;v+=vStep){const x=b.x+(axis==='x'?u+uStep/2:v+vStep/2),z=b.z+(axis==='x'?v+vStep/2:u+uStep/2);if(surface.pads.some(p=>contains(p.core,x,z)))continue;
      const a=point(u,v),c=point(u+uStep,v+vStep),d=point(u,v+vStep),e=point(u+uStep,v);points.push(...a,...c,...e,...a,...d,...c);color.set(Math.abs(v+.3125)>1?'#d5c297':'#bfae85');for(let i=0;i<6;i++)colors.push(color.r,color.g,color.b);}
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(points,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.computeVertexNormals();const lane=mesh(geo,'#ffffff',g,0,0,0,{vertexColors:true,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-2});lane.castShadow=false;g.userData.roadGeometry=geo;
    }
    if(b.type==='bridge'){
      box(g,18,.6,3.8,'#8f7959',0,0,0);for(let i=0;i<22;i++)box(g,.7,.12,3.6,'#cfb782',-8.5+i*.81,.39,0);
      for(const z of [-1.8,1.8]){box(g,18,.18,.2,'#e3cb98',0,1.45,z);for(let x=-8;x<=8;x+=2)box(g,.22,1.8,.22,'#bfa06f',x,.65,z);}
      for(const x of [-7,0,7]){box(g,.7,3.8,.7,'#8b8a6f',x,-1.5,0);beam(g,[x-2,-2,-1.4],[x+2,-.3,-1.4],.2,'#a08d66');}
    }
    return g;
  }
  const terrainRoot=new THREE.Group();scene.add(terrainRoot);const chunks=new Map(),terrains=[],waterUniform={value:0};
  const waterMaterial=new THREE.MeshPhysicalMaterial({color:'#438f9d',roughness:.22,metalness:.18,clearcoat:1,clearcoatRoughness:.25,transparent:true,opacity:.94,side:THREE.DoubleSide});
  waterMaterial.onBeforeCompile=shader=>{shader.uniforms.uTime=waterUniform;shader.vertexShader='uniform float uTime;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.y += sin(position.z * 1.6 + uTime * 1.5) * 0.018 + sin(position.x * 3.5 + uTime) * 0.014;');shader.fragmentShader='uniform float uTime;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\nfloat ripple = sin(vViewPosition.x * 1.8 + uTime * 0.7) * sin(vViewPosition.z * 0.5 - uTime * 0.2); diffuseColor.rgb += vec3(0.025, 0.045, 0.035) * pow(max(ripple, 0.0), 12.0);');};
  const pineGeometry=geometry('pine',()=>new THREE.ConeGeometry(1.5,4.2,7));const leafGeometry=geometry('leaf',()=>new THREE.DodecahedronGeometry(1.75,1));const trunkGeometry=geometry('trunk',()=>new THREE.CylinderGeometry(.16,.24,2.8,6));
  function updateTrees(record){const {trees,points}=record;for(let i=0;i<points.length;i++){const p=points[i];const hidden=surface.records.some(b=>contains(plotBounds(b,1.2),p.x,p.z));const size=hidden?.001:p.size;temp.rotation.set(0,p.x,0);temp.scale.set(size,size,size);temp.position.set(p.x,surface.terrainHeight(p.x,p.z)+1.1*size,p.z);temp.updateMatrix();trees[0].setMatrixAt(i,temp.matrix);temp.position.y=surface.terrainHeight(p.x,p.z)+3.1*size;temp.updateMatrix();trees[1].setMatrixAt(i,temp.matrix);temp.position.y=surface.terrainHeight(p.x,p.z)+4.3*size;temp.scale.setScalar(size*.72);temp.updateMatrix();trees[2].setMatrixAt(i,temp.matrix);}for(const t of trees){t.instanceMatrix.needsUpdate=true;t.computeBoundingSphere();}}
  function addChunk(cx,cz){const key=`${cx},${cz}`;if(chunks.has(key))return;const root=new THREE.Group();terrainRoot.add(root);const size=100,geo=new THREE.PlaneGeometry(size,size,96,96);geo.rotateX(-Math.PI/2);geo.translate(cx*size,0,cz*size);const pos=geo.attributes.position,colors=[],color=new THREE.Color();for(let i=0;i<pos.count;i++){const x=pos.getX(i),z=pos.getZ(i),h=surface.terrainHeight(x,z),d=Math.abs(x-riverX(z));pos.setY(i,h);color.set(d<8?'#c9b482':h>3.5?'#6e955a':'#8eaf6b');color.multiplyScalar(.97+Math.sin(x*.35+z*.51)*.04);colors.push(color.r,color.g,color.b);}geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.computeVertexNormals();const land=new THREE.Mesh(geo,mat('#ffffff',{vertexColors:true,roughness:1}));land.receiveShadow=true;root.add(land);terrains.push(land);
    const points=[];for(let i=0;i<90;i++){const r=Math.abs(Math.sin((cx*137+cz*73+i+1)*178.34));const x=cx*100-50+r*100,z=cz*100-50+Math.abs(Math.sin((i+cx*12+cz*19)*42.17))*100;if(!waterAt(x,z)&&Math.abs(x-riverX(z))>8)points.push({x,z,size:.7+r*.65});}
    const trees=[new THREE.InstancedMesh(trunkGeometry,mat('#756243'),points.length),new THREE.InstancedMesh(cx%2?leafGeometry:pineGeometry,mat(cx%2?'#698c4c':'#4e7e52'),points.length),new THREE.InstancedMesh(cx%2?leafGeometry:pineGeometry,mat('#88a861'),points.length)];for(const tree of trees){tree.castShadow=true;tree.receiveShadow=true;root.add(tree);}const owned=[geo];
    if(cx===0){const vertices=[],indices=[];for(let i=0;i<=100;i++){const z=cz*100-50+i,rx=riverX(z);vertices.push(rx-5.82,.025,z,rx+5.82,.025,z);if(i<100){const a=i*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}}const wg=new THREE.BufferGeometry();wg.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));wg.setIndex(indices);wg.computeVertexNormals();root.add(new THREE.Mesh(wg,waterMaterial));owned.push(wg);
      const glints=new THREE.InstancedMesh(boxGeometry,mat('#b2d6cc',{transparent:true,opacity:.42,depthWrite:false}),20);for(let i=0;i<20;i++){const z=cz*100-48+i*4.8;temp.position.set(riverX(z)+Math.sin(i*8)*4,.07,z);temp.scale.set(.6+Math.abs(Math.sin(i*4))*1.6,.018,.07);temp.rotation.set(0,.1,0);temp.updateMatrix();glints.setMatrixAt(i,temp.matrix);}root.add(glints);}
    renderer.shadowMap.needsUpdate=true;const record={root,land,trees,points,owned};chunks.set(key,record);updateTrees(record);
  }
  const town=new THREE.Group();scene.add(town);const buildings=new Map(),projects=new Map();const people=createPeopleRenderer(scene),staticTown=createStaticTown(scene);const labels=document.querySelector('#world-labels');
  function projectModel(p){const g=new THREE.Group();g.position.set(p.x,foundationHeight(p),p.z);const bounds=plotBounds(p),width=bounds.maxX-bounds.minX,depth=bounds.maxZ-bounds.minZ,centerZ=(bounds.maxZ+bounds.minZ)/2-p.z;
    box(g,width,.22,depth,'#a49368',0,.15,centerZ);for(const x of [-width/2,width/2])for(const z of [centerZ-depth/2,centerZ+depth/2]){box(g,.16,5,.16,'#bfa26e',x,2.5,z);for(const y of [1.5,3.2,4.8])box(g,width,.12,.12,'#cfb47b',0,y,z);}for(let i=0;i<4;i++)box(g,2,.16,.3,'#b88d52',width/2+1,.3+i*.18,0);const model=buildingModel({...p,id:p.id+1});g.add(model);const label=document.createElement('div');label.className='world-label';label.innerHTML=`<span>${TYPES[p.type].name}</span><div><i></i></div>`;labels?.append(label);town.add(g);return {g,model,label};}
  const clouds=new THREE.Group();for(let i=0;i<5;i++){const cloud=new THREE.Group();cloud.position.set(-90+i*46,45+(i%2)*8,-85-i*12);for(let j=0;j<5;j++){const puff=ball(cloud,4+j%2*1.5,'#f1f1df',j*4,Math.sin(j)*2,0,{transparent:true,opacity:.66,depthWrite:false});puff.scale.y*=.48;puff.scale.z*=.65;puff.castShadow=false;}clouds.add(cloud);}scene.add(clouds);
  const birds=[];for(let i=0;i<6;i++){const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,0,0,.2,0,0,.2,0,1,0,0],3));const bird=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:'#5d7264'}));scene.add(bird);birds.push(bird);}
  const ghost=mesh(geometry('ghost',()=>new THREE.BoxGeometry(1,.1,1)),'#e8dda2',scene,0,0,0,{transparent:true,opacity:.6});ghost.visible=false;ghost.castShadow=false;
  const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();let down;
  function intersect(e){const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);return ray.intersectObjects(terrains)[0]?.point;}
  canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY};});canvas.addEventListener('pointermove',e=>{if(!tool)return;const p=intersect(e);if(p){const x=Math.round(p.x),z=Math.round(p.z),b={type:tool,x,z},r=plotBounds(b);ghost.visible=true;ghost.scale.set(r.maxX-r.minX,1,r.maxZ-r.minZ);ghost.position.set((r.minX+r.maxX)/2,tool==='bridge'?1.5:surface.terrainHeight(x,z)+.2,(r.minZ+r.maxZ)/2);ghost.material.color.set(validatePlacement(state,tool,x,z).ok?'#d1e3a0':'#cc6956');}});
  canvas.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>5||e.button!==0)return;const p=intersect(e);if(tool&&p)return onPick({x:Math.round(p.x),z:Math.round(p.z),tool});const hits=ray.intersectObjects([...buildings.values()],true);let object=hits[0]?.object;while(object&&!object.userData.building)object=object.parent;onPick({building:object?.userData.building,point:p});});
  function update(s,time,dt){state=s;lastTime=time;waterUniform.value=time;if((s.projects??[]).length&&time-lastShadow>.25){renderer.shadowMap.needsUpdate=true;lastShadow=time;}
    surface=spatialContext(s);const nextRevision=surface.key;updateFraming(dt);controls.update();camera.updateMatrixWorld();
    for(const b of s.buildings)if(!buildings.has(b.id)){const g=buildingModel(b);g.position.set(b.x,foundationHeight(b),b.z);town.add(g);buildings.set(b.id,g);if(overlay!=='beauty')colorBuilding(g,b);}
    const ids=new Set(s.buildings.map(b=>b.id));for(const [id,g]of buildings)if(!ids.has(id)){town.remove(g);buildings.delete(id);}
    const projectIds=new Set((s.projects??[]).map(p=>p.id));for(const p of s.projects??[]){if(!projects.has(p.id))projects.set(p.id,projectModel(p));const v=projects.get(p.id);v.model.visible=p.progress>.08;v.model.scale.y=Math.max(.04,p.progress);v.label.querySelector('i').style.width=`${p.progress*100}%`;}
    for(const [id,v]of projects)if(!projectIds.has(id)){const removed=new Set();v.g.traverse(o=>removed.add(o));for(let i=motion.length-1;i>=0;i--){const item=motion[i];if(removed.has(item.object)||removed.has(item.puffs?.[0])||removed.has(item.drops?.[0]))motion.splice(i,1);}for(let i=windows.length-1;i>=0;i--)if(removed.has(windows[i]))windows.splice(i,1);town.remove(v.g);v.label.remove();projects.delete(id);}
    if(nextRevision!==revision){for(const record of chunks.values()){const pos=record.land.geometry.attributes.position;for(let i=0;i<pos.count;i++)pos.setY(i,surface.terrainHeight(pos.getX(i),pos.getZ(i)));pos.needsUpdate=true;record.land.geometry.computeVertexNormals();record.land.geometry.computeBoundingSphere();updateTrees(record);}for(const b of s.buildings.filter(b=>b.type==='road')){const old=buildings.get(b.id);if(old){old.userData.roadGeometry?.dispose();town.remove(old);}const g=buildingModel(b);g.position.set(b.x,foundationHeight(b),b.z);town.add(g);buildings.set(b.id,g);}revision=nextRevision;staticTown.rebuild(buildings,motion);renderer.shadowMap.needsUpdate=true;}
    people.update(s,surface,camera);
    for(const item of motion){if(item.kind==='rotor')item.object.rotation.z=s.tick*.7;if(item.kind==='smoke')for(let i=0;i<item.puffs.length;i++){const t=(s.tick*.3+i*.7)%2.8;item.puffs[i].position.set(item.x+t*.35,item.y+t*1.3,item.z+Math.sin(t)*.25);item.puffs[i].scale.setScalar(.24+t*.23);}if(item.kind==='fountain')for(let i=0;i<item.drops.length;i++){const t=(s.tick*.7+i/10)%1,a=i*2.399;item.drops[i].position.set(Math.cos(a)*t*1.2,.8+Math.sin(t*Math.PI)*1.3,Math.sin(a)*t*1.2);}}
    for(let i=0;i<birds.length;i++){const t=s.tick*.065+i*.5;birds[i].position.set(-20+Math.sin(t)*37,22+Math.sin(t*2+i)*3,-20+Math.cos(t)*27);birds[i].rotation.y=-t;const pos=birds[i].geometry.attributes.position;pos.setY(0,Math.sin(s.tick*7+i)*.4);pos.setY(3,Math.sin(s.tick*7+i)*.4);pos.needsUpdate=true;}
    clouds.position.x=Math.sin(time*.007)*8;const cx=Math.round(controls.target.x/100),cz=Math.round(controls.target.z/100);for(let x=cx-1;x<=cx+1;x++)for(let z=cz-1;z<=cz+1;z++)addChunk(x,z);
    for(const [key,r]of chunks){const [x,z]=key.split(',').map(Number);if(Math.abs(x-cx)>2||Math.abs(z-cz)>2){terrainRoot.remove(r.root);terrains.splice(terrains.indexOf(r.land),1);for(const g of r.owned)g.dispose();for(const tree of r.trees)tree.dispose();chunks.delete(key);}}
    updateLabels(s,dt);
    renderer.render(scene,camera);
  }
  function updateLabels(s,dt){
    const safe=document.querySelector('.scene-space')?.getBoundingClientRect()??{left:0,top:0,right:canvas.clientWidth,bottom:canvas.clientHeight};const occupied=[];const activeIds=new Set((s.projects??[]).slice(0,2).map(p=>p.id));
    for(const p of s.projects??[]){const v=projects.get(p.id);if(!v)continue;const pos=new THREE.Vector3(p.x,foundationHeight(p)+6,p.z).project(camera);let x=(pos.x*.5+.5)*canvas.clientWidth,y=(-pos.y*.5+.5)*canvas.clientHeight;const width=100,height=40;
      let stacked=false;for(const r of occupied)if(Math.abs(x-r.x)<width+(v.stacked?24:8)&&Math.abs(y-r.y)<height+(v.stacked?24:8)){y=r.y-height-10;stacked=true;}v.stacked=stacked;
      const edge=v.visible?4:12;const panel=document.querySelector('.panel:not([hidden])')?.getBoundingClientRect();const behindPanel=panel&&x+width/2>panel.left&&x-width/2<panel.right&&y>panel.top&&y-height<panel.bottom;const visible=!behindPanel&&activeIds.has(p.id)&&pos.z>-1&&pos.z<1&&x>safe.left+width/2+edge&&x<safe.right-width/2-edge&&y>safe.top+height+edge&&y<safe.bottom-edge;v.visible=visible;
      if(visible)occupied.push({x,y});const alpha=1-Math.exp(-Math.max(.001,dt)*20);v.x=v.x===undefined?x:v.x+(x-v.x)*alpha;v.y=v.y===undefined?y:v.y+(y-v.y)*alpha;v.label.style.transform=`translate3d(${v.x.toFixed(2)}px,${v.y.toFixed(2)}px,0) translate(-50%,-100%)`;v.label.classList.toggle('is-visible',visible);
    }
  }
  function colorBuilding(g,b){const value=landValue(state,b.x,b.z);g.traverse(o=>{if(!o.isMesh)return;if(!o.userData.original)o.userData.original=o.material;o.material=overlay==='beauty'?o.userData.original:mat(overlay==='value'?new THREE.Color().setHSL(clamp01(value/180)*.32,.45,.5).getStyle():b.type==='utility'?'#c27558':'#89ad76');});}
  let fittedScale=0,targetScale=118,frameX=0,frameY=0,targetFrameX=0,targetFrameY=0,frameWidth=1,frameHeight=1;
  function resize(){const {width,height}=canvas.getBoundingClientRect();if(!width||!height)return;renderer.setSize(width,height,false);frameWidth=width;frameHeight=height;const rect=document.querySelector('.scene-space')?.getBoundingClientRect();const usableWidth=Math.max(160,rect?.width??width),usableHeight=Math.max(100,rect?.height??height);targetScale=fitDistance(usableWidth,usableHeight);targetFrameX=width/2-((rect?.left??0)+usableWidth/2);targetFrameY=height/2-((rect?.top??0)+usableHeight/2);camera.aspect=width/height;if(!fittedScale){fittedScale=targetScale;frameX=targetFrameX;frameY=targetFrameY;}camera.setViewOffset(width,height,frameX,frameY,width,height);camera.updateProjectionMatrix();}
  function updateFraming(dt){const alpha=1-Math.exp(-Math.max(.001,dt)*12);const scale=fittedScale+(targetScale-fittedScale)*alpha;camera.position.sub(controls.target).multiplyScalar(scale/fittedScale).add(controls.target);fittedScale=scale;frameX+=(targetFrameX-frameX)*alpha;frameY+=(targetFrameY-frameY)*alpha;camera.setViewOffset(frameWidth,frameHeight,frameX,frameY,frameWidth,frameHeight);camera.updateProjectionMatrix();}
  function home(){resize();fittedScale=targetScale;frameX=targetFrameX;frameY=targetFrameY;controls.target.set(-14,0,1);const direction=new THREE.Vector3(.62,.72,.92).normalize();camera.position.copy(controls.target).addScaledVector(direction,targetScale);controls.update();}
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(canvas);const sceneSpace=document.querySelector('.scene-space');if(sceneSpace)resizeObserver.observe(sceneSpace);document.fonts?.ready.then(resize);home();
  return {update,resize,home,setOverlay(mode,s){state=s;overlay=mode;for(const b of s.buildings){const g=buildings.get(b.id);if(g)colorBuilding(g,b);}staticTown.rebuild(buildings,motion);renderer.shadowMap.needsUpdate=true;},tool(t){tool=t;controls.enableRotate=!t;ghost.visible=false;},setNight(value){night=value;sun.intensity=night?.6:3.1;ambient.intensity=night?.95:1.65;sun.color.set(night?'#a5b8e2':'#ffe4b1');scene.background.set(night?'#596f89':'#b6d6dd');scene.fog.color.set(night?'#768b96':'#bdd5ca');for(const w of windows)w.material.emissiveIntensity=night?1.6:0;renderer.shadowMap.needsUpdate=true;},projectPoint(x,z){const p=new THREE.Vector3(x,surface.terrainHeight(x,z),z).project(camera);return {x:(p.x*.5+.5)*canvas.clientWidth,y:(-p.y*.5+.5)*canvas.clientHeight};},debug(){return {cameraDistance:camera.position.distanceTo(controls.target),chunks:chunks.size,renderedPeople:people.count,peopleBatches:people.batches,simplifiedPeople:people.simplified,staticBatches:staticTown.count,peopleCapacity:people.capacity,constructionSites:projects.size,spatialRevision:surface.key,drawCalls:renderer.info.render.calls};}};
}
function clamp01(n){return Math.max(0,Math.min(1,n));}

function fitDistance(width,height){const aspect=width/height;return Math.max(88,Math.min(170,112*Math.max(1,.95/aspect)));}
