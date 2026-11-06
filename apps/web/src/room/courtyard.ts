import * as T from 'three';
import { box, material } from '../scene/assets.js';

export const horizonColor = 0x85b2d4;
const courtyardLevel = -.4;

export function courtyardGround() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(canvas.width, canvas.height);
  let seed = 3169;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const grain = 164 + (seed >>> 25 & 63);
    pixels.data.set([grain, grain, grain, 255], i);
  }
  context.putImageData(pixels, 0, 0);
  const grain = new T.CanvasTexture(canvas);
  grain.colorSpace = T.SRGBColorSpace;
  grain.wrapS = grain.wrapT = T.RepeatWrapping;
  grain.repeat.set(24, 20);
  const turf = grain.clone();
  turf.repeat.set(105, 105);

  const group = new T.Group();
  const terrain = [
    { size: [180, 180], height: courtyardLevel - .012, color: 0x62734f, map: turf, name: 'outer-meadow' },
    { size: [22, 18], height: courtyardLevel, color: 0x98846c, map: grain, name: 'courtyard-gravel' },
  ];
  for (const { size, height, color, map, name } of terrain) {
    const surface = material(color, .98);
    surface.map = map;
    const plane = new T.Mesh(new T.PlaneGeometry(size[0], size[1]), surface);
    plane.name = name;
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = height;
    plane.receiveShadow = true;
    group.add(plane);
  }
  const pathStone = material(0x77756c, .92);
  for (let z = 5.4; z <= 9.4; z += .92) {
    const stone = box(group, 2.05, .045, .82, 0, courtyardLevel + .016, z, pathStone);
    stone.castShadow = true;
  }
  return group;
}

