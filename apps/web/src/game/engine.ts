import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
// The runtime copy (scripts/compress-t16.mjs): instanced props, meshopt geometry, KTX2 textures.
import pavilionUrl from '../../../../assets/t16/runtime/pavilion-t16.glb?url';
import runtime from '../../../../assets/t16/runtime/manifest.json';
import layout from '../../../../assets/t16/pavilion-layout.json';
import lightmaps from '../../../../assets/t16/pavilion-lightmaps.json';
import { buildNavWorld, pavilionCamera, stepFirstPerson, supportAt, targetSlot, floorOf, exhibitCollider, freePlayer, EXHIBIT_COLLIDER, BODY, MOVE_KEYS, type ExhibitSlot, type FirstPerson, type NavWorld, type PavilionLayout } from './navigation.js';
import { AvatarRig } from './avatar.js';
import type { AvatarPrefs, ViewMode } from './avatar-prefs.js';
import { boomLength, clampFollowPitch, easeBoom, FOLLOW, viewDirection, type Vec3 } from './follow-camera.js';
import { exhibitFit, slotMarker, EXHIBIT_FIT, type GallerySlot, type RoomModel } from '@aholo/contracts';
import { disposeResources } from '../scene/assets.js';
import { PavilionSky } from './sky.js';
import { PavilionAtmosphere, type Oculus } from './atmosphere.js';

export interface HudState { floor: ReturnType<typeof floorOf>; target: ExhibitSlot | null; fps: number; calls: number }
export interface EngineHooks {
  progress(ratio: number): void;
  ready(): void;
  failed(message: string): void;
  hud(state: HudState): void;
  /** Pointer lock was lost while movement was enabled (user pressed Esc / switched tab). */
  lockLost(): void;
  /** The chosen character could not be loaded; the engine has fallen back to first person. */
  avatarFailed?(message: string): void;
}
interface LightMarker { role: string; position: [number, number, number]; color: [number, number, number]; power: number }
const LAYOUT = layout as unknown as PavilionLayout & { lights: LightMarker[]; oculus: Oculus };

export const ENTRY_YAW = LAYOUT.entryYaw;
/** Feet follow each 0.18 m tread exactly; what the eye and the avatar show glides over them. */
const STEP_GLIDE = 14;
/**
 * Selective bloom: only light sources glow. A brightness threshold cannot tell a lamp from a wall or
 * a polished floor standing next to a point light (both exceed it), so the bloom is fed by a separate,
 * half-resolution render in which everything except these materials is black (still depth-tested, so a
 * column in front of a lantern hides its glow). glTF caps emissive at 1 without the strength extension,
 * so the light sources are brightened here, per material name.
 */
const BLOOM_SOURCES = new Set(['T16_Glow', 'T16_WindowGlow', 'T16_LanternPaper', 'T16_LanternPaperSmall']);
/** Light tiers (style reference: a dim hall lit in pools): great lanterns > lamp cores > small lanterns > windows. */
const EMISSIVE_BOOST: Record<string, number> = { T16_LanternPaper: 1.7, T16_Glow: 1.8, T16_LanternPaperSmall: 1.0, T16_WindowGlow: 1.0 };
const BLACK = new T.Color(0);
/**
 * Baked AO and bounce light (scripts/blender/bake_t16.py) on the shell's second UV set. Direct light stays
 * real time (the lantern tiers); the GI map adds only what those lanterns and the sky would bounce.
 */
