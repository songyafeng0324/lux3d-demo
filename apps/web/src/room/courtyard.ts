import * as T from 'three';
import { FENCE, GROUND_Y, PATH } from './layout.js';
import { slab, textured } from './textures.js';

export const horizonColor = 0x85b2d4;
const courtyardLevel = GROUND_Y;

/** Lawn texture: fine blades over mottled greens. */
function lawnTexture() {
  const size = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#6f8a52';
  context.fillRect(0, 0, size, size);
  let seed = 3169;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const tones = ['#5d7a44', '#7f9a5a', '#6a8649', '#8ca763', '#55703f', '#93a86a'];
  for (let i = 0; i < 5200; i++) {
    const x = random() * size, y = random() * size, length = 2 + random() * 5, lean = (random() - .5) * 2.2;
    context.strokeStyle = tones[Math.floor(random() * tones.length)];
    context.globalAlpha = .45 + random() * .5;
    context.lineWidth = .7 + random() * .8;
    // Draw each blade on every wrap offset so the tile has no seams.
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      context.beginPath(); context.moveTo(x + ox, y + oy); context.lineTo(x + ox + lean, y + oy - length); context.stroke();
    }
  }
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Smooth value noise for large-scale patches on the lawn (vertex colours). */
function patches(x: number, z: number) {
  const hash = (i: number, j: number) => { const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return h - Math.floor(h); };
  const smooth = (px: number, pz: number) => {
    const i = Math.floor(px), j = Math.floor(pz), fx = px - i, fz = pz - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
  };
  return smooth(x / 9, z / 9) * .65 + smooth(x / 3.5 + 7, z / 3.5 + 3) * .35;
}

export function courtyardGround() {
  const group = new T.Group();
  group.name = 'courtyard';

  // One lawn from the house out to the horizon; the fence marks where people may go.
  const size = 320, segments = 160;
  const lawnGeometry = new T.PlaneGeometry(size, size, segments, segments);
  lawnGeometry.rotateX(-Math.PI / 2);
  const position = lawnGeometry.getAttribute('position') as T.BufferAttribute, uv = lawnGeometry.getAttribute('uv') as T.BufferAttribute;
  const colors = new Float32Array(position.count * 3), light = new T.Color(0xe6f0c8), deep = new T.Color(0x9fb487), color = new T.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i);
    color.copy(deep).lerp(light, patches(x, z)).toArray(colors, i * 3);
    uv.setXY(i, x / 2.2, z / 2.2);
  }
  lawnGeometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
  const lawn = new T.Mesh(lawnGeometry, new T.MeshStandardMaterial({ map: lawnTexture(), vertexColors: true, roughness: .97 }));
  lawn.name = 'lawn';
  lawn.position.y = courtyardLevel;
  lawn.receiveShadow = true;
  group.add(lawn);

  // Stone path: running-bond granite slabs between marble curbs, from the porch to the gate.
  const paving = textured('granite', { tint: 0xe6dccb, lift: 2.8, roughness: .8 });
  const curbStone = textured('marble', { tint: 0x9c9a92, roughness: .8 });
  const { halfWidth, curb, z0, z1 } = PATH;
  const slabTop = courtyardLevel + .015, slabDepth = .05;
  let row = 0;
  for (let z = z0 + .02; z < z1 - .3; row++) {
    const length = Math.min(.86 + (row % 3) * .08, z1 - z - .02);
    const split = row % 2 ? [-halfWidth, halfWidth] : [-halfWidth, -.25, halfWidth];
    for (let i = 0; i < split.length - 1; i++) {
      const x0 = split[i] + .015, x1 = split[i + 1] - .015;
      const stone = slab(group, paving, x1 - x0, slabDepth, length, (x0 + x1) / 2, slabTop - slabDepth / 2, z + length / 2);
      stone.name = 'path-slab';
    }
    z += length + .03;
  }
  for (const side of [-1, 1]) {
    slab(group, curbStone, curb, .09, z1 - z0, side * (halfWidth + curb / 2 + .01), courtyardLevel + .03 - .045, (z0 + z1) / 2);
  }

  group.add(fence());
  return group;
}

