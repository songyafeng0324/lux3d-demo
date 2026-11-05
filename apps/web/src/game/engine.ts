import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import pavilionUrl from '../../../../assets/t10/pavilion-v1.glb?url';
import layout from '../../../../assets/t10/pavilion-layout.json';
import { buildNavWorld, step, targetSlot, floorOf, BODY, type ExhibitSlot, type Player, type NavWorld } from './navigation.js';

export interface HudState { floor: ReturnType<typeof floorOf>; target: ExhibitSlot | null; fps: number; calls: number }
export interface EngineHooks {
  progress(ratio: number): void;
  ready(): void;
  failed(message: string): void;
  hud(state: HudState): void;
  /** Pointer lock was lost while movement was enabled (user pressed Esc / switched tab). */
  lockLost(): void;
}
interface LightMarker { position: [number, number, number]; color: [number, number, number]; power: number; type: string }

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0],
  KeyA: [0, -1], ArrowLeft: [0, -1], KeyD: [0, 1], ArrowRight: [0, 1],
};
export const ENTRY_YAW = 0;

/** Full-viewport first-person pavilion. React owns the HUD; this owns WebGL, input and walking. */
export class PavilionEngine {
  readonly world: NavWorld = buildNavWorld(layout.exhibitSlots as unknown as ExhibitSlot[]);
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(68, 1, 0.05, 220);
  private building = new T.Group();
  private player: Player = { ...this.world.entry };
  private yaw = ENTRY_YAW;
  private pitch = 0.05;
  private eyeY = BODY.eye;
  private keys = new Set<string>();
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

  constructor(private host: HTMLElement, private hooks: EngineHooks) {
    this.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '藏宝阁三维场景');
    host.append(canvas);
    this.scene.background = new T.Color('#5d6f7b');
    this.scene.fog = new T.Fog('#5d6f7b', 40, 120);
    this.scene.add(this.building);
    this.lights();
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(host);
    this.fit();
    this.placeCamera();
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

  /** Same lighting basis as the validated T10-B preview; Blender lights are not in the GLB. */
  private lights() {
    this.scene.add(new T.HemisphereLight(0xb3cee1, 0x6e4c31, 1.2));
    const sky = new T.DirectionalLight(0xd3e6ff, 2.1);
    sky.position.set(0, 18, 5);
    sky.castShadow = true;
    sky.shadow.mapSize.set(2048, 2048);
    Object.assign(sky.shadow.camera, { left: -17, right: 17, top: 19, bottom: -19, near: 0.5, far: 60 });
    sky.shadow.bias = -0.0003;
    sky.shadow.normalBias = 0.015;
    this.scene.add(sky, sky.target);
    for (const m of (layout.lightMarkers as unknown as LightMarker[]).filter(m => m.type === 'POINT')) {
      const light = new T.PointLight(new T.Color(...m.color), m.power * 0.25, 12, 2);
      light.position.fromArray(m.position);
      this.scene.add(light);
    }
    for (const x of [-10, 10]) {
      const fill = new T.PointLight(0xb8d2eb, 170, 30, 2);
      fill.position.set(x, 6.8, 1);
      this.scene.add(fill);
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
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
      if (this.closed) return;
      this.mergeByMaterial(gltf.scene);
      this.hooks.progress(1);
      this.hooks.ready();
    } catch (error) {
      if (!this.closed) this.hooks.failed(error instanceof Error ? error.message : String(error));
    }
  }

  /** The static shell has ~191 meshes; merging by material cuts draw calls to roughly one per material. */
  private mergeByMaterial(root: T.Object3D) {
    root.updateMatrixWorld(true);
    const groups = new Map<string, { material: T.Material; geometries: T.BufferGeometry[] }>();
    root.traverse(o => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as T.Material;
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const key = `${material.uuid}|${Object.keys(geometry.attributes).sort().join(',')}|${geometry.index ? 'i' : 'n'}`;
      const g = groups.get(key) ?? { material, geometries: [] };
      g.geometries.push(geometry);
      groups.set(key, g);
      mesh.geometry.dispose();
    });
    for (const { material, geometries } of groups.values()) {
      const merged = mergeGeometries(geometries, false);
      geometries.forEach(g => g.dispose());
      if (!merged) throw new Error('建筑网格合并失败');
      const mesh = new T.Mesh(merged, material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = material.name;
      this.building.add(mesh);
    }
  }

  private fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
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
    this.player = { ...this.world.entry };
    this.yaw = ENTRY_YAW; this.pitch = 0.05; this.eyeY = BODY.eye;
    this.clearKeys();
    this.placeCamera();
  }
  look(yaw: number, pitch = this.pitch) {
    this.yaw = yaw;
    this.pitch = T.MathUtils.clamp(pitch, -1.35, 1.35);
  }

  private clearKeys = () => { this.keys.clear(); this.dragging = false; };
  private keyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+key on macOS can swallow keyup
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

  private placeCamera() {
    this.camera.position.set(this.player.x, this.player.y + this.eyeY, this.player.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private frame = (now: number) => {
    if (this.closed) return;
    const dt = Math.min(this.clock.getDelta(), 0.25);
    if (this.enabled && this.keys.size) {
      let forward = 0, right = 0;
      for (const k of this.keys) { const v = MOVE_KEYS[k]; if (v) { forward += v[0]; right += v[1]; } }
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      this.player = step(this.world, this.player, { forward, right, run }, this.yaw, dt);
    }
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    if (now - this.lastHud > 120) {
      this.lastHud = now;
      this.fps = this.frames.length;
      const hud = this.hud();
      const key = `${hud.floor}|${hud.target?.id ?? ''}|${Math.round(hud.fps / 5)}|${hud.calls}`;
      if (key !== this.hudKey) { this.hudKey = key; this.hooks.hud(hud); }
    }
  };

  private hud(): HudState {
    const d = new T.Vector3();
    this.camera.getWorldDirection(d);
    const p = this.camera.position;
    return {
      floor: floorOf(this.player.y),
      target: this.enabled ? targetSlot(this.world, [p.x, p.y, p.z], [d.x, d.y, d.z]) : null,
      fps: this.fps,
      calls: this.renderer.info.render.calls,
    };
  }

  /** Read-only state for local checks (scripts/t10-game-browser.mjs). */
  debugState() {
    return {
      player: { ...this.player }, yaw: this.yaw, pitch: this.pitch, enabled: this.enabled, keys: [...this.keys],
      locked: document.pointerLockElement === this.renderer.domElement, ...this.hud(),
      meshes: this.building.children.length,
      triangles: this.renderer.info.render.triangles,
      viewport: [this.host.clientWidth, this.host.clientHeight], pixelRatio: this.renderer.getPixelRatio(),
    };
  }
  /** Screenshot framing only (never used by the walking check): place the camera on a valid surface. */
  debugPlace(x: number, z: number, y: number, yaw: number, pitch: number) {
    this.player = { x, y, z };
    this.look(yaw, pitch);
    this.placeCamera();
  }
  /** Ray-cast the real GLB geometry straight down: used to check nav surfaces match the model. */
  probeGround(x: number, z: number, fromY: number) {
    const ray = new T.Raycaster(new T.Vector3(x, fromY, z), new T.Vector3(0, -1, 0), 0, 30);
    const hit = ray.intersectObject(this.building, true)[0];
    return hit ? hit.point.y : null;
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
    this.scene.traverse(o => {
      const mesh = o as T.Mesh;
      if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as T.Material).dispose(); }
      const light = o as T.DirectionalLight;
      if (light.isDirectionalLight) light.shadow.dispose();
    });
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