const LIGHTMAP_URLS = import.meta.glob('../../../../assets/t16/runtime/lightmaps/*.ktx2', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const LIGHTMAPS = lightmaps as { giScale: number; maps: Record<string, { ao: string; gi: string }> };
const RUNTIME_MAPS = (runtime as { lightmaps: Record<string, { file: string }> }).lightmaps;
/** Served by the Vite plugin in apps/web/vite.config.ts from the installed three, so it never drifts from it. */
const BASIS_TRANSCODER = `${import.meta.env.BASE_URL}three-basis/`;
const GI_INTENSITY = 0.9, AO_INTENSITY = 1.0;
/**
 * Adaptive resolution (D4): the hall is fill-bound (16 lantern lights per pixel, 4× MSAA), so when frames
 * run long the renderer gives up pixel density, from the 1.5 cap down to 1.0, never lights or geometry.
 * After a while at full speed it tries one step back up; a step that drops frames again waits twice as long
 * (at most a minute). Known limit: a display or power-saving mode that caps rAF at 30 Hz reads as load and
 * settles at 1.0; it loses sharpness there, never function.
 */
const RES = { max: 1.5, min: 1, step: 0.125, slowMs: 1000 / 52, window: 60, probeMs: 6000, maxProbeMs: 60000 } as const;
/** Where the one-off reflection probe looks from: the middle of the atrium, at chest height. */
const PROBE_AT = new T.Vector3(0, 2.2, 6);


/** A copy of `source` whose attributes are plain float arrays (meshopt/quantised GLBs store normalised ints). */
function floatGeometry(source: T.BufferGeometry) {
  const geometry = source.clone();
  for (const [name, a] of Object.entries(geometry.attributes)) {
    if (a.array instanceof Float32Array && !a.normalized && !(a as T.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
    geometry.setAttribute(name, new T.BufferAttribute(out, a.itemSize));
  }
  return geometry;
}

/** Full-viewport first-person pavilion. React owns the HUD; this owns WebGL, input and walking. */
export class PavilionEngine {
  readonly world: NavWorld = buildNavWorld(LAYOUT);
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(68, 1, 0.1, 1200);   // near 0.1 keeps depth precision with the 1.2 km sky
  private building = new T.Group();
  private exhibits = new T.Group();
  private exhibitToken = 0;
  private player: FirstPerson = { ...this.world.entry, velocityY: null };
  private viewY = this.world.entry.y;
  private yaw = ENTRY_YAW;
  private pitch: number = FOLLOW.entryPitch;
  private eyeY = BODY.eye;
  private view: ViewMode = 'third';
  private avatar: AvatarRig;
  private boom: number = FOLLOW.distance;
  private camera3 = pavilionCamera(this.world);
  private velocity: [number, number] = [0, 0];
  private keys = new Set<string>();
  private jumpQueued = false;
  private enabled = false;
  private dragging = false;
  private closed = false;
  private clock = new T.Clock();
  private observer: ResizeObserver;
  private lastHud = 0;
  private hudKey = '';
  private frames: number[] = [];
  private fps = 0;
  private abort = new AbortController();
  private composer: EffectComposer;
  private bloomComposer: EffectComposer;
  private bloom: UnrealBloomPass;
  private dark = new Map<T.Material, T.Material>();
  private swapped: [T.Mesh, T.Material | T.Material[]][] = [];
  private sky = new PavilionSky();
  private atmosphere = new PavilionAtmosphere(LAYOUT.oculus, LAYOUT.floorY);
  private elapsed = 0;
  private lightmapped = 0;
  private envTarget: T.WebGLRenderTarget | null = null;
  private ktx2: KTX2Loader;
  private intervals: number[] = [];
  private lastFrame = 0;
  private resChanged = 0;
  private probeMs: number = RES.probeMs;
  private probing = false;
  private pinnedDpr: number | null = null;

  constructor(private host: HTMLElement, private hooks: EngineHooks) {
    this.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, RES.max));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    // Casters are static between building/exhibit changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '藏宝阁三维场景');
    host.append(canvas);
    this.ktx2 = new KTX2Loader().setTranscoderPath(BASIS_TRANSCODER).detectSupport(this.renderer);
    // Until the shell has loaded, a dim neutral room probe; once it has, captureReflections() replaces it
    // with the hall itself (lanterns, columns, sky in the oculus) for the polished floor and the gilt.
    const pmrem = new T.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.28;
    pmrem.dispose(); room.dispose();
    // D3: the dusk/starlit dome, cloud sea, mountains and isles replace the flat backdrop; the fog only
    // softens the far end of the long halls and never touches the sky (its materials opt out).
    this.scene.background = new T.Color('#2b2a45');
    this.scene.fog = new T.Fog('#2b2a45', 80, 260);
    this.scene.add(this.building, this.exhibits, this.sky.group, this.atmosphere.group);
    // Selective bloom (see BLOOM_SOURCES): the bloom composer renders the light sources alone at half
    // resolution; the main composer (MSAA half-float, keeps the lattice alpha-to-coverage) adds that glow
    // to the full scene, and tone mapping happens once, in OutputPass. info is reset per frame by hand,
    // because the composers issue several renders per frame.
    this.renderer.info.autoReset = false;
    this.bloomComposer = new EffectComposer(this.renderer, new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType }));
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new T.Vector2(1, 1), 0.6, 0.2, 0);
    this.bloomComposer.addPass(this.bloom);
    this.composer = new EffectComposer(this.renderer, new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const mix = new ShaderPass(new T.ShaderMaterial({
      uniforms: { baseTexture: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D baseTexture, bloomTexture; varying vec2 vUv; void main() { gl_FragColor = texture2D(baseTexture, vUv) + vec4(texture2D(bloomTexture, vUv).rgb, 0.0); }',
    }), 'baseTexture');
    this.composer.addPass(mix);
    this.composer.addPass(new OutputPass());
    this.avatar = new AvatarRig(this.scene);
    this.avatar.face(ENTRY_YAW + Math.PI);
    this.lights();
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(host);
    this.fit();
    this.placeCamera(0);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', this.clearKeys);
    canvas.addEventListener('pointerdown', this.pointerDown);
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('pointermove', this.pointerMove);
    document.addEventListener('pointerlockchange', this.lockChange);
    this.renderer.setAnimationLoop(this.frame);
    void this.load();
  }

  /**
   * D1 graybox lighting: cool sky through the oculus (the only shadow caster), warm lantern points
   * from the exported light markers, hemisphere fill. Final lighting is baked in D3.
   */
  private lights() {
    // A dim fill: the hall should read in pools of lantern light, not evenly lit (D3 user feedback).
    this.scene.add(new T.HemisphereLight(0x9db2d6, 0x3a2414, 0.5));
    const sky = new T.DirectionalLight(0xd6e4ff, 2.0);
    // Straight down through the oculus (x 0, z 2): its pool of starlight lands on the Treasure's dais,
    // inside the drawn light shaft, instead of a slanted second patch on the floor beside it.
    sky.position.set(LAYOUT.oculus.x, 60, LAYOUT.oculus.z);
    sky.target.position.set(LAYOUT.oculus.x, 0, LAYOUT.oculus.z);
    sky.castShadow = true;
    sky.shadow.mapSize.set(4096, 4096);
    Object.assign(sky.shadow.camera, { left: -38, right: 38, top: 40, bottom: -40, near: 1, far: 120 });
    sky.shadow.camera.updateProjectionMatrix();
    sky.shadow.bias = -0.0004;
    sky.shadow.normalBias = 0.03;
    this.scene.add(sky, sky.target);
    const perRole: Record<string, { every: number; scale: number }> = {
      // Great atrium lanterns carry the hall; small wall lanterns only pool light locally.
      atrium: { every: 1, scale: 0.5 }, portal: { every: 1, scale: 0.35 }, entry: { every: 1, scale: 0.3 },
      terrace: { every: 1, scale: 0.7 }, hall: { every: 2, scale: 0.35 }, upper: { every: 2, scale: 0.35 },
    };
    const seen: Record<string, number> = {};
    for (const m of LAYOUT.lights) {
      const rule = perRole[m.role];
      if (!rule) continue;
      const n = seen[m.role] = (seen[m.role] ?? 0) + 1;
      if ((n - 1) % rule.every) continue;
      const light = new T.PointLight(new T.Color(...m.color), m.power * rule.scale, 0, 2);
      light.position.fromArray(m.position);
      this.scene.add(light);
    }
  }

  private async load() {
    try {
      const response = await fetch(pavilionUrl, { signal: this.abort.signal });
      if (!response.ok || !response.body) throw new Error(`建筑模型读取失败（HTTP ${response.status}）`);
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); received += value.length;
        if (total) this.hooks.progress(Math.min(0.95, received / total * 0.95));
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
      const [gltf, maps] = await Promise.all([new GLTFLoader().setKTX2Loader(this.ktx2).setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes.buffer, ''), this.loadLightmaps()]);
      if (this.closed) { maps.forEach(m => { m.ao.dispose(); m.gi.dispose(); }); return; }
      this.mergeByMaterial(gltf.scene, maps);
      this.captureReflections();
      this.renderer.shadowMap.needsUpdate = true;
      this.hooks.progress(1);
      this.hooks.ready();
    } catch (error) {
      if (!this.closed) this.hooks.failed(error instanceof Error ? error.message : String(error));
    }
  }

  private async loadLightmaps() {
    const out = new Map<string, { ao: T.Texture; gi: T.Texture }>();
    const tex = async (file: string, srgb: boolean) => {
      const url = LIGHTMAP_URLS[`../../../../assets/t16/runtime/lightmaps/${RUNTIME_MAPS[file]?.file}`];
      if (!url) throw new Error(`缺少光照贴图 ${file}`);
      const t = await this.ktx2.loadAsync(url);
      t.flipY = false; t.channel = 1; t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
      return t;
    };
    // A missing or broken map only costs that material its bake; the pavilion still loads.
    await Promise.all(Object.entries(LIGHTMAPS.maps).map(async ([name, m]) => {
      const [ao, gi] = await Promise.allSettled([tex(m.ao, false), tex(m.gi, true)]);
      if (ao.status === 'fulfilled' && gi.status === 'fulfilled') { out.set(name, { ao: ao.value, gi: gi.value }); return; }
      for (const r of [ao, gi]) if (r.status === 'fulfilled') r.value.dispose();
      console.warn(`光照贴图 ${name} 读取失败，该材质不使用烘焙光照`);
    }));
    return out;
  }

  /**
   * Reflections: render the loaded hall once into a cube map from the atrium and prefilter it, so polished
   * stone and gilt mirror the real lanterns and columns. Static, so it costs nothing per frame (a
   * per-frame planar mirror was the alternative; see the D3 decision log).
   */
  private captureReflections() {
    const target = new T.WebGLCubeRenderTarget(256, { type: T.HalfFloatType });
    const cube = new T.CubeCamera(0.1, 1200, target);
    cube.position.copy(PROBE_AT);
    const hidden = [this.atmosphere.group, this.exhibits, ...this.avatarRoots()];
    const was = hidden.map(o => o.visible);
    hidden.forEach(o => { o.visible = false; });
    this.sky.update(this.elapsed, cube);
    cube.update(this.renderer, this.scene);
    hidden.forEach((o, i) => { o.visible = was[i]; });
    const pmrem = new T.PMREMGenerator(this.renderer);
    const env = pmrem.fromCubemap(target.texture);
    pmrem.dispose(); target.dispose();
    this.envTarget?.dispose(); this.scene.environment?.dispose();
    this.envTarget = env;
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.85;
  }
  private avatarRoots(): T.Object3D[] {
    return this.scene.children.filter(o => o !== this.building && o !== this.exhibits && o !== this.sky.group && o !== this.atmosphere.group && !(o instanceof T.Light));
  }

  /**
   * Merging the static shell by material cuts draw calls to roughly one per material. Props the runtime
   * GLB stores as GPU instances (curios, lamps, censers) stay instanced: one draw each, one copy of the mesh.
   */
  private mergeByMaterial(root: T.Object3D, maps: Map<string, { ao: T.Texture; gi: T.Texture }>) {
    root.updateMatrixWorld(true);
    const groups = new Map<string, { material: T.Material; geometries: T.BufferGeometry[] }>();
    const instanced: T.InstancedMesh[] = [];
    root.traverse(o => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh as T.InstancedMesh).isInstancedMesh) { instanced.push(mesh as T.InstancedMesh); return; }
      const material = mesh.material as T.Material;
      // Quantised attributes (normalised ints) cannot hold world coordinates: widen to float first.
      const geometry = floatGeometry(mesh.geometry).applyMatrix4(mesh.matrixWorld);
      const key = `${material.uuid}|${Object.keys(geometry.attributes).sort().join(',')}|${geometry.index ? 'i' : 'n'}`;
      const g = groups.get(key) ?? { material, geometries: [] };
      g.geometries.push(geometry);
      groups.set(key, g);
      mesh.geometry.dispose();
    });
    const prepared = new Set<T.Material>(), lit = new Set<T.Material>();
    // Instanced props carry no lightmap UVs: a material they share must never take a lightmap.
    const onInstances = new Set(instanced.map(m => m.material as T.Material));
    const prepare = (material: T.Material) => {
      if (prepared.has(material)) return;
      prepared.add(material);
      // Grazing views across the long floor and carpets need anisotropic filtering.
      const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      for (const v of Object.values(material)) if (v instanceof T.Texture) v.anisotropy = aniso;
      // Lattice is alpha-clipped: let MSAA dither the cut-out so thin bars fade instead of sparkling far away.
      if (material.alphaTest > 0) material.alphaToCoverage = true;
      const boost = EMISSIVE_BOOST[material.name];
      if (boost && material instanceof T.MeshStandardMaterial) material.emissiveIntensity *= boost;
    };
    const built: T.Mesh[] = [];
    for (const { material, geometries } of groups.values()) {
      const merged = mergeGeometries(geometries, false);
      geometries.forEach(g => g.dispose());
      if (!merged) throw new Error('建筑网格合并失败');
      prepare(material);
      const mesh = new T.Mesh(merged, material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = material.name;
      built.push(mesh);
      this.building.add(mesh);
    }
    // A lightmap goes on a material only if every mesh drawing it has the second UV set (and no instanced
    // prop shares it); otherwise the meshes without uv1 would sample the map at its corner.
    for (const material of new Set(built.map(b => b.material as T.Material))) {
      const baked = maps.get(material.name);
      if (!baked || onInstances.has(material) || !(material instanceof T.MeshStandardMaterial)) continue;
      if (!built.every(b => b.material !== material || b.geometry.getAttribute('uv1'))) continue;
      Object.assign(material, { aoMap: baked.ao, aoMapIntensity: AO_INTENSITY, lightMap: baked.gi, lightMapIntensity: GI_INTENSITY });
      material.needsUpdate = true;
      lit.add(material);
      this.lightmapped++;
    }
    // Lightmaps no merged mesh could take (no second UV set) are released here.
    for (const [name, baked] of maps) if (![...lit].some(m => m.name === name)) { baked.ao.dispose(); baked.gi.dispose(); }
    const m = new T.Matrix4();
    for (const mesh of instanced) {
      // Bake the node's world transform into every instance, so the mesh sits at the origin of the building.
      for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); mesh.setMatrixAt(i, m.premultiply(mesh.matrixWorld)); }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.removeFromParent();
      mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1); mesh.updateMatrix();
      mesh.computeBoundingBox(); mesh.computeBoundingSphere();
      const material = mesh.material as T.Material;
      prepare(material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = material.name;
      this.building.add(mesh);
    }
  }

  /** One adaptive-resolution decision per `RES.window` frames (see RES). */
  private adaptResolution(now: number) {
    if (this.pinnedDpr !== null) return;
    const gap = now - this.lastFrame;
    this.lastFrame = now;
    if (gap > 250) { this.intervals.length = 0; return; }   // tab switch, load hitch: not a measure of load
    this.intervals.push(gap);
    if (this.intervals.length < RES.window) return;
    const median = this.intervals.sort((a, b) => a - b)[this.intervals.length >> 1];
    this.intervals.length = 0;
    const dpr = this.renderer.getPixelRatio(), top = Math.min(devicePixelRatio, RES.max);
    let next = dpr;
    if (median > RES.slowMs) {
      if (dpr > RES.min) next = Math.max(RES.min, dpr - RES.step);
      if (this.probing) this.probeMs = Math.min(this.probeMs * 2, RES.maxProbeMs);   // the step up did not hold
    } else {
      // A step up that held for 2 s resets the wait, so one passing hitch cannot pin the low tier for good.
      if (this.probing && now - this.resChanged > 2000) { this.probing = false; this.probeMs = RES.probeMs; }
      if (dpr < top && now - this.resChanged > this.probeMs) next = Math.min(top, dpr + RES.step);
    }
    if (next === dpr) return;
    this.probing = next > dpr;
    this.resChanged = now;
    this.renderer.setPixelRatio(next);
    this.fit();
  }

  private fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloomComposer.setPixelRatio(this.renderer.getPixelRatio() / 2);
    this.bloomComposer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Movement and look are only live while no menu/drawer/detail owns input. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.clearKeys();
    if (!enabled) this.releaseLock();
  }
  requestLock() {
    const canvas = this.renderer.domElement;
    canvas.focus({ preventScroll: true });
    try { void (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* drag-to-look fallback */ }
  }
  releaseLock() {
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }
  resetToEntry() {
    this.player = { ...this.world.entry, velocityY: null };
    this.viewY = this.player.y;
    this.yaw = ENTRY_YAW; this.pitch = this.entryPitch(); this.eyeY = BODY.eye;
    this.avatar.face(ENTRY_YAW + Math.PI);
    this.clearKeys();
    this.boom = FOLLOW.distance;
    this.placeCamera(0);
  }
  look(yaw: number, pitch = this.pitch) {
    this.yaw = yaw;
    this.pitch = this.view === 'third' ? clampFollowPitch(pitch) : T.MathUtils.clamp(pitch, -1.35, 1.35);
  }
  /** Character and view from the visitor's per-browser preference (T15). */
  setAvatar(prefs: AvatarPrefs) {
    this.setView(prefs.view);
    this.avatar.setCharacter(prefs.character).catch(error => {
      if (this.closed) return;
      this.setView('first');
      this.hooks.avatarFailed?.(error instanceof Error ? error.message : '角色模型读取失败');
    });
  }
  private entryPitch() { return this.view === 'third' ? FOLLOW.entryPitch : 0.05; }
  setView(view: ViewMode) {
    const atEntryView = this.pitch === this.entryPitch();
    this.view = view;
    this.boom = FOLLOW.distance;
    // A view the visitor has not turned yet starts from that view's own entry pitch.
    this.look(this.yaw, atEntryView ? this.entryPitch() : this.pitch);
    this.placeCamera(0);
  }

  private clearKeys = () => { this.keys.clear(); this.jumpQueued = false; this.dragging = false; };
  private keyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+key on macOS can swallow keyup
    if (e.code === 'Space' && !(e.target as HTMLElement | null)?.closest?.('button,a')) {
      e.preventDefault();
      if (!e.repeat) this.jumpQueued = true;
      return;
    }
    if (e.code in MOVE_KEYS || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { e.preventDefault(); this.keys.add(e.code); }
  };
  private keyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); if (e.key === 'Meta') this.keys.clear(); };
  private pointerDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    this.dragging = true;
    if (document.pointerLockElement !== this.renderer.domElement) this.requestLock();
  };
  private pointerUp = () => { this.dragging = false; };
  private pointerMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    const locked = document.pointerLockElement === this.renderer.domElement;
    if (!locked && !this.dragging) return;
    // Chrome can report one bogus, very large delta right after pointer lock is (re)acquired.
    if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
    this.look(this.yaw - e.movementX * 0.0022, this.pitch - e.movementY * 0.0022);
  };
  private lockChange = () => {
    if (document.pointerLockElement === this.renderer.domElement) return;
    this.clearKeys();
    if (this.enabled) this.hooks.lockLost();
  };

  private pivot(): Vec3 { return [this.player.x, this.viewY + FOLLOW.pivot, this.player.z]; }
  private placeCamera(dt: number) {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (this.view === 'first') {
      this.camera.position.set(this.player.x, this.viewY + this.eyeY, this.player.z);
      return;
    }
    // Third person: orbit the pivot behind the view direction, pulled in by walls, slabs and floors.
    const pivot = this.pivot(), [dx, dy, dz] = viewDirection(this.yaw, this.pitch), back: Vec3 = [-dx, -dy, -dz];
    const target = boomLength(this.camera3.world, pivot, back, FOLLOW.distance, this.camera3.blockers);
    this.boom = dt ? easeBoom(this.boom, target, dt) : target;
    this.camera.position.set(pivot[0] + back[0] * this.boom, pivot[1] + back[1] * this.boom, pivot[2] + back[2] * this.boom);
  }

  private frame = (now: number) => {
    if (this.closed) return;
    const dt = Math.min(this.clock.getDelta(), 0.25);
    if (this.enabled && (this.keys.size || this.jumpQueued || this.player.velocityY !== null)) {
      let forward = 0, right = 0;
      for (const k of this.keys) { const v = MOVE_KEYS[k]; if (v) { forward += v[0]; right += v[1]; } }
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const before = this.player;
      this.player = stepFirstPerson(this.world, this.player, { forward, right, run }, this.yaw, dt, this.jumpQueued);
      this.jumpQueued = false;
      this.velocity = dt ? [(this.player.x - before.x) / dt, (this.player.z - before.z) / dt] : [0, 0];
    } else this.velocity = [0, 0];
    const dy = this.player.y - this.viewY;
    this.viewY = this.player.velocityY !== null || Math.abs(dy) > 0.6 ? this.player.y : this.viewY + dy * (1 - Math.exp(-dt * STEP_GLIDE));
    this.placeCamera(dt);
    this.avatar.update(dt, {
      feet: { x: this.player.x, y: this.viewY, z: this.player.z }, velocity: this.velocity,
      ground: supportAt(this.world, this.player.x, this.player.z, this.player.y + 0.01),
      visible: this.view === 'third' && this.boom >= FOLLOW.hideBelow,
    });
    this.elapsed += dt;
    this.sky.update(this.elapsed, this.camera);
    this.atmosphere.update(this.elapsed, this.renderer.domElement.height);
    this.renderer.info.reset();
    this.renderBloom(dt);
    this.composer.render(dt);
    this.frames.push(now);
    this.adaptResolution(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    if (now - this.lastHud > 120) {
      this.lastHud = now;
      this.fps = this.frames.length;
      const hud = this.hud();
      const key = `${hud.floor}|${hud.target?.id ?? ''}|${Math.round(hud.fps / 5)}|${hud.calls}`;
      if (key !== this.hudKey) { this.hudKey = key; this.hooks.hud(hud); }
    }
  };

  /** Bloom input: the scene with every non-source material swapped for a black one (alpha cut-outs kept). */
  private renderBloom(dt: number) {
    if (!this.bloom.enabled) {   // debug comparison: leave no stale glow behind
      this.renderer.setRenderTarget(this.bloomComposer.renderTarget2); this.renderer.clear(); this.renderer.setRenderTarget(null);
      return;
    }
    const background = this.scene.background, shadows = this.renderer.shadowMap.needsUpdate;
    // A pending shadow refresh belongs to the real render below, with the real materials.
    this.renderer.shadowMap.needsUpdate = false;
    this.scene.background = BLACK;
    this.sky.group.visible = this.atmosphere.group.visible = false;
    try {
      this.scene.traverseVisible(o => {
        const mesh = o as T.Mesh;
        if (!mesh.isMesh || BLOOM_SOURCES.has(mesh.name)) return;
        this.swapped.push([mesh, mesh.material]);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => this.darkOf(m)) : this.darkOf(mesh.material);
      });
      this.bloomComposer.render(dt);
    } finally {
      for (const [mesh, material] of this.swapped) mesh.material = material;
      this.swapped.length = 0;
      this.scene.background = background;
      this.sky.group.visible = this.atmosphere.group.visible = true;
      this.renderer.shadowMap.needsUpdate = shadows;
    }
  }
  private darkOf(m: T.Material) {
    let d = this.dark.get(m);
    if (!d) {
      // Keep everything that shapes the silhouette (cut-outs, alpha maps, see-through), so a glass or a
      // hair card dims the glow behind it as much as it really hides it, and no more.
      const src = m as T.MeshStandardMaterial, cut = src.alphaTest > 0 || src.transparent;
      d = new T.MeshBasicMaterial({
        color: 0, fog: false, side: src.side, map: cut ? src.map ?? null : null, alphaMap: src.alphaMap ?? null,
        alphaTest: src.alphaTest, transparent: src.transparent, opacity: src.opacity, depthWrite: src.depthWrite,
      });
      this.dark.set(m, d);
    }
    return d;
  }

  private hud(): HudState {
    const d = new T.Vector3();
    this.camera.getWorldDirection(d);
    // Third person aims from the character's pivot along the view, so the same plinth is reachable.
    const p = this.view === 'third' ? new T.Vector3(...this.pivot()) : this.camera.position;
    return {
      floor: floorOf(this.player.y),
      target: this.enabled ? targetSlot(this.world, [p.x, p.y, p.z], [d.x, d.y, d.z], 3, this.player.y) : null,
      fps: this.fps,
      calls: this.renderer.info.render.calls,
    };
  }

  /**
   * Places the published gallery version on its plinths: every model is centred on the plinth axis,
   * rests on the plinth top and is uniformly fitted (PRD 7.7, no manual height/rotation/scale).
   * Files are read with the snapshot grant only, never with the visitor's login cookie.
   */
  async setExhibits(slots: GallerySlot[], headers: Record<string, string>): Promise<{ loaded: number; failed: number }> {
    const token = ++this.exhibitToken;
    const old = [...this.exhibits.children];
    this.exhibits.clear();
    this.renderer.shadowMap.needsUpdate = true;
    disposeResources(old);
    this.dark.forEach(m => m.dispose()); this.dark.clear();   // black stand-ins are rebuilt on demand
    const byMarker = new Map(this.world.slots.map(s => [s.id, s]));
    const queue = slots.filter(s => s.exhibit && byMarker.has(slotMarker(s.slotNo)));
    const shown: ExhibitSlot[] = [];
    this.atmosphere.setHalos(shown);
    this.clearExhibitColliders();
    let loaded = 0, failed = 0;
    const loadOne = async (slot: GallerySlot) => {
      const model = slot.exhibit!.model, marker = byMarker.get(slotMarker(slot.slotNo))!;
      try {
        const source = await this.loadModel(model, headers);
        if (this.closed || token !== this.exhibitToken) { disposeResources([source]); return; }
        // Each slot's tier sets the largest edge and the height the model rests (floats) at; the
        // model is centred on the slot axis and turned to face the visitor's side.
        const fit = exhibitFit(model.bounds, marker.fit?.maxSize ?? EXHIBIT_FIT.maxSize);
        const holder = new T.Group(), fitted = new T.Group();
        holder.name = `exhibit-${slot.slotNo}`;
        holder.userData = { slotNo: slot.slotNo, candidateId: slot.exhibit!.candidateId, fitScale: fit.scale };
        holder.position.set(marker.position[0], marker.fit?.restY ?? marker.position[1] + EXHIBIT_FIT.plinthTop, marker.position[2]);
        holder.rotation.y = marker.yaw ?? 0;
        fitted.position.fromArray(fit.offset);
        fitted.scale.setScalar(fit.scale);
        fitted.add(source);
        holder.add(fitted);
        source.traverse(o => { const m = o as T.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
        this.exhibits.add(holder);
        this.renderer.shadowMap.needsUpdate = true;
        shown.push(marker); this.atmosphere.setHalos(shown);
        this.addExhibitCollider(holder);
        loaded++;
      } catch { if (token === this.exhibitToken) failed++; }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (let s; (s = queue.shift());) await loadOne(s); }));
    return { loaded, failed };
  }
  private async loadModel(model: RoomModel, headers: Record<string, string>) {
    const response = await fetch('/api/v1/files/' + encodeURIComponent(model.modelFileId) + '/content', { headers, credentials: 'omit', cache: 'no-store', signal: this.abort.signal });
    if (!response.ok) throw new Error('展品读取失败');
    const manager = new T.LoadingManager();
    manager.setURLModifier(url => { if (url.startsWith('blob:') || url.startsWith('data:')) return url; throw new Error('模型包含外部资源。'); });
    const scene = (await new GLTFLoader(manager).parseAsync(await response.arrayBuffer(), '')).scene;
    const translated = new T.Group(); translated.position.fromArray(model.normalization.translation); translated.add(scene);
    const normalized = new T.Group(); normalized.scale.setScalar(model.normalization.scale); normalized.add(translated);
    return normalized;
  }
  exhibitCount() { return this.exhibits.children.length; }

  /**
   * Exhibits are solid: each loaded model's world box (conservative: the AABB of the turned model; it
   * floats a little above its plinth and may overhang it) joins the walking colliders, which the follow
   * camera also respects. Cleared when a new published version starts loading, so no stale box outlives
   * its model. A visitor standing where a box appears (e.g. on the plinth top) is moved clear.
   */
  private clearExhibitColliders() {
    const cs = this.world.colliders;
    for (let i = cs.length - 1; i >= 0; i--) if (cs[i].id.startsWith(EXHIBIT_COLLIDER)) cs.splice(i, 1);
  }
  private addExhibitCollider(holder: T.Object3D) {
    holder.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(holder);
    const c = exhibitCollider(holder.userData.slotNo as number, box.min.toArray(), box.max.toArray());
    if (!c) return;
    this.world.colliders.push(c);
    const freed = freePlayer(this.world, this.player);
    if (freed !== this.player) { this.player = freed; this.viewY = freed.y; this.placeCamera(0); }
  }

  /** Read-only state for local checks (scripts/t10-game-browser.mjs). */
  debugState() {
    const { x, y, z, velocityY } = this.player;
    return {
      player: { x, y, z }, airborne: velocityY !== null, yaw: this.yaw, pitch: this.pitch, enabled: this.enabled, keys: [...this.keys],
      locked: document.pointerLockElement === this.renderer.domElement, ...this.hud(),
      view: this.view, boom: this.boom, camera: this.camera.position.toArray(), avatar: this.avatar.debug(),
      meshes: this.building.children.length, lightmapped: this.lightmapped, exhibits: this.exhibits.children.map(o => ({ ...o.userData, position: o.position.toArray(), scale: o.userData.fitScale as number, bounds: (b => [b.min.toArray(), b.max.toArray()])(new T.Box3().setFromObject(o)) })),
      triangles: this.renderer.info.render.triangles,
      viewport: [this.host.clientWidth, this.host.clientHeight], pixelRatio: this.renderer.getPixelRatio(),
    };
  }
  /** Benchmarks only (scripts/t16-perf.mjs): hold a pixel ratio, or `null` to hand it back to RES. */
  debugResolution(dpr: number | null) {
    this.pinnedDpr = dpr;
    this.intervals.length = 0;
    this.renderer.setPixelRatio(dpr ?? Math.min(devicePixelRatio, RES.max));
    this.fit();
  }
  /** Screenshot framing only (never used by the walking check): place the camera on a valid surface. */
  debugPlace(x: number, z: number, y: number, yaw: number, pitch: number) {
    this.player = { x, y, z, velocityY: null };
    this.viewY = y;
    this.look(yaw, pitch);
    this.placeCamera(0);
  }
  /** Ray-cast the real GLB geometry straight down: used to check nav surfaces match the model. */
  probeGround(x: number, z: number, fromY: number) {
    const ray = new T.Raycaster(new T.Vector3(x, fromY, z), new T.Vector3(0, -1, 0), 0, 40);
    const hit = ray.intersectObject(this.building, true)[0];
    return hit ? hit.point.y : null;
  }

  /**
   * Debug only (scripts/t15-third-person-browser.mjs): ray-cast the real GLB from the pivot to the
   * camera. The game itself never does this; it is the evidence that the analytic boom matches the model.
   */
  debugCameraClearance() {
    if (this.view !== 'third') return null;
    const pivot = new T.Vector3(...this.pivot()), toCamera = this.camera.position.clone().sub(pivot), length = toCamera.length();
    const hit = new T.Raycaster(pivot, toCamera.normalize(), 0, length).intersectObject(this.building, true)[0];
    return { boom: length, hit: hit ? { distance: hit.distance, mesh: hit.object.name } : null };
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.renderer.setAnimationLoop(null);
    this.observer.disconnect();
    this.releaseLock();
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('blur', this.clearKeys);
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    window.removeEventListener('pointerup', this.pointerUp);
    window.removeEventListener('pointermove', this.pointerMove);
    document.removeEventListener('pointerlockchange', this.lockChange);
    this.exhibitToken++;
    this.avatar.dispose();
    disposeResources([...this.exhibits.children]);
    this.exhibits.clear();
    this.building.traverse(o => { if ((o as T.InstancedMesh).isInstancedMesh) (o as T.InstancedMesh).dispose(); });   // instance buffers
    disposeResources([this.building]);   // the textured shell: geometries, materials and their maps
    this.building.clear();
    this.scene.environment?.dispose();
    this.sky.dispose();
    this.atmosphere.dispose();
    this.bloom.dispose();
    this.bloomComposer.dispose();
    this.composer.dispose();
    this.dark.forEach(m => m.dispose());
    this.ktx2.dispose();
    this.envTarget?.dispose(); this.envTarget = null;
    this.scene.traverse(o => {
      const mesh = o as T.Mesh;
      if (mesh.isMesh) { mesh.geometry.dispose(); ([] as T.Material[]).concat(mesh.material).forEach(m => m.dispose()); }
      if (o instanceof T.DirectionalLight || o instanceof T.SpotLight) o.shadow.dispose();
    });
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
