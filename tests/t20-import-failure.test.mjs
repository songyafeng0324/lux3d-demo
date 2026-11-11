// T20: a refused upload says which rule it broke, in Chinese, with the numbers (not just MODEL_INVALID).
import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';
import {inspectModel,validateModel,ModelRejection,MODEL_TRIANGLE_LIMIT,ALLOWED_MODEL_EXTENSIONS} from '@aholo/domain';
function glb(edit=()=>{},extraBin=Buffer.alloc(0)){
 const j={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-.5,0,0],max:[.5,1,0]}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36}],buffers:[{byteLength:36+extraBin.length}]};
 edit(j);let json=Buffer.from(JSON.stringify(j));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
 let b=Buffer.concat([Buffer.from(new Float32Array([-.5,0,0,.5,0,0,0,1,0]).buffer),extraBin]);b=Buffer.concat([b,Buffer.alloc((4-b.length%4)%4)]);
 const h=Buffer.alloc(20),bh=Buffer.alloc(8);h.writeUInt32LE(0x46546c67,0);h.writeUInt32LE(2,4);h.writeUInt32LE(28+json.length+b.length,8);h.writeUInt32LE(json.length,12);h.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(b.length);bh.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([h,json,bh,b]);
}
const refused=(fn,code,pattern)=>{let caught;try{fn();}catch(e){caught=e;}assert.ok(caught instanceof ModelRejection,`expected ModelRejection, got ${caught}`);assert.equal(caught.code,code);assert.equal(caught.message,code);assert.match(caught.reason,pattern);return caught;};

