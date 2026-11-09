import * as T from 'three';
import mountainsUrl from '../../../../assets/t16/sky/mountains.png?url';
import islesUrl from '../../../../assets/t16/sky/isles.png?url';

/**
 * T16 D3 backdrop (concept 06 + 02): a dusk-into-starlight dome with the Milky Way, a sea of cloud
 * the pavilion floats on, the user's misty mountains (A11) on the horizon and floating isles (A12).
 * Everything here is unlit, ignores fog and never writes depth, so it can only ever sit behind the
 * building; the dome and the cloud sea follow the camera, so they read as infinitely far.
 */
const SUN = new T.Vector3(-0.45, 0, 0.89).normalize();     // dusk glow low in the south-south-west (seen through the door)
const HORIZON = new T.Color(0.62, 0.38, 0.42), CLOUD_FAR = new T.Color(0.46, 0.36, 0.5);

const NOISE = /* glsl */`
  float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * noise3(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`;

function domeMaterial() {
  return new T.ShaderMaterial({
    uniforms: { time: { value: 0 }, sun: { value: SUN }, horizon: { value: HORIZON }, cloudFar: { value: CLOUD_FAR } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */`
      uniform float time; uniform vec3 sun, horizon, cloudFar; varying vec3 vDir;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(horizon, vec3(0.13, 0.12, 0.33), smoothstep(-0.02, 0.28, h));
        col = mix(col, vec3(0.018, 0.024, 0.075), smoothstep(0.22, 0.85, h));
        vec2 flat2 = normalize(d.xz + 1e-5);
        float glow = pow(max(dot(flat2, sun.xz), 0.0), 4.0) * (1.0 - smoothstep(-0.05, 0.42, h));
        col += vec3(1.0, 0.5, 0.22) * glow * 0.9;
        // Milky Way: a soft band round a tilted great circle, with dust lanes.
        vec3 n = normalize(vec3(0.35, 0.42, 0.84));
        float band = exp(-pow(dot(d, n) / 0.16, 2.0)), dust = fbm(d * 7.0);
        float night = smoothstep(0.08, 0.5, h);
        col += vec3(0.32, 0.36, 0.62) * band * smoothstep(0.35, 0.8, dust) * 0.32 * night;
        // Stars: one candidate per 3D cell on the unit sphere (no pole pinching straight up the oculus).
        for (int L = 0; L < 2; L++) {
          float k = L == 0 ? 160.0 : 330.0;
          vec3 c = floor(d * k), f = fract(d * k) - 0.5; float r = hash3(c + float(L) * 31.0);
          float density = 0.986 - 0.012 * band;
          float star = step(density, r) * smoothstep(0.32, 0.0, length(f));
          float tw = 0.65 + 0.35 * sin(time * (1.5 + r * 3.0) + r * 60.0);
          col += mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.66), fract(r * 13.0)) * star * tw * night * (L == 0 ? 2.2 : 1.0);
        }
        col = mix(cloudFar, col, smoothstep(-0.06, 0.0, h));            // below the horizon: the far cloud sea
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: T.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
}

function cloudMaterial(height: number, scale: number, speed: number, opacity: number) {
  return new T.ShaderMaterial({
    uniforms: { time: { value: 0 }, sun: { value: SUN }, cloudFar: { value: CLOUD_FAR } },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float time; uniform vec3 sun, cloudFar; varying vec3 vWorld;
      ${NOISE}
      void main() {
        vec3 p = vec3(vWorld.xz * ${scale.toFixed(4)}, 0.0) + vec3(time * ${speed.toFixed(4)}, time * ${(speed * 0.4).toFixed(4)}, time * 0.01);
        float dens = fbm(p), billow = fbm(p * 2.7 + 5.0);
        vec3 shade = vec3(0.24, 0.2, 0.36), lit = vec3(1.0, 0.78, 0.72);
        vec2 toSun = normalize(vWorld.xz - cameraPosition.xz + 1e-4);
        float rim = 0.35 + 0.65 * pow(max(dot(toSun, sun.xz), 0.0), 2.0);
        vec3 col = mix(shade, lit, smoothstep(0.3, 0.85, billow) * rim);
        float dist = length(vWorld.xz - cameraPosition.xz);
        col = mix(col, cloudFar, smoothstep(120.0, 900.0, dist));
        float a = smoothstep(0.32, 0.62, dens) * ${opacity.toFixed(3)};
        a = mix(a, 1.0, smoothstep(300.0, 900.0, dist) * ${height < -3 ? '1.0' : '0.0'});
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true, depthWrite: false, fog: false, side: T.DoubleSide,
  });
}

/** A billboard turned to face the pavilion's centre about Y; `uv` picks a cell of an atlas. */
function card(texture: T.Texture, width: number, aspect: number, tint: T.Color, uv: [number, number, number, number] = [0, 0, 1, 1]) {
  const geometry = new T.PlaneGeometry(width, width * aspect);
  geometry.translate(0, width * aspect / 2, 0);
  const a = geometry.attributes.uv as T.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * uv[2], uv[1] + a.getY(i) * uv[3]);
  const material = new T.MeshBasicMaterial({ map: texture, color: tint, transparent: true, depthWrite: false, fog: false, side: T.DoubleSide });
  return new T.Mesh(geometry, material);
}

export class PavilionSky {
  readonly group = new T.Group();
  private dome: T.Mesh<T.SphereGeometry, T.ShaderMaterial>;
  private clouds: T.Mesh<T.PlaneGeometry, T.ShaderMaterial>[] = [];
  private isles: { mesh: T.Mesh; y: number; phase: number }[] = [];
  private textures: T.Texture[] = [];

  constructor() {
    this.dome = new T.Mesh(new T.SphereGeometry(900, 48, 24), domeMaterial());
    this.dome.renderOrder = -10; this.dome.frustumCulled = false;
    this.group.add(this.dome);
    // Two layers: the dense sea below the podium, and wisps that drift past the terrace edge. They are
    // drawn before the mountains and isles (which carry no depth), so nothing far shows through them wrongly.
    for (const [y, scale, speed, opacity] of [[-5.5, 0.012, 0.02, 0.97], [-2.2, 0.02, 0.05, 0.45]] as const) {
      const mesh = new T.Mesh(new T.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), cloudMaterial(y, scale, speed, opacity));
      mesh.position.y = y; mesh.frustumCulled = false; mesh.renderOrder = -6;
      this.clouds.push(mesh); this.group.add(mesh);
    }
    const loader = new T.TextureLoader();
    const tex = (url: string) => { const t = loader.load(url); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; this.textures.push(t); return t; };
    const mountains = tex(mountainsUrl), isles = tex(islesUrl);
    // Mountains ring the horizon, nearer ones a little clearer; their misty feet sit at the cloud sea.
    const peaks: [number, number, number, number][] = [   // azimuth (deg, 0 = north), radius, width, haze
      [-10, 430, 300, 0.55], [35, 360, 230, 0.4], [80, 470, 330, 0.6], [125, 380, 250, 0.45],
      [205, 420, 280, 0.5], [250, 350, 220, 0.35], [295, 460, 320, 0.6], [160, 520, 360, 0.7],
    ];
    for (const [az, r, w, haze] of peaks) {
      const m = card(mountains, w, 683 / 1024, new T.Color(1, 1, 1).lerp(new T.Color(0.62, 0.52, 0.7), haze));
      const a = T.MathUtils.degToRad(az);
      m.position.set(Math.sin(a) * r, -6 - 0.18 * w * 683 / 1024, -Math.cos(a) * r);
      m.lookAt(0, m.position.y, 0);
      if (Math.round(az / 45) % 2) m.scale.x = -1;
      m.renderOrder = -5;
      this.group.add(m);
    }
    // Floating isles from the 2×2 atlas: around the pavilion and in the sky framed by the door.
    const cells: [number, number, number, number][] = [[0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5]];
    const spots: [number, number, number, number, number][] = [   // cell, azimuth, radius, height, width
      [0, 168, 120, 22, 34], [1, 196, 95, 34, 18], [2, 145, 150, 12, 22], [3, 222, 170, 28, 30],
      [1, 60, 140, 30, 20], [3, 300, 130, 18, 26], [0, 20, 190, 40, 30], [2, 105, 110, 44, 16],
    ];
    for (const [cell, az, r, y, w] of spots) {
      const m = card(isles, w, 1, new T.Color(0.95, 0.88, 0.92), cells[cell]);
      const a = T.MathUtils.degToRad(az);
      m.position.set(Math.sin(a) * r, y, -Math.cos(a) * r);
      m.lookAt(0, y, 0); m.renderOrder = -4;
      this.isles.push({ mesh: m, y, phase: az });
      this.group.add(m);
    }
  }

  update(time: number, camera: T.Camera) {
    this.dome.position.copy(camera.position);
    this.dome.material.uniforms.time.value = time;
    for (const c of this.clouds) { c.position.x = camera.position.x; c.position.z = camera.position.z; c.material.uniforms.time.value = time; }
    for (const i of this.isles) i.mesh.position.y = i.y + Math.sin(time * 0.25 + i.phase) * 0.8;
  }

  dispose() {
    this.group.traverse(o => { const m = o as T.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as T.Material).dispose(); } });
    this.textures.forEach(t => t.dispose());
    this.group.clear();
  }
}