export function courtyardSky() {
  const sky = new T.Mesh(new T.SphereGeometry(120, 24, 12), new T.ShaderMaterial({
    side: T.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      zenith: { value: new T.Color(0x3d87ce) },
      horizon: { value: new T.Color(horizonColor) },
      cloudColor: { value: new T.Color(0xf7f7ef) },
      cloudShade: { value: new T.Color(0xb0c9de) },
    },
    vertexShader: `
      varying vec3 skyDirection;
      void main() {
        skyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: `
      uniform vec3 zenith, horizon, cloudColor, cloudShade;
      varying vec3 skyDirection;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float noise(vec2 p) {
        vec2 cell = floor(p);
        vec2 f = fract(p);
        vec2 blend = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(cell), hash(cell + vec2(1, 0)), blend.x),
          mix(hash(cell + vec2(0, 1)), hash(cell + vec2(1, 1)), blend.x), blend.y);
      }

      void main() {
        vec3 direction = normalize(skyDirection);
        float height = max(direction.y, 0.0);
        vec3 sky = mix(horizon, zenith, 0.13 + smoothstep(0.0, 0.46, height) * 0.87);
        vec2 cloudPlane = direction.xz / (height + 0.36) * vec2(2.25, 4.4) + vec2(3.7, 4.2);
        float body = noise(cloudPlane) * 0.57 + noise(cloudPlane * 2.1) * 0.27
          + noise(cloudPlane * 4.3) * 0.11 + noise(cloudPlane * 8.5) * 0.05;
        float cloud = smoothstep(0.45, 0.64, body) * smoothstep(0.0, 0.10, height);
        vec3 cloudLight = mix(cloudShade, cloudColor, smoothstep(0.44, 0.68, body));
        gl_FragColor = vec4(mix(sky, cloudLight, cloud), 1.0);
        #include <colorspace_fragment>
      }
    `,
  }));
  sky.renderOrder = 10;
  sky.name = 'courtyard-sky';
  return sky;
}

export function courtyardPlants() {
  // Beds flank the house and leave the approach in front of the door open.
  const beds = [
    [-7.2, 3.9], [-7.6, .6], [-7.0, -2.9], [-5.8, -5.6], [-2.8, -5.9],
    [2.7, -5.9], [5.8, -5.5], [7.3, -3.0], [7.7, .6], [7.2, 4.0],
    [-5.2, 6.1], [-3.6, 6.7], [3.8, 6.8], [5.5, 6.1],
  ];
  const leavesPerBed = 75;
  const flowersPerBed = 14;
  const leaf = new T.BufferGeometry();
  leaf.setAttribute('position', new T.Float32BufferAttribute([
    -.042, 0, 0, .042, 0, 0, -.027, .24, .048, .027, .24, .048, 0, .52, .22,
  ], 3));
  leaf.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);
  leaf.computeVertexNormals();

  const leafMaterial = material(0xffffff);
  leafMaterial.side = T.DoubleSide;
  const grass = new T.InstancedMesh(leaf, leafMaterial, beds.length * leavesPerBed);
  const stems = new T.InstancedMesh(new T.CylinderGeometry(.011, .014, 1, 5), material(0x536c3e), beds.length * flowersPerBed);
  const petals = new T.InstancedMesh(new T.SphereGeometry(1, 6, 4), material(0xffffff), beds.length * flowersPerBed * 5);
  const centers = new T.InstancedMesh(new T.SphereGeometry(1, 6, 4), material(0xddab53), beds.length * flowersPerBed);
  const greens = [0x617a4f, 0x496944, 0x7b8b4c, 0x899a5e, 0x597551].map(value => new T.Color(value));
  const blooms = [0xf0d5d3, 0xf0dfaa, 0xe2b3a8, 0xd9c4e4].map(value => new T.Color(value));

  let seed = 8243;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pose = new T.Object3D();
  const scatter = (x: number, z: number, radius: number) => {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * radius;
    return [x + Math.cos(angle) * distance, z + Math.sin(angle) * distance * .76];
  };
  for (const [bedIndex, [x, z]] of beds.entries()) {
    for (let blade = 0; blade < leavesPerBed; blade++) {
      const [px, pz] = scatter(x, z, .9);
      const index = bedIndex * leavesPerBed + blade;
      pose.position.set(px, courtyardLevel + .01, pz);
      pose.rotation.set(0, random() * Math.PI * 2, 0);
      pose.scale.set(.65 + random() * .7, .35 + random() * .8, .55 + random() * .65);
      pose.updateMatrix();
      grass.setMatrixAt(index, pose.matrix);
      grass.setColorAt(index, greens[Math.floor(random() * greens.length)]);
    }
    for (let flower = 0; flower < flowersPerBed; flower++) {
      const index = bedIndex * flowersPerBed + flower;
      const [px, pz] = scatter(x, z, .77);
      const height = .23 + random() * .35;
      const flowerTop = courtyardLevel + height;
      pose.rotation.set(0, 0, 0);
      pose.position.set(px, courtyardLevel + height / 2, pz);
      pose.scale.set(1, height, 1);
      pose.updateMatrix();
      stems.setMatrixAt(index, pose.matrix);
      pose.position.y = flowerTop;
      pose.scale.set(.04, .026, .04);
      pose.updateMatrix();
      centers.setMatrixAt(index, pose.matrix);
      for (let petal = 0; petal < 5; petal++) {
        const angle = petal * Math.PI * 2 / 5;
        pose.position.set(px + Math.sin(angle) * .057, flowerTop - .006, pz + Math.cos(angle) * .057);
        pose.rotation.y = angle;
        pose.scale.set(.038, .018, .056);
        pose.updateMatrix();
        const petalIndex = index * 5 + petal;
        petals.setMatrixAt(petalIndex, pose.matrix);
        petals.setColorAt(petalIndex, blooms[bedIndex % blooms.length]);
      }
    }
  }
  const garden = new T.Group();
  garden.name = 'courtyard-flowers-and-grasses';
  grass.castShadow = true;
  grass.receiveShadow = true;
  stems.receiveShadow = petals.receiveShadow = centers.receiveShadow = true;
  garden.add(grass, stems, petals, centers);
  return garden;
}
