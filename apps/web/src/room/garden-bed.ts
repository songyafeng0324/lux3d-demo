import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The flower-and-grass bed that used to be planted around the house (T17 turned it into an
 * official item). Plain merged meshes with vertex colours, so it exports to a portable GLB:
 * scripts/build-furniture.mjs → assets/furniture/garden-bed.glb. Bottom centred on the origin.
 */
export function gardenBed() {
  const leavesCount = 75, flowersCount = 14;
  const leaf = new T.BufferGeometry();
  leaf.setAttribute('position', new T.Float32BufferAttribute([
    -.042, 0, 0, .042, 0, 0, -.027, .24, .048, .027, .24, .048, 0, .52, .22,
  ], 3));
  leaf.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);
  leaf.computeVertexNormals();
  const stem = new T.CylinderGeometry(.011, .014, 1, 5);
  const bulb = new T.SphereGeometry(1, 6, 4);
  const greens = [0x617a4f, 0x496944, 0x7b8b4c, 0x899a5e, 0x597551].map(value => new T.Color(value));
  const blooms = [0xf0d5d3, 0xf0dfaa, 0xe2b3a8, 0xd9c4e4].map(value => new T.Color(value));
  const gold = new T.Color(0xddab53), stemGreen = new T.Color(0x536c3e);

  let seed = 8243;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const scatter = (radius: number) => {
    const angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * radius;
    return [Math.cos(angle) * distance, Math.sin(angle) * distance * .76];
  };
  const pose = new T.Object3D();
  const placed = (base: T.BufferGeometry, color: T.Color) => {
    pose.updateMatrix();
    const geometry = base.clone().applyMatrix4(pose.matrix);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'color'].includes(name)) geometry.deleteAttribute(name);
    return geometry;
  };

  const leaves: T.BufferGeometry[] = [], parts: T.BufferGeometry[] = [];
  for (let blade = 0; blade < leavesCount; blade++) {
    const [x, z] = scatter(.9);
    pose.position.set(x, 0, z);
    pose.rotation.set(0, random() * Math.PI * 2, 0);
    pose.scale.set(.65 + random() * .7, .35 + random() * .8, .55 + random() * .65);
    leaves.push(placed(leaf, greens[Math.floor(random() * greens.length)]));
  }
  for (let flower = 0; flower < flowersCount; flower++) {
    const [x, z] = scatter(.77);
    const height = .23 + random() * .35;
    pose.rotation.set(0, 0, 0);
    pose.position.set(x, height / 2, z); pose.scale.set(1, height, 1);
    parts.push(placed(stem, stemGreen));
    pose.position.set(x, height, z); pose.scale.set(.04, .026, .04);
    parts.push(placed(bulb, gold));
    const bloom = blooms[flower % blooms.length];
    for (let petal = 0; petal < 5; petal++) {
      const angle = petal * Math.PI * 2 / 5;
      pose.position.set(x + Math.sin(angle) * .057, height - .006, z + Math.cos(angle) * .057);
      pose.rotation.set(0, angle, 0);
      pose.scale.set(.038, .018, .056);
      parts.push(placed(bulb, bloom));
    }
  }
  const group = new T.Group();
  group.name = '花草丛';
  const leafMaterial = new T.MeshStandardMaterial({ vertexColors: true, roughness: .8, side: T.DoubleSide });
  const flowerMaterial = new T.MeshStandardMaterial({ vertexColors: true, roughness: .7 });
  group.add(new T.Mesh(mergeGeometries(leaves)!, leafMaterial), new T.Mesh(mergeGeometries(parts)!, flowerMaterial));
  for (const geometry of [leaf, stem, bulb, ...leaves, ...parts]) geometry.dispose();
  return group;
}