test('budget overruns name the budget and both numbers',()=>{
 // Two primitives share one zero-filled index accessor without a bufferView (legal glTF): 2 × 175,001 triangles.
 const indexed=count=>j=>{j.accessors.push({componentType:5125,count,type:'SCALAR'});j.meshes[0].primitives=[{attributes:{POSITION:0},indices:1},{attributes:{POSITION:0},indices:1}];};
 assert.equal(inspectModel(glb(indexed(525000))).triangles,350000,'exactly at the limit passes');
 assert.equal(inspectModel(glb(indexed(464436))).triangles,309624,'the 后母戊鼎 count now passes');
 const tri=refused(()=>inspectModel(glb(indexed(525003))),'MODEL_TRIANGLE_LIMIT',/^三角面 350,002 个，超过上限 350,000 个，请减面后再上传$/);
 assert.deepEqual([tri.detail.actual,tri.detail.limit],[350002,MODEL_TRIANGLE_LIMIT]);
 refused(()=>inspectModel(glb(j=>{j.nodes=Array.from({length:300},()=>({mesh:0}));j.scenes[0].nodes=j.nodes.map((_,i)=>i);})),'MODEL_INSTANCE_LIMIT',/网格实例 300 个，超过上限 256 个/);
 refused(()=>inspectModel(glb(j=>{j.materials=Array.from({length:129},()=>({}));})),'MODEL_RESOURCE_LIMIT',/材质数 129 个，超过上限 128 个/);
 refused(()=>inspectModel(glb(j=>{delete j.accessors[0].bufferView;j.accessors[0].count=2_000_000;})),'MODEL_ACCESSOR_LIMIT',/2,000,000 项，超过上限 1,000,000 项/);
});
test('external textures, compression and extensions are named',()=>{
 refused(()=>inspectModel(glb(j=>{j.images=[{uri:'https://example.invalid/wood.png'},{uri:'wood_n.png'}];})),'MODEL_EXTERNAL_TEXTURE',/有 2 张贴图是外链/);
 refused(()=>inspectModel(glb(j=>{j.buffers[0].uri='scene.bin';})),'MODEL_EXTERNAL_BUFFER',/外部 \.bin/);
 refused(()=>inspectModel(glb(j=>{j.extensionsUsed=['KHR_draco_mesh_compression'];j.extensionsRequired=['KHR_draco_mesh_compression'];})),'MODEL_COMPRESSION_UNSUPPORTED',/Draco 网格压缩.*请导出未压缩的 GLB/);
 refused(()=>inspectModel(glb(j=>{j.extensionsUsed=['KHR_texture_basisu','EXT_meshopt_compression'];})),'MODEL_COMPRESSION_UNSUPPORTED',/KTX2\/Basis 贴图压缩、meshopt 压缩/);
 refused(()=>inspectModel(glb(j=>{j.nodes[0].extensions={EXT_mesh_gpu_instancing:{attributes:{TRANSLATION:0}}};})),'MODEL_EXTENSION_UNSUPPORTED',/EXT_mesh_gpu_instancing/);
 refused(()=>inspectModel(glb(j=>{j.animations=[{channels:[],samplers:[]}];})),'MODEL_ANIMATION_UNSUPPORTED',/只接受静态模型/);
});
test('damaged or foreign files say so instead of a code',()=>{
 refused(()=>inspectModel(Buffer.from('{"asset":{"version":"2.0"}}')),'MODEL_NOT_GLB',/不是 GLB 二进制文件/);
 const whole=glb();refused(()=>inspectModel(whole.subarray(0,whole.length-8)),'MODEL_TRUNCATED',/文件不完整/);
 refused(()=>inspectModel(glb(j=>{j.nodes[0].children=[0];})),'MODEL_NODE_INVALID',/文件结构损坏/);
 refused(()=>inspectModel(glb(j=>{j.images={};})),'MODEL_JSON_INVALID',/文件结构损坏/);
});
test('texture problems name the texture',async()=>{
 const tex=await sharp({create:{width:8,height:8,channels:3,background:'#8a6a3c'}}).gif().toBuffer();
 const bytes=glb(j=>{j.bufferViews.push({buffer:0,byteOffset:36,byteLength:tex.length});j.images=[{bufferView:1,mimeType:'image/png'}];},tex);
 await assert.rejects(()=>validateModel(bytes),e=>e instanceof ModelRejection&&e.code==='MODEL_TEXTURE_FORMAT'&&/第 1 张贴图格式为 gif/.test(e.reason));
 const junk=Buffer.from('not an image at all');
 await assert.rejects(()=>validateModel(glb(j=>{j.bufferViews.push({buffer:0,byteOffset:36,byteLength:junk.length});j.images=[{bufferView:1,mimeType:'image/png'}];},junk)),e=>e instanceof ModelRejection&&e.code==='MODEL_TEXTURE_INVALID'&&/第 1 张贴图无法解码/.test(e.reason));
});
test('material-parameter extensions are accepted and still render; others stay refused',async()=>{
 assert.deepEqual([...ALLOWED_MODEL_EXTENSIONS].sort(),['KHR_materials_emissive_strength','KHR_materials_ior','KHR_materials_specular','KHR_texture_transform']);
 const tex=await sharp({create:{width:8,height:8,channels:3,background:'#8a6a3c'}}).png().toBuffer();
 const bytes=glb(j=>{j.extensionsUsed=[...ALLOWED_MODEL_EXTENSIONS];j.bufferViews.push({buffer:0,byteOffset:36,byteLength:tex.length});j.images=[{bufferView:1,mimeType:'image/png'}];j.textures=[{source:0}];
  j.materials=[{pbrMetallicRoughness:{baseColorTexture:{index:0,extensions:{KHR_texture_transform:{scale:[2,2]}}}},emissiveFactor:[.2,.1,0],extensions:{KHR_materials_specular:{specularFactor:.35},KHR_materials_ior:{ior:1.6},KHR_materials_emissive_strength:{emissiveStrength:2}}}];j.meshes[0].primitives[0].material=0;},tex);
 assert.equal(inspectModel(bytes).triangles,1);
 const r=await validateModel(bytes);assert.equal(r.rendered,true);
 // Mixed with an unlisted one, only the unlisted one is named.
 refused(()=>inspectModel(glb(j=>{j.extensionsUsed=['KHR_materials_specular','KHR_materials_clearcoat'];})),'MODEL_EXTENSION_UNSUPPORTED',/^使用了不支持的 glTF 扩展：KHR_materials_clearcoat，/);
 refused(()=>inspectModel(glb(j=>{j.materials=[{extensions:{KHR_materials_specular:{specularFactor:.3},KHR_materials_transmission:{transmissionFactor:1}}}];})),'MODEL_EXTENSION_UNSUPPORTED',/KHR_materials_transmission/);
});
