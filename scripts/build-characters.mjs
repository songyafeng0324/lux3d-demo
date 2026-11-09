// T15: build the runtime copies of the six delivered character GLBs.
// Keeps only referenced buffer data and re-encodes the (OPAQUE-material) textures as 1024px JPEG.
// Mesh, skin and animation data are copied byte for byte. Usage: npm run build:characters
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const sharp = createRequire(path.resolve('packages/domain/package.json'))('sharp');
const SRC = path.resolve('assets/characters');
const OUT = path.join(SRC, 'runtime');
const TEXTURE = 1024;
export const CHARACTERS = [
  ['shin-chan', '蜡笔小新'], ['humanoid-tabby', '拟人橘猫'], ['maruko-tpose', '红衣小丸子'],
  ['bull-tpose', '黄衣牛角人'], ['white-shirt-boy', '白衣男孩'], ['pink-shorts-girl', '粉裤女孩'],
];

function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  return { json, bin: buffer.subarray(binStart, binStart + buffer.readUInt32LE(20 + jsonLength)) };
}

function writeGlb(json, bin) {
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - b.length % 4) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20), binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHead = (length, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, chunkHead(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHead(binChunk.length, 0x004e4942), binChunk]);
}

async function repack(buffer) {
  const { json, bin } = readGlb(buffer);
  if (json.materials?.some(m => (m.alphaMode ?? 'OPAQUE') !== 'OPAQUE')) throw new Error('JPEG textures need OPAQUE materials');
  const imageViews = new Map((json.images ?? []).map((image, i) => [image.bufferView, i]));
  const used = [...new Set([
    ...json.accessors.flatMap(a => [a.bufferView, a.sparse?.indices.bufferView, a.sparse?.values.bufferView]),
    ...imageViews.keys(),
  ].filter(v => v !== undefined))].sort((a, b) => a - b);
  const remap = new Map(), views = [], parts = [];
  let offset = 0;
  for (const index of used) {
    const view = json.bufferViews[index];
    let data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    if (imageViews.has(index)) {
      data = await sharp(data).resize(TEXTURE, TEXTURE, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#000' })
        .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
      json.images[imageViews.get(index)].mimeType = 'image/jpeg';
    }
    const padding = (4 - offset % 4) % 4;
    if (padding) { parts.push(Buffer.alloc(padding)); offset += padding; }
    remap.set(index, views.length);
    views.push({ ...view, buffer: 0, byteOffset: offset, byteLength: data.length });
    parts.push(data); offset += data.length;
  }
  json.bufferViews = views;
  for (const a of json.accessors) {
    if (a.bufferView !== undefined) a.bufferView = remap.get(a.bufferView);
    if (a.sparse) { a.sparse.indices.bufferView = remap.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = remap.get(a.sparse.values.bufferView); }
  }
  for (const image of json.images ?? []) image.bufferView = remap.get(image.bufferView);
  json.buffers = [{ byteLength: offset }];
  json.asset = { ...json.asset, generator: `${json.asset?.generator ?? 'unknown'} + aholo build-characters` };
  return writeGlb(json, Buffer.concat(parts));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fs.mkdir(OUT, { recursive: true });
  const items = [];
  for (const [id, label] of CHARACTERS) {
    const source = await fs.readFile(path.join(SRC, id, `${id}.glb`));
    const out = await repack(source);
    readGlb(out); // structural self-check
    await fs.writeFile(path.join(OUT, `${id}.glb`), out);
    items.push({ id, label, file: `${id}.glb`, byteSize: out.length, sha256: createHash('sha256').update(out).digest('hex'),
      source: `${id}/${id}.glb`, sourceSha256: createHash('sha256').update(source).digest('hex'), sourceByteSize: source.length });
  }
  await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({
    version: 1, source: 'scripts/build-characters.mjs', textures: `${TEXTURE}px JPEG q88, unreferenced buffer data dropped`,
    animations: ['Idle', 'Run'], items,
  }, null, 2) + '\n');
  console.log(items.map(i => `${i.id} ${(i.sourceByteSize / 1e6).toFixed(1)}MB → ${(i.byteSize / 1e6).toFixed(1)}MB`).join('\n'));
}
