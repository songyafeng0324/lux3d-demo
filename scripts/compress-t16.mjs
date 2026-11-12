// T16 D4: build the runtime copy of the pavilion that the web loads. Run after build_t16.py and bake_t16.py:
//   node scripts/compress-t16.mjs
// Source of truth stays assets/t16/pavilion-t16.glb (Blender export, hashed by the bake) and the JPEG
// lightmaps; this writes assets/t16/runtime/:
//   pavilion-t16.glb  shared prop meshes as EXT_mesh_gpu_instancing, geometry quantised (KHR_mesh_quantization)
//                     and EXT_meshopt_compression, textures as KTX2 (KHR_texture_basisu) PREVIEWS only
//   textures/*.ktx2   every GLB texture at full size, keyed by the (unique) image name the preview carries
//   lightmaps/*.ktx2  the baked AO and GI maps, plus a small `-preview` copy of each
//   manifest.json     SHA-256 of every input and output, so a stale runtime copy fails the unit tests
// First screen (2026-11-12, served from Hong Kong to the mainland): the page shows the hall as soon as the
// geometry and the previews are in (PREVIEW px textures, PREVIEW_LIGHTMAP px lightmaps, all ETC1S), then the
// engine swaps each slot for its full-size file in the background. Same materials and UV sets either way,
// so nothing recompiles; only the pixels get sharper.
// Texture codecs: colour, emissive, roughness/metal masks and the lightmaps ETC1S (about the JPEG's size or
// smaller, a quarter to an eighth of the GPU memory); normal maps UASTC + RDO + Zstandard, because ETC1S
// blocks smear normals. Lightmaps were tried both ways (D4): in eight fixed views UASTC and ETC1S differ from
// the JPEG render by the same mean 1-3 levels, while UASTC weighed 17.7 MB (the bake's noise defeats its
// supercompression) against ETC1S's 4.3 MB.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, instance, reorder, quantize } from '@gltf-transform/functions';
import { encodeToKTX2 } from 'ktx2-encoder';
import { MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';

// sharp lives with @aholo/domain (as for build-characters.mjs): run `npm install` at the repo root first.
const sharp = (() => {
  try { return createRequire(path.resolve('packages/domain/package.json'))('sharp'); }
  catch { throw new Error('sharp not found under packages/domain: run `npm install` at the repo root, from the repo root'); }
})();
const SRC = path.resolve('assets/t16'), OUT = path.join(SRC, 'runtime');
const SOURCE_GLB = path.join(SRC, 'pavilion-t16.glb'), LIGHTMAP_MANIFEST = path.join(SRC, 'pavilion-lightmaps.json');
const sha = b => createHash('sha256').update(b).digest('hex');
const imageDecoder = async b => {
  const { data, info } = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const ETC1S = { isUASTC: false, qualityLevel: 255, compressionLevel: 2 };
const UASTC = { isUASTC: true, uastcLDRQualityLevel: 2, enableRDO: true, rdoQualityLevel: 1, needSupercompression: true };
/** Codec per material slot; `srgb` must match how three samples the slot. */
const CODEC = {
  baseColorTexture: { ...ETC1S, srgb: true }, emissiveTexture: { ...ETC1S, srgb: true },
  metallicRoughnessTexture: { ...ETC1S, srgb: false }, occlusionTexture: { ...ETC1S, srgb: false },
  normalTexture: { ...UASTC, srgb: false, isNormalMap: true },
};
/** Longest side of the previews embedded in the GLB, and of the lightmap previews. */
const PREVIEW = 128, PREVIEW_LIGHTMAP = 256;
/** Block codecs want sides in multiples of four (WebGL rejects other sizes for some formats): stretch by < 4 px. */
async function blockAligned(image) {
  const { width, height } = await sharp(image).metadata(), up = n => Math.ceil(n / 4) * 4;
  if (width % 4 === 0 && height % 4 === 0) return image;
  return new Uint8Array(await sharp(image).resize(up(width), up(height), { fit: 'fill' }).png().toBuffer());
}
async function encode(image, { srgb, ...codec }) {
  image = await blockAligned(image);
  return encodeToKTX2(image, {
    ...codec, isPerceptual: srgb, isInputSRGB: srgb, isSetKTX2SRGBTransferFunc: srgb, generateMipmap: true, imageDecoder,
  });
}
/** A copy no larger than `max` px on its longest side (never enlarged). */
async function shrink(image, max) {
  return new Uint8Array(await sharp(image).resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).png().toBuffer());
}
/** A small pool: the encoder is single-threaded WASM, a few in flight keep the cores busy without blowing memory. */
async function pool(items, fn, width = Math.max(1, Math.min(4, cpus().length - 1))) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

await MeshoptEncoder.ready;
const sourceBytes = await fs.readFile(SOURCE_GLB), lightmapManifestBytes = await fs.readFile(LIGHTMAP_MANIFEST);
const lightmapManifest = JSON.parse(lightmapManifestBytes);
if (lightmapManifest.glbSHA256 !== sha(sourceBytes)) throw new Error('lightmaps were baked for another GLB: rerun scripts/blender/bake_t16.py first');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.readBinary(sourceBytes);
const t0 = Date.now();

// Geometry. instance() turns props placed many times (curios, lamps, censers) into one InstancedMesh each;
// the web merges the rest of the shell by material. No prune(): it would drop TEXCOORD_1, which no glTF
// material references (the lightmaps are attached at runtime).
await doc.transform(dedup(), instance({ min: 2 }));
// three culls front faces by the InstancedMesh's own matrix, not per instance: a mirrored instance (negative
// scale) would turn inside out. Mirrored props must stay separate meshes (Prop_B1_mirror is one).
for (const node of doc.getRoot().listNodes()) {
  const batch = node.getExtension('EXT_mesh_gpu_instancing'), scale = batch?.getAttribute('SCALE');
  if (!scale) continue;
  const s = [];
  for (let i = 0; i < scale.getCount(); i++) if (scale.getElement(i, s).reduce((a, b) => a * b, 1) <= 0) throw new Error(`mirrored instance ${i} of ${node.getName()}`);
}
await doc.transform(
  reorder({ encoder: MeshoptEncoder }),
  // 16-bit positions over the largest shell mesh (~80 m) keep the error near a millimetre, under the
  // export gates' tolerances; 14-bit UVs stay within a texel of the 2048 px lightmaps.
  quantize({ quantizePosition: 16, quantizeNormal: 12, quantizeTexcoord: 14, quantizeColor: 8 }),
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

// Textures, by the slot that uses them (a texture shared by colour and emissive is sRGB in both). The full-size
// file goes next to the GLB; the GLB keeps a small ETC1S preview under a unique name (the props all call
// theirs Image_0/Image_1), which is how the web finds the full-size file for each slot.
const textures = doc.getRoot().listTextures();
const slotsOf = t => [...new Set(doc.getGraph().listParentEdges(t).map(e => e.getName()).filter(n => n in CODEC))];
const report = [], full = {};
for (const dir of ['textures', 'lightmaps']) {
  await fs.mkdir(path.join(OUT, dir), { recursive: true });
  for (const old of await fs.readdir(path.join(OUT, dir))) await fs.rm(path.join(OUT, dir, old));
}
await pool(textures, async t => {
  const slots = slotsOf(t);
  if (!slots.length) throw new Error(`texture ${t.getName()} is used by no known slot`);
  if (slots.some(s => CODEC[s].srgb !== CODEC[slots[0]].srgb)) throw new Error(`texture ${t.getName()} is shared by sRGB and linear slots`);
  const codec = CODEC[slots.find(s => s === 'normalTexture') ?? slots[0]];
  const source = t.getImage(), before = source.byteLength;
  const key = `${(t.getName() || 'texture').replace(/[^\w-]+/g, '_')}-${sha(source).slice(0, 8)}`;
  const [image, preview] = await Promise.all([encode(source, codec), encode(await shrink(source, PREVIEW), { ...ETC1S, srgb: codec.srgb })]);
  await fs.writeFile(path.join(OUT, 'textures', `${key}.ktx2`), image);
  full[key] = { file: `${key}.ktx2`, slots, codec: codec.isUASTC ? 'uastc' : 'etc1s', sha256: sha(image), bytes: image.byteLength, previewBytes: preview.byteLength };
  t.setImage(preview).setMimeType('image/ktx2').setName(key);
  report.push([key, slots.join('+'), codec.isUASTC ? 'UASTC' : 'ETC1S', before, image.byteLength, preview.byteLength]);
});
doc.createExtension(KHRTextureBasisu).setRequired(true);
const glb = await io.writeBinary(doc);
await fs.writeFile(path.join(OUT, 'pavilion-t16.glb'), glb);

// Lightmaps: AO is linear grey, GI was sRGB-encoded by the bake.
const jobs = Object.values(lightmapManifest.maps).flatMap(m => [[m.ao, false], [m.gi, true]]);
const maps = {};
await pool(jobs, async ([file, srgb]) => {
  const src = await fs.readFile(path.join(SRC, 'lightmaps', file));
  const [ktx, small] = await Promise.all([encode(src, { ...ETC1S, srgb }), encode(await shrink(src, PREVIEW_LIGHTMAP), { ...ETC1S, srgb })]);
  const name = file.replace(/\.jpg$/, '.ktx2'), previewName = file.replace(/\.jpg$/, '-preview.ktx2');
  await fs.writeFile(path.join(OUT, 'lightmaps', name), ktx);
  await fs.writeFile(path.join(OUT, 'lightmaps', previewName), small);
  maps[file] = { file: name, sourceSHA256: sha(src), sha256: sha(ktx), bytes: ktx.byteLength, preview: { file: previewName, sha256: sha(small), bytes: small.byteLength } };
});

const manifest = {
  source: 'scripts/compress-t16.mjs',
  // The script's own hash: changing a codec or quantisation setting without rerunning fails the tests too.
  inputs: { glbSHA256: sha(sourceBytes), lightmapManifestSHA256: sha(lightmapManifestBytes), scriptSHA256: sha(await fs.readFile(new URL(import.meta.url))) },
  glb: { file: 'pavilion-t16.glb', sha256: sha(glb), bytes: glb.byteLength, sourceBytes: sourceBytes.byteLength },
  codecs: { etc1s: ETC1S, uastc: UASTC, quantize: { position: 16, normal: 12, texcoord: 14 }, preview: { texture: PREVIEW, lightmap: PREVIEW_LIGHTMAP } },
  textures: Object.fromEntries(Object.entries(full).sort(([a], [b]) => a.localeCompare(b))),
  lightmaps: Object.fromEntries(Object.entries(maps).sort(([a], [b]) => a.localeCompare(b))),
};
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
report.sort((a, b) => b[4] - a[4]);
for (const r of report) console.log(r.join('\t'));
const kb = n => Math.round(n / 1024);
const total = (o, f) => kb(Object.values(o).reduce((s, m) => s + f(m), 0));
console.log(`GLB ${kb(sourceBytes.byteLength)} KB -> ${kb(glb.byteLength)} KB with previews; full textures ${Object.keys(full).length} -> ${total(full, m => m.bytes)} KB; lightmaps ${Object.keys(maps).length} -> ${total(maps, m => m.bytes)} KB (previews ${total(maps, m => m.preview.bytes)} KB); ${Math.round((Date.now() - t0) / 1000)} s`);
