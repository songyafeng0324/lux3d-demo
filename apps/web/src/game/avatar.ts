import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import shinChan from '../../../../assets/characters/runtime/shin-chan.glb?url';
import humanoidTabby from '../../../../assets/characters/runtime/humanoid-tabby.glb?url';
import maruko from '../../../../assets/characters/runtime/maruko-tpose.glb?url';
import bull from '../../../../assets/characters/runtime/bull-tpose.glb?url';
import whiteShirtBoy from '../../../../assets/characters/runtime/white-shirt-boy.glb?url';
import pinkShortsGirl from '../../../../assets/characters/runtime/pink-shorts-girl.glb?url';
import type { CharacterId } from './avatar-prefs.js';
import { turnToward } from './follow-camera.js';
import { disposeResources } from '../scene/assets.js';

/** Runtime copies built by scripts/build-characters.mjs (1024px textures, unreferenced data dropped). */
const URLS: Record<CharacterId, string> = {
  'shin-chan': shinChan, 'humanoid-tabby': humanoidTabby, 'maruko-tpose': maruko,
  'bull-tpose': bull, 'white-shirt-boy': whiteShirtBoy, 'pink-shorts-girl': pinkShortsGirl,
};
/** Every character is scaled to this standing height so the camera and nav body fit all six. */
export const AVATAR_HEIGHT = 1.5;
/** Ground speed at which the in-place Run clip plays at 1×. */
const RUN_REFERENCE = 3.6;
const MOVING = 0.35;

const downloads = new Map<CharacterId, Promise<ArrayBuffer>>();
function download(id: CharacterId): Promise<ArrayBuffer> {
  let pending = downloads.get(id);
  if (!pending) {
    pending = fetch(URLS[id]).then(r => { if (!r.ok) throw new Error(`角色模型读取失败（HTTP ${r.status}）`); return r.arrayBuffer(); });
    pending.catch(() => downloads.delete(id));
    downloads.set(id, pending);
  }
  return pending;
}

/** disposeResources() frees geometry/materials/textures; skinned meshes also own a bone texture. */
function disposeAvatar(root: T.Object3D) {
  const skeletons = new Set<T.Skeleton>();
  root.traverse(o => { const mesh = o as T.SkinnedMesh; if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton); });
  skeletons.forEach(s => s.dispose());
  disposeResources([root]);
}

function blobShadow(): T.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!, grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(0.55, 'rgba(0,0,0,0.28)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const material = new T.MeshBasicMaterial({ map: new T.CanvasTexture(canvas), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new T.Mesh(new T.PlaneGeometry(0.9, 0.9), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.name = 'avatar-blob-shadow';
  return mesh;
}

export interface AvatarFrame {
  feet: { x: number; y: number; z: number };
  /** Support height under the feet (for the soft shadow while airborne); null = none. */
  ground: number | null;
  /** Horizontal velocity actually achieved this frame (m/s). */
  velocity: [number, number];
  visible: boolean;
}

/**
 * The visible player character: one skinned GLB with Idle/Run, a soft blob shadow
 * (the scenes' shadow maps are static, so the avatar does not cast into them),
 * facing that follows the achieved movement direction.
 */
export class AvatarRig {
  readonly root = new T.Group();
  private shadow = blobShadow();
  private model: T.Object3D | null = null;
  private mixer: T.AnimationMixer | null = null;
  private idle: T.AnimationAction | null = null;
  private run: T.AnimationAction | null = null;
  private active: T.AnimationAction | null = null;
  private facing = 0;
  private speed = 0;
  private token = 0;
  private pending: Promise<void> | null = null;
  private pendingId: CharacterId | null = null;
  private disposed = false;
  character: CharacterId | null = null;
  loaded = false;

  constructor(scene: T.Scene) {
    this.root.name = 'player-avatar';
    this.root.visible = false;
    this.shadow.visible = false;
    scene.add(this.root, this.shadow);
  }

