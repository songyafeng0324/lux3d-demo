import * as T from 'three';
import type { ExhibitSlot } from './navigation.js';

/**
 * T16 D3 interior atmosphere, all additive and depth-tested (so walls and columns hide it) but never
 * depth-writing (so it can never block the walking camera or the E-target): the shaft of starlight
 * from the oculus onto the Treasure's dais, drifting dust and spirit motes in the atrium, and a slow
 * rune halo on every occupied plinth. Halos live here, not under the exhibit holders, so the exhibit
 * bounds that T08 checks stay the model's own.
 */
export interface Oculus { x: number; z: number; r: number; y: number }

const additive = { transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false } as const;

function shaft(o: Oculus, floorY: number) {
  const h = o.y - floorY;
  const geometry = new T.CylinderGeometry(o.r * 0.92, o.r * 1.12, h, 48, 1, true);
  geometry.translate(o.x, floorY + h / 2, o.z);
  return new T.Mesh(geometry, new T.ShaderMaterial({
    uniforms: { time: { value: 0 }, y0: { value: floorY }, y1: { value: o.y } },
    vertexShader: /* glsl */`
      varying vec3 vN, vV; varying float vY; varying vec2 vUv;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float time, y0, y1; varying vec3 vN, vV; varying float vY; varying vec2 vUv;
      void main() {
        float edge = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.6);     // brighter where we look through more of the beam
        float t = (vY - y0) / (y1 - y0);
        float fall = smoothstep(0.0, 0.25, t) * (0.35 + 0.65 * t);
        float rays = 0.75 + 0.25 * sin(vUv.x * 62.83 + time * 0.3) * sin(vUv.x * 25.1 - time * 0.17);
        gl_FragColor = vec4(vec3(0.62, 0.74, 1.0) * edge * fall * rays * 0.16, 1.0);
      }`,
    side: T.DoubleSide, ...additive,
  }));
}

function motes(count: number, box: [number, number, number, number, number, number]) {
  const [x0, x1, y0, y1, z0, z1] = box;
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos.set([x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0), z0 + Math.random() * (z1 - z0)], i * 3);
    seed[i] = Math.random();
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(pos, 3));
  geometry.setAttribute('seed', new T.BufferAttribute(seed, 1));
  const points = new T.Points(geometry, new T.ShaderMaterial({
    uniforms: { time: { value: 0 }, y0: { value: y0 }, span: { value: y1 - y0 }, scale: { value: 1 } },
    vertexShader: /* glsl */`
      uniform float time, y0, span, scale; attribute float seed; varying float vSeed, vFade;
      void main() {
        vec3 p = position;
        p.y = y0 + mod(p.y - y0 + time * (0.12 + 0.25 * seed), span);           // rise slowly, wrap at the top
        p.x += sin(time * 0.3 + seed * 40.0) * 0.6; p.z += cos(time * 0.23 + seed * 25.0) * 0.6;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vSeed = seed; vFade = smoothstep(0.0, 0.08, (p.y - y0) / span) * (1.0 - smoothstep(0.85, 1.0, (p.y - y0) / span));
        gl_PointSize = scale * (seed > 0.86 ? 0.16 : 0.06) / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float time; varying float vSeed, vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.0, d);
        vec3 c = vSeed > 0.86 ? mix(vec3(0.45, 0.95, 0.9), vec3(1.0, 0.8, 0.4), fract(vSeed * 7.0)) : vec3(1.0, 0.86, 0.62);
        float tw = 0.6 + 0.4 * sin(time * (1.0 + vSeed * 2.0) + vSeed * 50.0);
        gl_FragColor = vec4(c * core * core * tw * vFade * (vSeed > 0.86 ? 1.6 : 0.55), 1.0);
      }`,
    ...additive,
  }));
  points.frustumCulled = false;
  return points;
}

function haloMaterial() {
  return new T.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */`varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float time; varying vec2 vP;
      void main() {
        float r = length(vP), a = atan(vP.y, vP.x);
        float ring = smoothstep(0.035, 0.0, abs(r - 0.92)) + 0.6 * smoothstep(0.02, 0.0, abs(r - 0.78));
        float runes = step(0.55, fract((a + time * 0.25) * 24.0 / 6.2832)) * smoothstep(0.03, 0.0, abs(r - 0.85));
        float glow = smoothstep(1.0, 0.6, r) * 0.18;
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.42) * (ring * 0.9 + runes * 0.7 + glow) * (0.8 + 0.2 * sin(time * 1.3)), 1.0);
      }`,
    side: T.DoubleSide, ...additive,
  });
}

export class PavilionAtmosphere {
  readonly group = new T.Group();
  private shaft: T.Mesh<T.CylinderGeometry, T.ShaderMaterial>;
  private motes: T.Points<T.BufferGeometry, T.ShaderMaterial>;
  private halos = new T.Group();
  private halo = haloMaterial();
  private haloGeometry = new T.CircleGeometry(1, 64);

  constructor(oculus: Oculus, floorY: number) {
    this.shaft = shaft(oculus, floorY + 1.2);
    this.motes = motes(900, [-10.5, 10.5, 0.4, 26, -11.5, 15.5]);
    this.group.add(this.shaft, this.motes, this.halos);
  }

  /** One halo per occupied plinth, lying a hair above the plinth top, sized to the plinth. */
  setHalos(slots: ExhibitSlot[]) {
    this.halos.clear();
    for (const s of slots) {
      const m = new T.Mesh(this.haloGeometry, this.halo);
      const restY = s.fit?.restY ?? s.position[1] + 0.95;
      m.position.set(s.position[0], restY - 0.13, s.position[2]);
      m.rotation.x = -Math.PI / 2;
      m.scale.setScalar(Math.min(...(s.footprint ?? [1.2, 1.2])) / 2 * 0.95);
      this.halos.add(m);
    }
  }

  update(time: number, pixelHeight: number) {
    this.shaft.material.uniforms.time.value = time;
    this.motes.material.uniforms.time.value = time;
    this.motes.material.uniforms.scale.value = pixelHeight;
    this.halo.uniforms.time.value = time;
  }

  dispose() {
    this.shaft.geometry.dispose(); this.shaft.material.dispose();
    this.motes.geometry.dispose(); this.motes.material.dispose();
    this.haloGeometry.dispose(); this.halo.dispose();
    this.group.clear();
  }
}
