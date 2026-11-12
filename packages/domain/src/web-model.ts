// The copy of a ready model that the web pages load (2026-11-12): Lux3D files are 8-18 MB, mostly 2048 px PNG
// textures plus float geometry, and each room or the gallery fetched them in full across the Hong Kong border.
// The copy keeps every texture at full size as WebP and stores geometry quantised (KHR_mesh_quantization) and
// meshopt-compressed (EXT_meshopt_compression), usually 5-8 times smaller. The original stays the source of
// truth: it is what was validated, what downloads return, and the copy is rebuilt from it if the policy changes.
// The copy is made by this server from a validated model, so the compression extensions that uploads may not
// use (ALLOWED_MODEL_EXTENSIONS) are fine here; the copy is checked against the original instead.
import {Logger,NodeIO,type Document} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {dedup,getBounds,prune,quantize,reorder,textureCompress} from '@gltf-transform/functions';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
import sharp from 'sharp';
/** Recorded with each copy; a new policy means existing copies may be rebuilt. */
export const WEB_MODEL_POLICY='web-v1';
/** A copy that does not save at least this share of the original is not kept (the original is served). */
const MIN_SAVING=.1;
async function io(){
 await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
 return new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
}
function triangles(doc:Document){
 let n=0;for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives()){if(p.getMode()!==4)continue;n+=(p.getIndices()?.getCount()??p.getAttribute('POSITION')?.getCount()??0)/3;}
 return n;
}
function sceneBounds(doc:Document){
 const scene=doc.getRoot().getDefaultScene()??doc.getRoot().listScenes()[0];if(!scene)throw new Error('WEB_COPY_NO_SCENE');
 return getBounds(scene);
}
/** The copy and the original must draw the same triangles inside the same box (quantisation moves a vertex by under 0.1% of the extent). */
function sameShape(a:Document,b:Document){
 if(triangles(a)!==triangles(b))return false;
 const x=sceneBounds(a),y=sceneBounds(b);
 const extent=Math.max(...x.max.map((v,i)=>v-x.min[i]),1e-6);
 return [...x.min,...x.max].every((v,i)=>Math.abs(v-[...y.min,...y.max][i])<=extent*.002);
}
/** null = keep serving the original (the copy would not be meaningfully smaller). */
export async function buildWebModel(original:Uint8Array):Promise<Uint8Array|null>{
 const reader=await io(),doc=await reader.readBinary(original);
 doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 await doc.transform(
  dedup(),prune(),
  // Texture coordinates get 14 bits: the default 12 would round UVs to a quarter of a 2048 px texel's neighbourhood.
  quantize({quantizePosition:14,quantizeNormal:10,quantizeTexcoord:14,quantizeColor:8,quantizeGeneric:12}),
  reorder({encoder:MeshoptEncoder}),
  // Normal maps keep more detail (lossy blocks bend shading); colour and metal/roughness at 88 render indistinguishably.
  textureCompress({encoder:sharp,targetFormat:'webp',quality:95,effort:70,slots:/^normalTexture$/}),
  textureCompress({encoder:sharp,targetFormat:'webp',quality:88,effort:70,slots:/^(?!normalTexture$)/}),
 );
 const copy=await reader.writeBinary(doc);
 if(copy.byteLength>original.byteLength*(1-MIN_SAVING))return null;
 if(!sameShape(await reader.readBinary(original),await reader.readBinary(copy)))throw new Error('WEB_COPY_SHAPE_MISMATCH');
 return copy;
}
