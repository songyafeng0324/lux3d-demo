import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { roomPlacementBounds, roomPlacementFloor, validateRoomLayout, type Bounds, type RoomModel, type RoomPlacement } from '@aholo/contracts';
import { MOVE_KEYS, playerOverlaps, stepFirstPerson, type FirstPerson } from '../game/navigation.js';
import { architecture, disposeResources, enableMeshShadows } from '../scene/assets.js';
import { courtyardGround, courtyardPlants, courtyardSky, horizonColor } from './courtyard.js';
import { buildRoomWorld, ROOM_EYE_HEIGHT, roomEntrance } from './navigation.js';
export type RoomMode = 'edit' | 'visit' | 'share';
export type RoomTool = 'translate' | 'rotate' | 'scale';
interface Hooks { select: (id: string | null) => void; edit: (placement: RoomPlacement) => void; notice: (message: string) => void }
export class RoomEngine {
  readonly renderer: T.WebGLRenderer;
  readonly scene = new T.Scene();
  readonly camera = new T.PerspectiveCamera(45, 1, .05, 150);
  readonly orbit: OrbitControls;
  readonly transform: TransformControls;
  readonly templates = new Map<string, T.Group>();
  readonly instances = new Map<string, T.Group>();
  readonly bounds = new Map<string, Bounds>();
  readonly outline = new T.Box3Helper(new T.Box3(), 0xbe8c45);
  private profiles = new Map<string, RoomModel>();
  private loading = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private environment: T.WebGLRenderTarget;
  private observer: ResizeObserver;
  private roof: T.Group;
  private sky = courtyardSky();
  private sun = new T.DirectionalLight(0xffe1b1, 1.55);
  private mode: RoomMode;
  private placements: RoomPlacement[] = [];
  private world = buildRoomWorld([], this.bounds);
  private player: FirstPerson = roomEntrance(this.world);
  private input?: RoomPlacement[];
  private selected: string | null = null;
  private original?: RoomPlacement;
  private moving = false;
  private down = [0, 0];
  private keys = new Set<string>();
  private jumpQueued = false;
  private yaw = 0;
  private pitch = 0;
  private looking = false;
  private stopped = false;
  private lastTime = 0;
  private raycaster = new T.Raycaster();
  constructor(readonly host: HTMLElement, private hooks: Hooks, private headers: () => Record<string, string>, readonly readOnly = false) {
    this.mode = readOnly ? 'share' : 'edit';
    this.renderer = new T.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setClearColor(horizonColor);
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = .82;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', readOnly ? '只读小屋三维场景' : '小屋三维编辑场景');
    host.appendChild(this.renderer.domElement);
    const pmrem = new T.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, .04); room.dispose(); pmrem.dispose();
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = .36;
    this.scene.fog = new T.Fog(horizonColor, 38, 105);
    this.scene.add(new T.HemisphereLight(0xc4dcf1, 0x504238, .83));
    this.sun.position.set(-7, 12, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -14, right: 14, top: 13, bottom: -13, near: .3, far: 42 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -.00018;
    this.sun.shadow.normalBias = .018;
    this.sun.shadow.intensity = .9;
    this.scene.add(this.sun, this.sun.target);

    const shell = architecture(false, {
      floor: [0x606e76, 0x56636b, 0x65717a, 0x59666e],
      base: 0x454e52, wall: 0xa69b88, wood: 0x663d30, trim: 0x986a42,
    });
    enableMeshShadows(shell.group);
    this.roof = shell.roof;
    this.scene.add(shell.group, courtyardGround(), this.sky, courtyardPlants());
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true; this.orbit.maxPolarAngle = Math.PI * .46; this.orbit.minDistance = 2; this.orbit.maxDistance = 35;
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(.85); this.scene.add(this.transform.getHelper()); this.outline.visible = false; this.scene.add(this.outline);
    this.transform.addEventListener('dragging-changed', event => { this.moving = Boolean(event.value); this.orbit.enabled = !this.moving && this.mode === 'edit'; });
    this.transform.addEventListener('mouseDown', () => { const current = this.placements.find(p => p.id === this.selected); this.original = current ? structuredClone(current) : undefined; });
    this.transform.addEventListener('objectChange', () => {
      const object = this.transform.object;
      if (!object || !this.original || !this.selected) return;
      if (this.transform.mode === 'scale') {
        const old = this.original.scale;
        const scalar = object.scale.toArray().reduce((a, b) => Math.abs(b - old) > Math.abs(a - old) ? b : a, old);
        object.scale.setScalar(scalar);
      }
      if (this.transform.mode === 'translate' && ['X', 'Z', 'XZ'].includes(this.transform.axis ?? '')) {
        const bounds = this.bounds.get(this.original.assetId)!;
        const oldFloor = roomPlacementFloor(roomPlacementBounds(this.original, bounds));
        const floor = roomPlacementFloor(roomPlacementBounds(this.readPlacement(this.selected), bounds));
        object.position.y = this.original.position[1] + floor - oldFloor;
      }
      this.renderer.shadowMap.needsUpdate = true;
      this.outline.box.setFromObject(object);
      (this.outline.material as T.LineBasicMaterial).color.set(validateRoomLayout('校验', [this.readPlacement(this.selected)], this.bounds) ? 0xc33d32 : 0xbe8c45);
    });
    this.transform.addEventListener('mouseUp', () => {
      if (!this.original || !this.selected) return;
      const placement = this.readPlacement(this.selected);
      if (validateRoomLayout('校验', [placement], this.bounds)) {
        this.apply(this.instances.get(placement.id)!, this.original);
        this.hooks.notice('物品超出房屋可用边界，已恢复操作前的位置。');
      } else { this.placements = this.placements.map(p => p.id === placement.id ? placement : p); this.hooks.edit(placement); }
      this.original = undefined; this.refreshOutline();
    });
    this.observer = new ResizeObserver(() => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    });
    this.observer.observe(host);
    host.addEventListener('pointerdown', this.pointerDown); host.addEventListener('pointerup', this.pointerUp); host.addEventListener('pointermove', this.pointerMove); host.addEventListener('contextmenu', this.contextMenu);
    window.addEventListener('keydown', this.keyDown); window.addEventListener('keyup', this.keyUp); window.addEventListener('blur', this.blur); document.addEventListener('pointerlockchange', this.lockChange);
    this.setMode(this.mode); this.renderer.setAnimationLoop(this.frame);
  }
  setCatalog(models: RoomModel[]) { for (const model of models) { this.profiles.set(model.id, model); this.bounds.set(model.id, model.bounds); } }
  async loadModels(models: RoomModel[]) {
    this.setCatalog(models);
    // Bound simultaneous decodes without limiting how many placements are retained.
    const queue = [...new Set(models.map(model => model.id))];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (let id; (id = queue.shift());) await this.ensureModel(id); }));
  }
  async ensureModel(id: string): Promise<void> {
    if (this.templates.has(id)) return;
    if (this.loading.has(id)) return this.loading.get(id)!;
    const profile = this.profiles.get(id);
    if (!profile) throw new Error('未找到此模型的尺寸资料。');
    const load = (async () => {
      const response = await fetch('/api/v1/files/' + encodeURIComponent(profile.modelFileId) + '/content', { headers: this.headers(), credentials: 'same-origin', signal: this.abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 404 ? '模型访问权限已失效，请重新进入小屋。' : '模型读取失败，请重试。');
      const manager = new T.LoadingManager();
      manager.setURLModifier(url => { if (url.startsWith('blob:') || url.startsWith('data:')) return url; throw new Error('模型包含外部资源。'); });
      const source = (await new GLTFLoader(manager).parseAsync(await response.arrayBuffer(), '')).scene;
      if (this.stopped) { disposeResources([source]); return; }
      enableMeshShadows(source);
      const translated = new T.Group(); translated.position.fromArray(profile.normalization.translation); translated.add(source);
      const normalized = new T.Group(); normalized.scale.setScalar(profile.normalization.scale); normalized.add(translated);
      const template = new T.Group(); template.add(normalized); this.templates.set(id, template);
    })();
    this.loading.set(id, load);
    try { await load; } finally { this.loading.delete(id); }
  }
  setPlacements(placements: RoomPlacement[]) {
    if (placements === this.input) return; this.input = placements; this.placements = structuredClone(placements);
    this.renderer.shadowMap.needsUpdate = true;
    const ids = new Set(placements.map(placement => placement.id));
    for (const [id, object] of this.instances) if (!ids.has(id)) { object.removeFromParent(); this.instances.delete(id); }
    for (const placement of placements) {
      let object = this.instances.get(placement.id);
      if (object && object.userData.assetId !== placement.assetId) { if (this.selected === placement.id) this.select(null); object.removeFromParent(); this.instances.delete(placement.id); object = undefined; }
      if (!object) {
        const template = this.templates.get(placement.assetId);
        if (!template) throw new Error('模型尚未载入，未隐藏或截断任何摆放。');
        object = template.clone(true); object.userData.placementId = placement.id; object.userData.assetId = placement.assetId;
        this.instances.set(placement.id, object); this.scene.add(object);
      }
      if (!(this.moving && this.selected === placement.id)) this.apply(object, placement);
    }
    if (this.selected && !ids.has(this.selected)) this.select(null);
    else if (!this.moving) this.select(this.selected);
    this.world = buildRoomWorld(this.placements, this.bounds);
    if (this.mode !== 'edit' && playerOverlaps(this.world.colliders, this.player)) this.home();
  }
  private apply(object: T.Group, placement: RoomPlacement) { object.position.fromArray(placement.position); object.rotation.set(...placement.rotation, 'XYZ'); object.scale.setScalar(placement.scale); object.updateMatrixWorld(true); this.renderer.shadowMap.needsUpdate = true; }
  private readPlacement(id: string): RoomPlacement { const placement = this.placements.find(p => p.id === id)!, object = this.instances.get(id)!; return { ...placement, position: object.position.toArray(), rotation: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.x }; }
  private refreshOutline() { const object = this.selected ? this.instances.get(this.selected) : undefined; if (object) this.outline.box.setFromObject(object); (this.outline.material as T.LineBasicMaterial).color.setHex(0xbe8c45); }
  select(id: string | null) { this.selected = id; const object = id ? this.instances.get(id) : undefined; if (object && this.mode === 'edit') { this.transform.attach(object); this.outline.visible = true; this.refreshOutline(); } else { this.transform.detach(); this.outline.visible = false; } this.hooks.select(id); }
  focus(id: string) { this.select(id); const object = this.instances.get(id); if (object && this.mode === 'edit') { const center = new T.Box3().setFromObject(object).getCenter(new T.Vector3()); this.orbit.target.copy(center); this.camera.position.copy(center).add(new T.Vector3(4, 4, 5)); this.orbit.update(); } }
  setTool(tool: RoomTool) { this.transform.setMode(tool); this.transform.setSpace(tool === 'scale' ? 'local' : 'world'); }
  home() {
    this.blur(); this.yaw = 0; this.pitch = 0;
    if (this.mode === 'edit') {
      this.camera.position.set(14, 8, 19); this.orbit.target.set(0, 1.15, 0); this.orbit.update();
    } else {
      this.player = roomEntrance(this.world);
      this.placeVisitCamera();
      this.camera.rotation.set(0, 0, 0, 'YXZ');
    }
  }
  private placeVisitCamera() {
    this.camera.position.set(this.player.x, this.player.y + ROOM_EYE_HEIGHT, this.player.z);
  }
  setMode(mode: RoomMode) { if (this.moving || (this.readOnly && mode === 'edit')) return; this.mode = mode; this.keys.clear(); this.looking = false; if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock(); this.roof.visible = mode !== 'edit'; this.renderer.shadowMap.needsUpdate = true; this.orbit.enabled = mode === 'edit'; this.transform.enabled = mode === 'edit'; this.select(mode === 'edit' ? this.selected : null); this.home(); }
  private pointerDown = (event: PointerEvent) => { this.down = [event.clientX, event.clientY]; if (this.mode !== 'edit' && event.button === 0) { this.looking = true; this.renderer.domElement.focus(); void this.renderer.domElement.requestPointerLock?.().catch(() => {}); } };
  private pointerUp = (event: PointerEvent) => {
    this.looking = false;
    if (this.mode !== 'edit' || this.transform.dragging || this.original || Math.hypot(event.clientX - this.down[0], event.clientY - this.down[1]) > 5 || this.transform.axis) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.raycaster.setFromCamera(new T.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    let object: T.Object3D | null = this.raycaster.intersectObjects([...this.instances.values()], true)[0]?.object ?? null;
    while (object && !object.userData.placementId) object = object.parent; this.select(object?.userData.placementId ?? null);
  };
  private pointerMove = (event: PointerEvent) => { if (this.mode === 'edit' || (!this.looking && document.pointerLockElement !== this.renderer.domElement)) return; this.yaw -= event.movementX * .002; this.pitch = T.MathUtils.clamp(this.pitch - event.movementY * .002, -1.3, 1.3); this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ'); };
  private contextMenu = (event: Event) => event.preventDefault();
  private keyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement)?.closest('input,textarea,button,select,[role="dialog"]')) return;
    if (event.key === 'Escape') { this.blur(); if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock(); return; }
    if (this.mode === 'edit' || event.metaKey || event.ctrlKey || event.altKey || document.pointerLockElement !== this.renderer.domElement) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) this.jumpQueued = true;
    } else if (event.code in MOVE_KEYS) {
      event.preventDefault(); this.keys.add(event.code);
    }
  };
  private keyUp = (event: KeyboardEvent) => { this.keys.delete(event.code); if (event.key === 'Meta') this.blur(); };
  private blur = () => { this.keys.clear(); this.jumpQueued = false; this.looking = false; };
  private lockChange = () => { if (document.pointerLockElement !== this.renderer.domElement) this.blur(); };
  private frame = (now: number) => {
    if (this.stopped) return; const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, .25) : 0; this.lastTime = now;
    if (this.mode === 'edit') this.orbit.update();
    else if (this.keys.size || this.jumpQueued || this.player.velocityY !== null) {
      let forward = 0, right = 0;
      for (const key of this.keys) { forward += MOVE_KEYS[key][0]; right += MOVE_KEYS[key][1]; }
      this.player = stepFirstPerson(this.world, this.player, { forward, right, run: false }, this.yaw, dt, this.jumpQueued);
      this.jumpQueued = false;
      this.placeVisitCamera();
    }
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  };
  debugTransform(id: string, patch: Partial<RoomPlacement>) { if (this.readOnly || this.mode !== 'edit') return '参观模式不允许编辑'; const original = this.placements.find(p => p.id === id); if (!original) throw new Error('Unknown placement'); const placement = { ...original, ...patch }, error = validateRoomLayout('检查', [placement], this.bounds); if (error) return error; this.placements = this.placements.map(p => p.id === id ? placement : p); this.apply(this.instances.get(id)!, placement); this.hooks.edit(placement); this.refreshOutline(); return null; }
  debug() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (value: T.Vector3) => { value.project(this.camera); return { x: rect.left + (value.x + 1) * rect.width / 2, y: rect.top + (1 - value.y) * rect.height / 2 }; };
    const object = this.selected ? this.instances.get(this.selected) : null;
    return { mode: this.mode, placements: structuredClone(this.placements), selected: this.selected, moving: this.moving, camera: this.camera.position.toArray(), airborne: this.player.velocityY !== null, keys: [...this.keys], models: this.templates.size, instances: this.instances.size, axis: this.transform.axis, orbitEnabled: this.orbit.enabled,
      point: object ? project(object.position.clone()) : null,
      axes: object ? [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)].map(axis => project(axis.add(object.position))) : [],
      assetBounds: Object.fromEntries([...this.templates].map(([id, template]) => { const bounds = new T.Box3().setFromObject(template); return [id, { min: bounds.min.toArray(), max: bounds.max.toArray() }]; })) };
  }
  dispose() {
    if (this.stopped) return; this.stopped = true; this.abort.abort(); this.renderer.setAnimationLoop(null); this.observer.disconnect(); this.blur(); if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    this.host.removeEventListener('pointerdown', this.pointerDown); this.host.removeEventListener('pointerup', this.pointerUp); this.host.removeEventListener('pointermove', this.pointerMove); this.host.removeEventListener('contextmenu', this.contextMenu);
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.blur); document.removeEventListener('pointerlockchange', this.lockChange);
    this.transform.detach(); this.transform.dispose(); this.orbit.dispose(); disposeResources([this.scene, ...this.templates.values()]); this.environment.dispose(); this.sun.shadow.dispose(); this.renderer.renderLists.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); this.templates.clear(); this.instances.clear();
  }
}