  /** Swap the character; resolves when it is shown (or rejects with a user-facing message). */
  setCharacter(id: CharacterId): Promise<void> {
    if (id === this.pendingId && this.pending) return this.pending;
    if (id === this.character && this.loaded) {
      // Back to the shown character while another loads: cancel that load so it cannot swap in later.
      this.token++; this.pending = null; this.pendingId = null;
      return Promise.resolve();
    }
    const token = ++this.token;
    this.pendingId = id;
    const pending = this.pending = this.load(id, token)
      // A load superseded by a later choice neither shows nor reports its failure.
      .catch(error => { if (token === this.token) throw error; })
      .finally(() => { if (token === this.token) { this.pending = null; this.pendingId = null; } });
    return pending;
  }

  private async load(id: CharacterId, token: number): Promise<void> {
    const gltf = await new GLTFLoader().parseAsync(await download(id), '');
    if (this.disposed || token !== this.token) { disposeResources([gltf.scene]); return; }
    const clip = (name: string) => gltf.animations.find(a => a.name === name) ?? null;
    const idleClip = clip('Idle'), runClip = clip('Run');
    if (!idleClip || !runClip) { disposeResources([gltf.scene]); throw new Error('角色模型缺少 Idle 或 Run 动画'); }

    const model = gltf.scene, mixer = new T.AnimationMixer(model);
    const idle = mixer.clipAction(idleClip), run = mixer.clipAction(runClip);
    idle.play(); mixer.update(0);
    model.traverse(o => {
      const mesh = o as T.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = false;
    });
    // Normalise from the posed (skinned) bounds: feet at y=0, centred, AVATAR_HEIGHT tall.
    model.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(model, true), size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
    const holder = new T.Group();
    holder.scale.setScalar(AVATAR_HEIGHT / Math.max(size.y, 1e-6));
    model.position.set(-center.x, -box.min.y, -center.z);
    holder.add(model);

    const old = this.model, oldMixer = this.mixer;
    this.root.clear(); this.root.add(holder);
    this.model = holder; this.mixer = mixer; this.idle = idle; this.run = run; this.active = idle;
    if (oldMixer) oldMixer.stopAllAction();
    if (old) disposeAvatar(old);
    this.character = id;
    this.loaded = true;
  }

  update(dt: number, frame: AvatarFrame) {
    const { feet, ground, velocity, visible } = frame;
    const show = visible && this.loaded;
    this.root.visible = show;
    this.shadow.visible = show && ground !== null;
    if (!this.mixer || !show) return; // hidden (first person, edit mode, camera at the wall): no animation work
    this.root.position.set(feet.x, feet.y, feet.z);
    const speed = Math.hypot(velocity[0], velocity[1]);
    // Smooth the measured speed so 1-frame stalls (substep slides, frame jitter) do not flicker the clip.
    this.speed += (speed - this.speed) * (1 - Math.exp(-dt * 12));
    if (speed > MOVING) this.facing = turnToward(this.facing, Math.atan2(velocity[0], velocity[1]), 12, dt);
    this.root.rotation.y = this.facing;
    const next = this.speed > MOVING ? this.run! : this.idle!;
    if (next !== this.active) {
      next.reset().play();
      this.active!.crossFadeTo(next, 0.18, false);
      this.active = next;
    }
    this.run!.timeScale = Math.min(2.5, Math.max(0.6, this.speed / RUN_REFERENCE));
    this.mixer.update(dt);
    if (ground !== null) {
      const height = Math.max(0, feet.y - ground);
      this.shadow.position.set(feet.x, ground + 0.015, feet.z);
      this.shadow.scale.setScalar(Math.max(0.5, 1 - height * 0.35));
      (this.shadow.material as T.MeshBasicMaterial).opacity = Math.max(0.25, 1 - height * 0.6);
    }
  }

  /** Face a direction immediately (spawn / return to entry). */
  face(yaw: number) { this.facing = yaw; this.root.rotation.y = yaw; }

  debug() {
    return { character: this.character, loaded: this.loaded, visible: this.root.visible, facing: this.facing, speed: this.speed,
      clip: this.active === this.run ? 'Run' : this.active ? 'Idle' : null,
      bounds: this.model ? (b => [b.min.toArray(), b.max.toArray()])(new T.Box3().setFromObject(this.root, true)) : null };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.token++;
    this.mixer?.stopAllAction();
    disposeAvatar(this.root);
    disposeResources([this.shadow]);
    this.root.removeFromParent(); this.shadow.removeFromParent();
  }
}
