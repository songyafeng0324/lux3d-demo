import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
let renderer,controls,frame,model;
const state={ready:false,error:null,view:'entry',roofHidden:false,stats:null};window.__T10_PREVIEW=state;
const scene=new THREE.Scene();scene.background=new THREE.Color('#697982');
const camera=new THREE.PerspectiveCamera(54,innerWidth/innerHeight,.05,250);
const presets={entry:[[0,1.65,12.2],[0,3.6,-7]],upper:[[-7.8,6.45,-5.6],[2,3.7,10]],stairs:[[0,8.5,-5],[0,2.4,-10]],overview:[[30,26,34],[0,3.8,0]]};
function preset(name){const [p,t]=presets[name];camera.position.fromArray(p);controls.target.fromArray(t);controls.update();state.view=name;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===name)));}
function failure(error){state.error=String(error);document.querySelector('#loading').hidden=true;document.querySelector('#error').hidden=false;document.querySelector('#error-text').textContent=state.error;}
try{
renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;document.body.prepend(renderer.domElement);
controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=.4;controls.maxDistance=100;
scene.add(new THREE.HemisphereLight(0xb3cee1,0x6e4c31,1.2));
const sky=new THREE.DirectionalLight(0xd3e6ff,2.1);sky.position.set(0,18,5);sky.target.position.set(0,0,0);sky.castShadow=true;sky.shadow.mapSize.set(2048,2048);Object.assign(sky.shadow.camera,{left:-17,right:17,top:19,bottom:-19,near:.5,far:60});sky.shadow.bias=-.0003;sky.shadow.normalBias=.015;scene.add(sky,sky.target);
const [gltf,layout]=await Promise.all([new GLTFLoader().loadAsync('./pavilion-v1.glb'),fetch('./pavilion-layout.json').then(r=>{if(!r.ok)throw Error('布局数据加载失败');return r.json();})]);
model=gltf.scene;scene.add(model);let meshCount=0,triangles=0;const ids=new Set();
model.traverse(o=>{if(o.isMesh){meshCount++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;o.castShadow=true;o.receiveShadow=true;if(o.userData.slot_id)ids.add(o.userData.slot_id);}});
for(const marker of layout.lightMarkers.filter(m=>m.type==='POINT')){const light=new THREE.PointLight(new THREE.Color(...marker.color),marker.power*.25,12,2);light.position.fromArray(marker.position);scene.add(light);}
// These broad fills approximate daylight for the inspection viewer. They are not a final game lighting contract.
for(const x of [-10,10]){const fill=new THREE.PointLight(0xb8d2eb,170,30,2);fill.position.set(x,6.8,1);scene.add(fill);}
const bounds=new THREE.Box3().setFromObject(model);const size=bounds.getSize(new THREE.Vector3());
const raycaster=new THREE.Raycaster();function down(x,z,y){raycaster.set(new THREE.Vector3(x,y,z),new THREE.Vector3(0,-1,0));const hit=raycaster.intersectObject(model,true)[0];return hit?{y:hit.point.y,name:hit.object.name}:null;}
state.stats={meshCount,triangles,slotCount:ids.size,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:size.toArray()},floorChecks:{atrium:down(0,1,4.79),landing:down(0,-12.25,4.79),upper:down(8,0,4.85)}};
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>preset(b.dataset.view));
document.querySelector('#roof').addEventListener('click',e=>{state.roofHidden=!state.roofHidden;model.traverse(o=>{if(o.userData.semantic_group==='Roof')o.visible=!state.roofHidden;});e.currentTarget.textContent=state.roofHidden?'显示屋顶':'隐藏屋顶';e.currentTarget.setAttribute('aria-pressed',String(state.roofHidden));});
preset('entry');state.ready=true;document.querySelector('#loading').hidden=true;
let last=performance.now();const times=[];function animate(now){controls.update();renderer.render(scene,camera);times.push(now-last);last=now;if(times.length>180)times.shift();state.frameTimeMs=times.reduce((a,b)=>a+b,0)/times.length;state.renderCalls=renderer.info.render.calls;frame=requestAnimationFrame(animate);}frame=requestAnimationFrame(animate);
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);controls.dispose();model.traverse(o=>{if(o.isMesh){o.geometry.dispose();for(const m of (Array.isArray(o.material)?o.material:[o.material]))m.dispose();}});renderer.dispose();},{once:true});
}catch(error){failure(error);}
