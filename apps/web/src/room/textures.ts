import * as T from 'three';
// CC0 sets shared with the T16 pavilion (assets/t16/textures/polyhaven, sizes in its manifest).
import cherryDiff from '../../../../assets/t16/textures/polyhaven/lacquered_cherry_wood/lacquered_cherry_wood_diff_1k.jpg?url';
import cherryNor from '../../../../assets/t16/textures/polyhaven/lacquered_cherry_wood/lacquered_cherry_wood_nor_gl_1k.jpg?url';
import darkWoodDiff from '../../../../assets/t16/textures/polyhaven/dark_wood/dark_wood_diff_1k.jpg?url';
import darkWoodNor from '../../../../assets/t16/textures/polyhaven/dark_wood/dark_wood_nor_gl_1k.jpg?url';
import graniteDiff from '../../../../assets/t16/textures/polyhaven/granite_tile/granite_tile_diff_1k.jpg?url';
import graniteNor from '../../../../assets/t16/textures/polyhaven/granite_tile/granite_tile_nor_gl_1k.jpg?url';
import roofDiff from '../../../../assets/t16/textures/polyhaven/grey_roof_tiles/grey_roof_tiles_diff_1k.jpg?url';
import roofNor from '../../../../assets/t16/textures/polyhaven/grey_roof_tiles/grey_roof_tiles_nor_gl_1k.jpg?url';
import marbleDiff from '../../../../assets/t16/textures/polyhaven/marble_01/marble_01_diff_1k.jpg?url';
import marbleNor from '../../../../assets/t16/textures/polyhaven/marble_01/marble_01_nor_gl_1k.jpg?url';
import planksDiff from '../../../../assets/t16/textures/polyhaven/dark_wooden_planks/dark_wooden_planks_diff_1k.jpg?url';
import planksNor from '../../../../assets/t16/textures/polyhaven/dark_wooden_planks/dark_wooden_planks_nor_gl_1k.jpg?url';

const SETS = {
  cherry: { diff: cherryDiff, nor: cherryNor, size: 1 },
  darkWood: { diff: darkWoodDiff, nor: darkWoodNor, size: 2 },
  granite: { diff: graniteDiff, nor: graniteNor, size: 2.3 },
  roof: { diff: roofDiff, nor: roofNor, size: 3 },
  marble: { diff: marbleDiff, nor: marbleNor, size: 1.5 },
  planks: { diff: planksDiff, nor: planksNor, size: 2 },
} as const;
export type TextureSet = keyof typeof SETS;

const loader = new T.TextureLoader();
// One image per file and one texture per repeat/rotation; materials share them.
const sources = new Map<string, { image?: TexImageSource; waiting: T.Texture[] }>();
const textures = new Map<string, T.Texture>();
function map(url: string, colour: boolean, size: number, rotation: number) {
  const key = `${url}|${size}|${rotation}`;
  const cached = textures.get(key);
  if (cached) return cached;
  let source = sources.get(url);
  if (!source) {
    const entry: { image?: TexImageSource; waiting: T.Texture[] } = { waiting: [] };
    source = entry;
    sources.set(url, entry);
    loader.load(url, loaded => {
      entry.image = loaded.image as TexImageSource;
      for (const texture of entry.waiting) { texture.image = entry.image; texture.needsUpdate = true; }
      entry.waiting = [];
    });
  }
  const texture = new T.Texture();
  if (source.image) { texture.image = source.image; texture.needsUpdate = true; } else source.waiting.push(texture);
  texture.colorSpace = colour ? T.SRGBColorSpace : T.NoColorSpace;
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.anisotropy = 4;
  // Geometry UVs are in metres (worldBox, worldCylinder), so one repeat covers the set's real size.
  texture.repeat.set(1 / size, 1 / size);
  texture.rotation = rotation;
  textures.set(key, texture);
  return texture;
}

/** A material from one CC0 set. tint (× lift) multiplies the photo colour; rotate turns the pattern 90°. */
export function textured(set: TextureSet, { tint = 0xffffff, lift = 1, roughness = .8, normal = 1, rotate = false, scale = 1 } = {}) {
  const { diff, nor, size } = SETS[set];
  const rotation = rotate ? Math.PI / 2 : 0;
  const material = new T.MeshStandardMaterial({
    // lift > 1 brightens a dark photo set (e.g. the polished granite) for a lighter stone.
    color: new T.Color(tint).multiplyScalar(lift), roughness,
    map: map(diff, true, size * scale, rotation),
    normalMap: map(nor, false, size * scale, rotation),
  });
  material.normalScale.setScalar(normal);
  return material;
}

/** BoxGeometry whose UVs are in metres on every face. */
export function worldBox(w: number, h: number, d: number) {
  const geometry = new T.BoxGeometry(w, h, d);
  const uv = geometry.getAttribute('uv') as T.BufferAttribute;
  const faces: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let face = 0; face < 6; face++) for (let v = 0; v < 4; v++) {
    const i = face * 4 + v;
    uv.setXY(i, uv.getX(i) * faces[face][0], uv.getY(i) * faces[face][1]);
  }
  return geometry;
}

/** CylinderGeometry with UVs in metres (around × along). */
export function worldCylinder(top: number, bottom: number, height: number, segments = 16) {
  const geometry = new T.CylinderGeometry(top, bottom, height, segments);
  const uv = geometry.getAttribute('uv') as T.BufferAttribute;
  const around = Math.PI * (top + bottom);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * height);
  return geometry;
}

/** Add a metre-UV box with its centre at (x, y, z). */
export function slab(parent: T.Object3D, material: T.Material | T.Material[], w: number, h: number, d: number, x: number, y: number, z: number) {
  const mesh = new T.Mesh(worldBox(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
