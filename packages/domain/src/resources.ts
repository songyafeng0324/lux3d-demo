import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {chromium} from 'playwright';
export const IMAGE_LIMIT=10*1024*1024;
export const MODEL_LIMIT=100*1024*1024;
/** Triangle budget per model, both as authored and after node instancing (2026-11-11: raised from 300,000). */
export const MODEL_TRIANGLE_LIMIT=350_000;
export const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export async function validateImage(bytes:Buffer){
 if(!bytes.length||bytes.length>IMAGE_LIMIT)throw new Error('IMAGE_SIZE_INVALID');
 const image=sharp(bytes,{limitInputPixels:16_777_216,failOn:'warning'}),m=await image.metadata();
 if(!['png','jpeg','webp'].includes(m.format??'')||(m.pages??1)>1)throw new Error('IMAGE_FORMAT_INVALID');
 await image.raw().toBuffer(); // Metadata alone does not establish complete decoding.
 return {mime:`image/${m.format}`,extension:m.format==='jpeg'?'jpg':m.format!};
}
/**
 * A model the checks refuse. `code` is stable for programs, `reason` is the plain-Chinese sentence shown
 * to the uploader (which budget, which extension, which texture), `detail` keeps the numbers.
 * Anything else thrown while validating is an environment fault (Chrome, storage), not the model's.
 */
export class ModelRejection extends Error{
 /** True when the fault may lie with a busy machine rather than the model (a render timeout): the worker retries it first. */
 retryable=false;
 constructor(readonly code:string,readonly reason:string,readonly detail:Record<string,string|number|string[]>={}){super(code);this.name='ModelRejection';}
}
const num=(n:number)=>n.toLocaleString('en-US'),mib=(n:number)=>`${(n/1024/1024).toFixed(1)} MiB`;
const reject=(code:string,reason:string,detail:ModelRejection['detail']={})=>new ModelRejection(code,reason,detail);
const broken=(code:string,what:string)=>reject(code,`文件结构损坏：${what}，请用建模软件重新导出 GLB`);
const budget=(code:string,item:string,actual:number,limit:number,unit:string,hint='请精简后再上传')=>reject(code,`${item} ${num(actual)}${unit}，超过上限 ${num(limit)}${unit}，${hint}`,{item,actual,limit});
const COMPRESSION:Record<string,string>={KHR_draco_mesh_compression:'Draco 网格压缩',EXT_meshopt_compression:'meshopt 压缩',KHR_meshopt_compression:'meshopt 压缩',KHR_texture_basisu:'KTX2/Basis 贴图压缩',KHR_mesh_quantization:'网格量化',EXT_texture_webp:'WebP 贴图扩展',EXT_texture_avif:'AVIF 贴图扩展'};
/**
 * Material-parameter extensions three.js reads natively: plain numbers and texture references, no external
 * data, no decoder and no geometry change (2026-11-11). Everything else is still refused.
 */
