import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {chromium} from 'playwright';
export const IMAGE_LIMIT=10*1024*1024;
export const MODEL_LIMIT=100*1024*1024;
export const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export async function validateImage(bytes:Buffer){
 if(!bytes.length||bytes.length>IMAGE_LIMIT)throw new Error('IMAGE_SIZE_INVALID');
 const image=sharp(bytes,{limitInputPixels:16_777_216,failOn:'warning'}),m=await image.metadata();
 if(!['png','jpeg','webp'].includes(m.format??'')||(m.pages??1)>1)throw new Error('IMAGE_FORMAT_INVALID');
 await image.raw().toBuffer(); // Metadata alone does not establish complete decoding.
 return {mime:`image/${m.format}`,extension:m.format==='jpeg'?'jpg':m.format!};
}
export function inspectModel(bytes:Buffer){
 if(bytes.length<28||bytes.length>MODEL_LIMIT||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw new Error('MODEL_HEADER_INVALID');
 const length=bytes.readUInt32LE(12);
 if(length%4||bytes.readUInt32LE(16)!==0x4e4f534a||length+28>bytes.length)throw new Error('MODEL_JSON_INVALID');
 const j=JSON.parse(bytes.subarray(20,20+length).toString('utf8'));
 if(j.asset?.version!=='2.0'||!j.scenes?.length||!j.meshes?.length||!j.buffers?.length)throw new Error('MODEL_SCENE_INVALID');
 if(j.buffers.length!==1||j.buffers[0].uri||(j.images??[]).some((v:any)=>v.uri)||Object.keys(j.extensions??{}).length||(j.extensionsRequired??[]).length||(j.extensionsUsed??[]).length)throw new Error('MODEL_DEPENDENCY_UNSUPPORTED');
 const offset=20+length,bin=bytes.readUInt32LE(offset);
 if(bytes.readUInt32LE(offset+4)!==0x004e4942||offset+8+bin!==bytes.length||j.buffers[0].byteLength>bin||bin-j.buffers[0].byteLength>3)throw new Error('MODEL_BUFFER_INVALID');
 if((j.nodes??[]).length>4096||j.meshes.length>256||(j.images??[]).length>64)throw new Error('MODEL_RESOURCE_LIMIT');
 const stack:unknown[]=[j];while(stack.length){const value=stack.pop();if(value&&typeof value==='object'){if(Object.hasOwn(value,'extensions')&&Object.keys((value as any).extensions??{}).length)throw new Error('MODEL_EXTENSION_UNSUPPORTED');for(const child of Object.values(value))if(child&&typeof child==='object')stack.push(child);}}
 const validInt=(n:unknown,max:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=max;
 if((j.accessors??[]).length>4096||(j.bufferViews??[]).length>4096||(j.materials??[]).length>128||(j.textures??[]).length>64||(j.scenes??[]).length>16||(j.animations??[]).length||(j.skins??[]).length)throw new Error('MODEL_RESOURCE_LIMIT');
 const views=j.bufferViews??[],accessors=j.accessors??[],bufferBytes=j.buffers[0].byteLength;
 for(const v of views){if(v.buffer!==0||!validInt(v.byteOffset??0,bufferBytes)||!validInt(v.byteLength,bufferBytes)||(v.byteOffset??0)+v.byteLength>bufferBytes||v.byteStride!==undefined&&(!validInt(v.byteStride,252)||v.byteStride<4||v.byteStride%4))throw new Error('MODEL_VIEW_INVALID');}
 const widths:Record<number,number>={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},components:Record<string,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};let decoded=0;
 for(const ac of accessors){const width=widths[ac.componentType],count=components[ac.type],stride=width*count;
  if(!width||!count||!validInt(ac.count,1_000_000)||!ac.count||!validInt(ac.byteOffset??0,MODEL_LIMIT))throw new Error('MODEL_ACCESSOR_LIMIT');
  decoded+=ac.count*stride;if(decoded>128*1024*1024||ac.count*stride>32*1024*1024)throw new Error('MODEL_DECODE_LIMIT');
  if(ac.bufferView!==undefined){const v=views[ac.bufferView];if(!v||!validInt(ac.bufferView,views.length-1)||(v.byteStride??stride)<stride||(ac.byteOffset??0)+(ac.count-1)*(v.byteStride??stride)+stride>v.byteLength)throw new Error('MODEL_ACCESSOR_INVALID');}
  if(ac.sparse){const sp=ac.sparse;if(!validInt(sp.count,ac.count)||!sp.count)throw new Error('MODEL_SPARSE_INVALID');for(const [part,w] of [[sp.indices,widths[sp.indices?.componentType]],[sp.values,stride]] as any){const v=views[part?.bufferView];if(!v||!w||!validInt(part.byteOffset??0,v.byteLength)||(part.byteOffset??0)+sp.count*w>v.byteLength)throw new Error('MODEL_SPARSE_INVALID');}}
 }
 let triangles=0,vertices=0;const meshTriangles:number[]=[];
 for(const mesh of j.meshes){let meshTotal=0;if(!Array.isArray(mesh.primitives)||mesh.primitives.length>256)throw new Error('MODEL_PRIMITIVE_INVALID');for(const p of mesh.primitives){
  const ac=accessors[p.attributes?.POSITION];
  if((p.targets??[]).length||(mesh.weights??[]).length)throw new Error('MODEL_MORPH_UNSUPPORTED');
  if(!ac||ac.type!=='VEC3'||ac.componentType!==5126||(p.mode??4)!==4)throw new Error('MODEL_PRIMITIVE_INVALID');
  vertices+=ac.count;if(vertices>900000)throw new Error('MODEL_VERTEX_LIMIT');
  const count=p.indices===undefined?ac.count:accessors[p.indices]?.count;
  if(!Number.isSafeInteger(count)||count<3||count%3)throw new Error('MODEL_INDEX_INVALID');meshTotal+=count/3;
 }meshTriangles.push(meshTotal);triangles+=meshTotal;}
 if(!triangles||triangles>300000)throw new Error('MODEL_TRIANGLE_LIMIT');
 const nodes=j.nodes??[],parents=new Set<number>();let instanceTriangles=0,meshInstances=0;
 for(let n=0;n<nodes.length;n++){const node=nodes[n];if((node.weights??[]).length)throw new Error('MODEL_MORPH_UNSUPPORTED');if(node.mesh!==undefined){if(!validInt(node.mesh,j.meshes.length-1))throw new Error('MODEL_NODE_INVALID');instanceTriangles+=meshTriangles[node.mesh];meshInstances++;}
  for(const child of node.children??[]){if(!validInt(child,nodes.length-1)||parents.has(child)||child===n)throw new Error('MODEL_NODE_INVALID');parents.add(child);}
 }
 if(instanceTriangles>300000||meshInstances>256)throw new Error('MODEL_INSTANCE_LIMIT');
 const visited=new Set<number>(),active=new Set<number>();
 const visit=(n:number)=>{if(active.has(n))throw new Error('MODEL_NODE_CYCLE');if(visited.has(n))return;active.add(n);for(const child of nodes[n].children??[])visit(child);active.delete(n);visited.add(n);};for(let n=0;n<nodes.length;n++)visit(n);
 for(const scene of j.scenes){if(!Array.isArray(scene.nodes)||scene.nodes.some((n:number)=>!validInt(n,nodes.length-1)||parents.has(n))||new Set(scene.nodes).size!==scene.nodes.length)throw new Error('MODEL_SCENE_INVALID');}
 return {json:j,triangles,binStart:offset+8};
}
export async function validateModel(bytes:Buffer){
 const info=inspectModel(bytes);let pixels=0;
 for(const image of info.json.images??[]){
  const view=info.json.bufferViews?.[image.bufferView];
  if(!view||view.buffer!==0||!Number.isSafeInteger(view.byteLength)||view.byteLength<1)throw new Error('MODEL_TEXTURE_INVALID');
  const start=info.binStart+(view.byteOffset??0),end=start+view.byteLength;
  if(start<info.binStart||end>bytes.length)throw new Error('MODEL_TEXTURE_INVALID');
  const texture=sharp(bytes.subarray(start,end),{limitInputPixels:16_777_216,failOn:'warning'}),m=await texture.metadata();
  if(!['png','jpeg','webp'].includes(m.format??'')||(m.pages??1)>1)throw new Error('MODEL_TEXTURE_INVALID');
  pixels+=(m.width??0)*(m.height??0);if(pixels>67_108_864)throw new Error('MODEL_TEXTURE_LIMIT');await texture.raw().toBuffer();
 }
 // Exercise the same GLTFLoader/WebGL pipeline as the client, with all external
 // network access denied. A structural GLB check alone cannot publish an asset.
 const require=createRequire(import.meta.url),threeRoot=path.dirname(require.resolve('three/package.json'.replace('/package.json','')));
 const root=path.resolve(threeRoot,'..');
 const modules:Record<string,string>={
  '/three.js':path.join(root,'build/three.module.js'),'/three.core.js':path.join(root,'build/three.core.js'),
  '/GLTFLoader.js':path.join(root,'examples/jsm/loaders/GLTFLoader.js'),'/utils/SkeletonUtils.js':path.join(root,'examples/jsm/utils/SkeletonUtils.js'),'/utils/BufferGeometryUtils.js':path.join(root,'examples/jsm/utils/BufferGeometryUtils.js'),
 };
 const html=`<!doctype html><canvas id="c" width="320" height="320"></canvas><script type="importmap">{"imports":{"three":"/three.js"}}</script><script type="module">
 import * as T from 'three';import {GLTFLoader} from '/GLTFLoader.js';
 try{const manager=new T.LoadingManager();manager.setURLModifier(u=>{if(u==='/model.glb'||u.startsWith('blob:')||u.startsWith('data:'))return u;throw Error('external');});
 const gltf=await new GLTFLoader(manager).loadAsync('/model.glb'),scene=new T.Scene();scene.background=new T.Color(0x24282d);scene.add(gltf.scene);
 gltf.scene.updateMatrixWorld(true);let meshes=0;gltf.scene.traverse(o=>{if(o.isMesh){meshes++;const p=o.geometry.getAttribute('position');for(let n=0;n<p.count;n++)for(let a=0;a<3;a++)if(!Number.isFinite(p.array[n*p.itemSize+a]))throw Error('geometry');}});
 const b=new T.Box3().setFromObject(gltf.scene),s=b.getSize(new T.Vector3()),center=b.getCenter(new T.Vector3()),max=Math.max(s.x,s.y,s.z);
 if(!meshes||!Number.isFinite(max)||max<=0||Math.min(s.x,s.y,s.z)<0)throw Error('bounds');
 const camera=new T.PerspectiveCamera(40,1,.001*max,100*max);camera.position.copy(center).add(new T.Vector3(1.8*max,1.4*max,2*max));camera.lookAt(center);
 scene.add(new T.HemisphereLight(0xffffff,0x667788,3));const light=new T.DirectionalLight(0xffffff,3);light.position.copy(camera.position);scene.add(light);
 const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas'),preserveDrawingBuffer:true});renderer.setSize(320,320);await renderer.compileAsync(scene,camera);renderer.render(scene,camera);
 const gl=renderer.getContext(),data=new Uint8Array(320*320*4);gl.readPixels(0,0,320,320,gl.RGBA,gl.UNSIGNED_BYTE,data);if(gl.getError()!==gl.NO_ERROR)throw Error('render');
 let changed=0;for(let n=0;n<data.length;n+=4)if(Math.abs(data[n]-data[0])+Math.abs(data[n+1]-data[1])+Math.abs(data[n+2]-data[2])>15)changed++;
 if(changed<25)throw Error('empty');window.result={min:b.min.toArray(),max:b.max.toArray(),meshes,changed};renderer.dispose();renderer.forceContextLoss();
 }catch(e){window.failure='MODEL_RENDER_INVALID';}</script>`;
 const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else if(req.url==='/model.glb'){res.setHeader('Content-Type','model/gltf-binary');res.end(bytes);}else if(modules[req.url??'']){res.setHeader('Content-Type','text/javascript');res.end(await readFile(modules[req.url!]));}else{res.statusCode=404;res.end();}}catch{res.statusCode=500;res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 let browser;try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl']});
  const page=await browser.newPage();page.on('response',r=>{if(r.status()>=400)void page.evaluate(()=>{(window as any).failure='MODEL_MODULE_INVALID';}).catch(()=>{});});page.on('pageerror',(e)=>{void page.evaluate(()=>{(window as any).failure='MODEL_MODULE_INVALID';}).catch(()=>{});});await page.route('**/*',route=>{const u=route.request().url();return u.startsWith(`http://127.0.0.1:${port}/`)?route.continue():route.abort();});
  await page.goto(`http://127.0.0.1:${port}/`);await page.waitForFunction(()=>Boolean((window as any).result||(window as any).failure),{},{timeout:45000});
  const result=await page.evaluate(()=>(window as any).result);if(!result)throw new Error('MODEL_RENDER_INVALID');
  const size=result.max.map((n:number,i:number)=>n-result.min[i]);const scale=1/Math.max(...size);
  return {sha256:sha256(bytes),byteSize:bytes.length,triangles:info.triangles,rendered:true,
   normalization:{scale,translation:[-(result.min[0]+result.max[0])/2,-result.min[1],-(result.min[2]+result.max[2])/2]},
   bounds:{min:[-size[0]*scale/2,0,-size[2]*scale/2],max:[size[0]*scale/2,size[1]*scale,size[2]*scale/2]}};
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
