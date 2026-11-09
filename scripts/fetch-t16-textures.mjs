// T16 D2: download the Poly Haven (CC0) base materials used by scripts/blender/build_t16.py.
// Run from the repo root: node scripts/fetch-t16-textures.mjs   (idempotent; verifies md5)
// Writes assets/t16/textures/polyhaven/<id>/<id>_{diff,nor_gl,rough}_1k.jpg and a manifest with
// the real-world size of each texture (used for UV tiling) and the authors.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ROOT = new URL('../assets/t16/textures/polyhaven/', import.meta.url);
const UA = { 'User-Agent': 'aholo-lux3d-build' };
// id -> what it dresses in the pavilion
const SETS = {
  lacquered_cherry_wood: 'columns, beams, rails, frames (dark lacquer)',
  dark_wood: 'wall panels, doors, alcove frames',
  dark_wooden_planks: 'upper floor boards, ceilings',
  granite_tile: 'ground floor polished dark stone',
  marble_01: 'terrace, stairs, pedestals, lions (white marble)',
  grey_roof_tiles: 'roofs, eaves, alcove canopies',
};
const MAPS = ['Diffuse', 'nor_gl', 'Rough'];

const json = async url => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
const md5 = b => createHash('md5').update(b).digest('hex');

const manifest = { source: 'https://polyhaven.com', license: 'CC0 1.0', resolution: '1k', sets: {} };
for (const [id, use] of Object.entries(SETS)) {
  const [files, info] = await Promise.all([json(`https://api.polyhaven.com/files/${id}`), json(`https://api.polyhaven.com/info/${id}`)]);
  const dir = new URL(`${id}/`, ROOT); await mkdir(dir, { recursive: true });
  const maps = {};
  for (const m of MAPS) {
    const f = files[m]['1k'].jpg, name = f.url.split('/').pop(), path = new URL(name, dir);
    if (!existsSync(path) || md5(await readFile(path)) !== f.md5) {
      const r = await fetch(f.url, { headers: UA }); if (!r.ok) throw new Error(`${f.url}: HTTP ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      if (md5(bytes) !== f.md5) throw new Error(`${name}: md5 mismatch`);
      await writeFile(path, bytes);
      console.log(`downloaded ${id}/${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
    }
    maps[m] = name;
  }
  manifest.sets[id] = { use, sizeMetres: info.dimensions.map(v => +(v / 1000).toFixed(3)), authors: Object.keys(info.authors ?? {}), maps };
}
await writeFile(new URL('manifest.json', ROOT), JSON.stringify(manifest, null, 1) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(manifest.sets).map(([k, v]) => [k, v.sizeMetres]))));