export const ALLOWED_MODEL_EXTENSIONS=['KHR_materials_specular','KHR_materials_ior','KHR_materials_emissive_strength','KHR_texture_transform'] as const;
const allowedExtension=new Set<string>(ALLOWED_MODEL_EXTENSIONS);
function extensionRejection(names:string[]){
 const compressed=names.filter(n=>COMPRESSION[n]);
 if(compressed.length)return reject('MODEL_COMPRESSION_UNSUPPORTED',`使用了不支持的压缩格式：${[...new Set(compressed.map(n=>COMPRESSION[n]))].join('、')}（${compressed.join(', ')}），请导出未压缩的 GLB`,{extensions:compressed});
 return reject('MODEL_EXTENSION_UNSUPPORTED',`使用了不支持的 glTF 扩展：${names.join(', ')}，请导出时关闭这些扩展（材质的高光、折射率、自发光强度与贴图变换扩展可以保留）`,{extensions:names});
}
/** Pure structural check; any unexpected throw here comes from malformed JSON shapes, so it is the model's fault too. */
export function inspectModel(bytes:Buffer){
 try{return inspectStructure(bytes);}
 catch(error){if(error instanceof ModelRejection)throw error;throw broken('MODEL_JSON_INVALID','JSON 内容的字段类型不正确');}
}
function inspectStructure(bytes:Buffer){
 if(bytes.length>MODEL_LIMIT)throw reject('MODEL_SIZE_LIMIT',`文件 ${mib(bytes.length)}，超过上限 100 MiB，请压缩贴图或减面后再上传`,{actual:bytes.length,limit:MODEL_LIMIT});
 if(bytes.length<12||bytes.readUInt32LE(0)!==0x46546c67)throw reject('MODEL_NOT_GLB','不是 GLB 二进制文件：可能是 .gltf 文本、其他格式改了扩展名，或文件已损坏');
 if(bytes.readUInt32LE(4)!==2)throw reject('MODEL_VERSION_UNSUPPORTED',`GLB 容器版本为 ${bytes.readUInt32LE(4)}，只支持 glTF 2.0`);
 if(bytes.length<28||bytes.readUInt32LE(8)!==bytes.length)throw reject('MODEL_TRUNCATED',`文件不完整：头部声明 ${num(bytes.readUInt32LE(8))} 字节，实际 ${num(bytes.length)} 字节，可能上传或导出时中断`,{declared:bytes.readUInt32LE(8),actual:bytes.length});
 const length=bytes.readUInt32LE(12);
 if(length%4||bytes.readUInt32LE(16)!==0x4e4f534a||length+28>bytes.length)throw broken('MODEL_JSON_INVALID','JSON 块的长度或标记不正确');
 let j:any;try{j=JSON.parse(bytes.subarray(20,20+length).toString('utf8'));}catch{throw broken('MODEL_JSON_INVALID','JSON 块无法解析');}
 if(!j||typeof j!=='object'||Array.isArray(j))throw broken('MODEL_JSON_INVALID','JSON 块不是对象');
 if(j.asset?.version!=='2.0')throw reject('MODEL_VERSION_UNSUPPORTED',`glTF 版本为 ${String(j.asset?.version??'缺失')}，只支持 2.0`);
 if(!j.scenes?.length||!j.meshes?.length)throw reject('MODEL_SCENE_INVALID','文件里没有场景或网格，没有可显示的模型');
 if(!j.buffers?.length)throw broken('MODEL_BUFFER_INVALID','缺少二进制数据块');
 const declared=[...new Set([...(j.extensionsUsed??[]),...(j.extensionsRequired??[]),...Object.keys(j.extensions??{})].map(String))].filter(n=>!allowedExtension.has(n));
 if(declared.length)throw extensionRejection(declared);
 if(j.buffers.length!==1||j.buffers[0].uri)throw reject('MODEL_EXTERNAL_BUFFER','几何数据引用了外部 .bin 文件或网址，请导出为单个自包含的 GLB',{buffers:j.buffers.length});
 const linked=(j.images??[]).filter((v:any)=>v.uri);
 if(linked.length)throw reject('MODEL_EXTERNAL_TEXTURE',linked.every((v:any)=>String(v.uri).startsWith('data:'))?`有 ${linked.length} 张贴图以 data URI 写在 JSON 里，请导出为二进制内嵌贴图的 GLB`:`有 ${linked.length} 张贴图是外链（引用了外部文件或网址），请把贴图嵌入 GLB 后再导出`,{count:linked.length});
 const offset=20+length;if(offset+8>bytes.length)throw broken('MODEL_BUFFER_INVALID','缺少二进制数据块');
 const bin=bytes.readUInt32LE(offset);
 if(bytes.readUInt32LE(offset+4)!==0x004e4942||offset+8+bin!==bytes.length||j.buffers[0].byteLength>bin||bin-j.buffers[0].byteLength>3)throw broken('MODEL_BUFFER_INVALID','二进制数据块长度与声明不符');
 const counted=(list:unknown,limit:number,item:string,unit:string)=>{const n=Array.isArray(list)?list.length:0;if(n>limit)throw budget('MODEL_RESOURCE_LIMIT',item,n,limit,unit);};
 counted(j.nodes,4096,'节点数',' 个');counted(j.meshes,256,'网格模板数',' 个');counted(j.images,64,'贴图数',' 张');
 const nested=new Set<string>(),stack:unknown[]=[j];while(stack.length){const value=stack.pop();if(value&&typeof value==='object'){if(Object.hasOwn(value,'extensions'))for(const k of Object.keys((value as any).extensions??{}))if(!allowedExtension.has(k))nested.add(k);for(const child of Object.values(value))if(child&&typeof child==='object')stack.push(child);}}
 if(nested.size)throw extensionRejection([...nested]);
 const validInt=(n:unknown,max:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=max;
 if((j.animations??[]).length||(j.skins??[]).length)throw reject('MODEL_ANIMATION_UNSUPPORTED','含动画或骨骼蒙皮，只接受静态模型，请导出时去掉动画和骨骼');
 counted(j.accessors,4096,'数据访问器数',' 个');counted(j.bufferViews,4096,'缓冲视图数',' 个');counted(j.materials,128,'材质数',' 个');counted(j.textures,64,'纹理数',' 个');counted(j.scenes,16,'场景数',' 个');
 const views=j.bufferViews??[],accessors=j.accessors??[],bufferBytes=j.buffers[0].byteLength;
 for(const v of views){if(v.buffer!==0||!validInt(v.byteOffset??0,bufferBytes)||!validInt(v.byteLength,bufferBytes)||(v.byteOffset??0)+v.byteLength>bufferBytes||v.byteStride!==undefined&&(!validInt(v.byteStride,252)||v.byteStride<4||v.byteStride%4))throw broken('MODEL_VIEW_INVALID','缓冲视图越界');}
 const widths:Record<number,number>={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},components:Record<string,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};let decoded=0;
 for(const ac of accessors){const width=widths[ac.componentType],count=components[ac.type],stride=width*count;
  if(!width||!count)throw broken('MODEL_ACCESSOR_INVALID','数据访问器类型不正确');
  if(validInt(ac.count,Number.MAX_SAFE_INTEGER)&&ac.count>1_000_000)throw budget('MODEL_ACCESSOR_LIMIT','单个数据数组',ac.count,1_000_000,' 项');
  if(!validInt(ac.count,1_000_000)||!ac.count||!validInt(ac.byteOffset??0,MODEL_LIMIT))throw broken('MODEL_ACCESSOR_INVALID','数据访问器的数量或偏移不正确');
  decoded+=ac.count*stride;
  if(ac.count*stride>32*1024*1024)throw reject('MODEL_DECODE_LIMIT',`单个数据数组解码后 ${mib(ac.count*stride)}，超过上限 32 MiB，请减面后再上传`,{actual:ac.count*stride,limit:32*1024*1024});
  if(decoded>128*1024*1024)throw reject('MODEL_DECODE_LIMIT',`几何数据解码后合计超过上限 128 MiB，请减面后再上传`,{limit:128*1024*1024});
  if(ac.bufferView!==undefined){const v=views[ac.bufferView];if(!v||!validInt(ac.bufferView,views.length-1)||(v.byteStride??stride)<stride||(ac.byteOffset??0)+(ac.count-1)*(v.byteStride??stride)+stride>v.byteLength)throw broken('MODEL_ACCESSOR_INVALID','数据访问器越界');}
  if(ac.sparse){const sp=ac.sparse;if(!validInt(sp.count,ac.count)||!sp.count)throw broken('MODEL_SPARSE_INVALID','稀疏数据数量不正确');for(const [part,w] of [[sp.indices,widths[sp.indices?.componentType]],[sp.values,stride]] as any){const v=views[part?.bufferView];if(!v||!w||!validInt(part.byteOffset??0,v.byteLength)||(part.byteOffset??0)+sp.count*w>v.byteLength)throw broken('MODEL_SPARSE_INVALID','稀疏数据越界');}}
 }
 let triangles=0,vertices=0;const meshTriangles:number[]=[];
 for(const mesh of j.meshes){let meshTotal=0;if(!Array.isArray(mesh.primitives))throw broken('MODEL_PRIMITIVE_INVALID','网格缺少图元');if(mesh.primitives.length>256)throw budget('MODEL_PRIMITIVE_LIMIT','单个网格的图元数',mesh.primitives.length,256,' 个');for(const p of mesh.primitives){
  const ac=accessors[p.attributes?.POSITION];
  if((p.targets??[]).length||(mesh.weights??[]).length)throw reject('MODEL_MORPH_UNSUPPORTED','含形变目标（morph target），只接受静态模型');
  if(!ac||ac.type!=='VEC3'||ac.componentType!==5126)throw reject('MODEL_PRIMITIVE_INVALID','顶点坐标缺失或不是 32 位浮点（可能做过量化压缩），请导出标准浮点坐标的 GLB');
  if((p.mode??4)!==4)throw reject('MODEL_PRIMITIVE_UNSUPPORTED','含点、线或三角带等非三角形图元，只支持普通三角形网格');
  vertices+=ac.count;
  const count=p.indices===undefined?ac.count:accessors[p.indices]?.count;
  if(!Number.isSafeInteger(count)||count<3||count%3)throw broken('MODEL_INDEX_INVALID','三角形索引数量不是 3 的倍数');meshTotal+=count/3;
 }meshTriangles.push(meshTotal);triangles+=meshTotal;}
 if(vertices>900000)throw budget('MODEL_VERTEX_LIMIT','顶点',vertices,900000,' 个','请减面后再上传');
 if(!triangles)throw reject('MODEL_SCENE_INVALID','模型没有任何三角面');
 if(triangles>MODEL_TRIANGLE_LIMIT)throw budget('MODEL_TRIANGLE_LIMIT','三角面',triangles,MODEL_TRIANGLE_LIMIT,' 个','请减面后再上传');
 const nodes=j.nodes??[],parents=new Set<number>();let instanceTriangles=0,meshInstances=0;
 for(let n=0;n<nodes.length;n++){const node=nodes[n];if((node.weights??[]).length)throw reject('MODEL_MORPH_UNSUPPORTED','含形变目标（morph target），只接受静态模型');if(node.mesh!==undefined){if(!validInt(node.mesh,j.meshes.length-1))throw broken('MODEL_NODE_INVALID','节点引用了不存在的网格');instanceTriangles+=meshTriangles[node.mesh];meshInstances++;}
  for(const child of node.children??[]){if(!validInt(child,nodes.length-1)||parents.has(child)||child===n)throw broken('MODEL_NODE_INVALID','节点层级引用不正确');parents.add(child);}
 }
 if(instanceTriangles>MODEL_TRIANGLE_LIMIT)throw budget('MODEL_INSTANCE_LIMIT','按节点实例展开后的三角面',instanceTriangles,MODEL_TRIANGLE_LIMIT,' 个','请减少重复实例或减面');
 if(meshInstances>256)throw budget('MODEL_INSTANCE_LIMIT','网格实例',meshInstances,256,' 个','请合并网格后再上传');
 const visited=new Set<number>(),active=new Set<number>();
 const visit=(n:number)=>{if(active.has(n))throw broken('MODEL_NODE_CYCLE','节点层级有循环');if(visited.has(n))return;active.add(n);for(const child of nodes[n].children??[])visit(child);active.delete(n);visited.add(n);};for(let n=0;n<nodes.length;n++)visit(n);
 for(const scene of j.scenes){if(!Array.isArray(scene.nodes)||scene.nodes.some((n:number)=>!validInt(n,nodes.length-1)||parents.has(n))||new Set(scene.nodes).size!==scene.nodes.length)throw broken('MODEL_SCENE_INVALID','场景节点引用不正确');}
 return {json:j,triangles,binStart:offset+8};
}
const RENDER_STAGES:Record<string,string>={
 external:'模型在载入时请求了外部资源（贴图或数据外链），请导出自包含的 GLB',
 geometry:'顶点坐标含无效数值（NaN 或无穷大），请在建模软件里清理几何后重新导出',
 bounds:'模型没有可见网格或尺寸为零',
 empty:'渲染出的画面是空的：模型可能全透明、材质异常，或尺寸极端',
 render:'Chrome 渲染时出现 WebGL 错误，模型可能含有不兼容的数据',
};
export async function validateModel(bytes:Buffer){
 const info=inspectModel(bytes);let pixels=0;
 for(const [index,image] of (info.json.images??[]).entries() as Iterable<[number,any]>){
  const no=index+1,view=info.json.bufferViews?.[image.bufferView];
  if(!view||view.buffer!==0||!Number.isSafeInteger(view.byteLength)||view.byteLength<1)throw broken('MODEL_TEXTURE_INVALID',`第 ${no} 张贴图的数据位置不正确`);
  const start=info.binStart+(view.byteOffset??0),end=start+view.byteLength;
  if(start<info.binStart||end>bytes.length)throw broken('MODEL_TEXTURE_INVALID',`第 ${no} 张贴图的数据越界`);
  const texture=sharp(bytes.subarray(start,end),{limitInputPixels:16_777_216,failOn:'warning'});
  let m;try{m=await texture.metadata();}catch{throw reject('MODEL_TEXTURE_INVALID',`第 ${no} 张贴图无法解码（数据损坏或不是图片）`,{index:no});}
  if(!['png','jpeg','webp'].includes(m.format??''))throw reject('MODEL_TEXTURE_FORMAT',`第 ${no} 张贴图格式为 ${m.format??'未知'}，只支持 PNG、JPEG、WebP`,{index:no,format:m.format??'unknown'});
  if((m.pages??1)>1)throw reject('MODEL_TEXTURE_FORMAT',`第 ${no} 张贴图是多帧图片，只支持单帧`,{index:no});
  const px=(m.width??0)*(m.height??0);
  if(px>16_777_216)throw budget('MODEL_TEXTURE_LIMIT',`第 ${no} 张贴图（${m.width}×${m.height}）像素`,px,16_777_216,'','请缩小到 4096×4096 以内');
  pixels+=px;if(pixels>67_108_864)throw budget('MODEL_TEXTURE_LIMIT','贴图总像素',pixels,67_108_864,'','请缩小贴图或减少贴图数量');
  try{await texture.raw().toBuffer();}catch{throw reject('MODEL_TEXTURE_INVALID',`第 ${no} 张贴图数据不完整或已损坏，无法完整解码`,{index:no});}
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
 }catch(e){const m=String(e?.message??e);window.failure={stage:['external','geometry','bounds','empty','render'].includes(m)?m:'load',message:m.slice(0,200)};}</script>`;
 const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else if(req.url==='/model.glb'){res.setHeader('Content-Type','model/gltf-binary');res.end(bytes);}else if(modules[req.url??'']){res.setHeader('Content-Type','text/javascript');res.end(await readFile(modules[req.url!]));}else{res.statusCode=404;res.end();}}catch{res.statusCode=500;res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 let browser;try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl']});
  const page=await browser.newPage();page.on('response',r=>{if(r.status()>=400)void page.evaluate(()=>{(window as any).failure??='MODEL_MODULE_INVALID';}).catch(()=>{});});page.on('pageerror',(e)=>{void page.evaluate(()=>{(window as any).failure??='MODEL_MODULE_INVALID';}).catch(()=>{});});await page.route('**/*',route=>{const u=route.request().url();return u.startsWith(`http://127.0.0.1:${port}/`)?route.continue():route.abort();});
  await page.goto(`http://127.0.0.1:${port}/`);
  try{await page.waitForFunction(()=>Boolean((window as any).result||(window as any).failure),{},{timeout:45000});}
  catch{const timeout=reject('MODEL_RENDER_TIMEOUT','Chrome 多次在 45 秒内都没能载入并渲染完这个模型，模型或贴图可能过大、过于复杂；若当时本机很忙，可稍后重新上传');timeout.retryable=true;throw timeout;}
  const {result,failure}=await page.evaluate(()=>({result:(window as any).result,failure:(window as any).failure}));
  // A missing page module (string failure) is the validator's own fault; a stage object is the model's.
  if(!result){if(failure&&typeof failure==='object'){const stage=String(failure.stage);throw reject('MODEL_RENDER_INVALID',RENDER_STAGES[stage]??`Chrome 无法载入这个模型（${String(failure.message)}），文件可能损坏，或使用了不支持的格式`,{stage});}throw new Error('MODEL_MODULE_INVALID');}
  const size=result.max.map((n:number,i:number)=>n-result.min[i]);const scale=1/Math.max(...size);
  return {sha256:sha256(bytes),byteSize:bytes.length,triangles:info.triangles,rendered:true,
   normalization:{scale,translation:[-(result.min[0]+result.max[0])/2,-result.min[1],-(result.min[2]+result.max[2])/2]},
   bounds:{min:[-size[0]*scale/2,0,-size[2]*scale/2],max:[size[0]*scale/2,size[1]*scale,size[2]*scale/2]}};
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