/** Low picket fence around the 3×3 grounds, with a closed gate where the path meets it. */
function fence() {
  const group = new T.Group();
  group.name = 'fence';
  const wood = textured('darkWood', { tint: 0xc9a582, roughness: .75 });
  const { x: fx, z: fz, height, post, gate } = FENCE;
  const runs: { from: [number, number]; to: [number, number] }[] = [
    { from: [-fx, -fz], to: [fx, -fz] }, { from: [fx, -fz], to: [fx, fz] },
    { from: [-fx, fz], to: [-gate, fz] }, { from: [gate, fz], to: [fx, fz] }, { from: [-fx, -fz], to: [-fx, fz] },
  ];
  const posts: [number, number][] = [], rails: { at: [number, number]; length: number; angle: number }[] = [], pickets: [number, number, number][] = [];
  for (const { from, to } of runs) {
    const dx = to[0] - from[0], dz = to[1] - from[1], length = Math.hypot(dx, dz), bays = Math.ceil(length / 2.4), angle = Math.atan2(dx, dz);
    for (let i = 0; i <= bays; i++) posts.push([from[0] + dx * i / bays, from[1] + dz * i / bays]);
    for (let i = 0; i < bays; i++) {
      const a = i / bays, b = (i + 1) / bays, bay = length / bays;
      rails.push({ at: [from[0] + dx * (a + b) / 2, from[1] + dz * (a + b) / 2], length: bay - post, angle });
      const count = Math.floor((bay - post) / .17);
      for (let k = 1; k < count; k++) {
        const t = a + (b - a) * (k / count);
        pickets.push([from[0] + dx * t, from[1] + dz * t, angle]);
      }
    }
  }
  const unique = [...new Map(posts.map(p => [p.map(v => v.toFixed(3)).join(','), p])).values()];
  const pose = new T.Object3D();
  const postMesh = new T.InstancedMesh(worldPost(post, height), wood, unique.length);
  unique.forEach(([x, z], i) => { pose.position.set(x, courtyardLevel, z); pose.rotation.set(0, 0, 0); pose.updateMatrix(); postMesh.setMatrixAt(i, pose.matrix); });
  const railGeometry = new T.BoxGeometry(.05, .08, 1);
  const railMesh = new T.InstancedMesh(railGeometry, wood, rails.length * 2);
  rails.forEach(({ at, length, angle }, i) => {
    for (const [k, y] of [[0, .3], [1, .78]] as const) {
      pose.position.set(at[0], courtyardLevel + y, at[1]); pose.rotation.set(0, angle, 0); pose.scale.set(1, 1, length); pose.updateMatrix();
      railMesh.setMatrixAt(i * 2 + k, pose.matrix);
    }
  });
  pose.scale.set(1, 1, 1);
  const picketShape = new T.Shape();
  picketShape.moveTo(-.035, 0); picketShape.lineTo(.035, 0); picketShape.lineTo(.035, height - .2); picketShape.lineTo(0, height - .1); picketShape.lineTo(-.035, height - .2); picketShape.closePath();
  const picketGeometry = new T.ExtrudeGeometry(picketShape, { depth: .022, bevelEnabled: false });
  picketGeometry.translate(0, 0, .025); // against the rail face
  picketGeometry.rotateY(Math.PI / 2);
  const picketMesh = new T.InstancedMesh(picketGeometry, wood, pickets.length);
  pickets.forEach(([x, z, angle], i) => { pose.position.set(x, courtyardLevel, z); pose.rotation.set(0, angle, 0); pose.updateMatrix(); picketMesh.setMatrixAt(i, pose.matrix); });
  for (const mesh of [postMesh, railMesh, picketMesh]) { mesh.castShadow = mesh.receiveShadow = true; group.add(mesh); }

  // Gate: two taller posts, a lintel and a pair of closed plank leaves.
  const gateHeight = 1.75;
  for (const side of [-1, 1]) {
    slab(group, wood, .2, gateHeight, .2, side * gate, courtyardLevel + gateHeight / 2, fz);
    const cap = slab(group, wood, .28, .06, .28, side * gate, courtyardLevel + gateHeight + .03, fz);
    cap.name = 'gate-cap';
    const leaf = gate - .1 - .01;
    slab(group, wood, leaf, height - .05, .05, side * (leaf / 2 + .005), courtyardLevel + .08 + (height - .05) / 2, fz);
    const brace = slab(group, wood, Math.hypot(leaf - .1, height - .35), .06, .03, side * (leaf / 2 + .005), courtyardLevel + .08 + (height - .05) / 2, fz - .04);
    brace.rotation.z = side * Math.atan2(height - .35, leaf - .1);
  }
  slab(group, wood, 2 * gate + .3, .14, .16, 0, courtyardLevel + gateHeight - .2, fz);
  return group;
}

/** Fence post with a pyramid cap, bottom at the origin. */
function worldPost(size: number, height: number) {
  const shaft = new T.BoxGeometry(size, height, size).translate(0, height / 2, 0);
  const cap = new T.ConeGeometry(size * .75, .1, 4).rotateY(Math.PI / 4).translate(0, height + .05, 0);
  shaft.deleteAttribute('uv'); cap.deleteAttribute('uv');
  const geometry = new T.BufferGeometry();
  const merged = [shaft.toNonIndexed(), cap.toNonIndexed()];
  const positions = merged.flatMap(g => [...(g.getAttribute('position').array as Float32Array)]);
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const uv = new Float32Array(positions.length / 3 * 2);
  for (let i = 0; i < positions.length / 3; i++) { uv[i * 2] = positions[i * 3] + positions[i * 3 + 2]; uv[i * 2 + 1] = positions[i * 3 + 1]; }
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  for (const g of [shaft, cap, ...merged]) g.dispose();
  return geometry;
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
