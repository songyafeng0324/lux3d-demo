import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MODEL_CACHE, modelUrl } from './backpack-api.js';

export function previewScene() {
  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xfff5e4, 0x6d7880, 2.8));
  const key = new T.DirectionalLight(0xffefda, 3.5);
  key.position.set(4, 6, 5);
  scene.add(key);
  const fill = new T.DirectionalLight(0xdbe6ff, 2);
  fill.position.set(-3, 2, -3);
  scene.add(fill);
  return scene;
}

export function configurePreview(renderer: T.WebGLRenderer) {
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
}

const VIEW = new T.Vector3(1.7, .9, 2.3).normalize();

/**
 * Centres the model and aims the camera at it from the three-quarter view.
 * Without `fill` the camera stands well back (interactive preview, room to orbit). With `fill`
 * (0–1) the camera moves in until the model's projected bounding box spans that share of the
 * frame's width or height, whichever binds first — thumbnails use this so flat or long items
 * still read as the main subject.
 */
export function framePreview(model: T.Object3D, camera: T.PerspectiveCamera, fill?: number) {
  const bounds = new T.Box3().setFromObject(model);
  if (bounds.isEmpty()) throw new Error('模型没有可显示的几何。');
  const size = bounds.getSize(new T.Vector3());
  const radius = Math.max(size.x, size.y, size.z);
  if (!(radius > 0 && Number.isFinite(radius))) throw new Error('模型尺寸无效。');
  model.position.sub(bounds.getCenter(new T.Vector3()));
  let distance = radius * Math.hypot(1.7, .9, 2.3);
  if (fill) distance = fitDistance(size, camera, fill);
  camera.near = Math.max(distance / 1000, radius / 1000);
  camera.far = distance + radius * 100;
  camera.position.copy(VIEW).multiplyScalar(distance);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  return radius;
}

/** Smallest camera distance along VIEW at which every corner of the centred box lies inside `fill` of the frame. */
export function fitDistance(size: T.Vector3, camera: Pick<T.PerspectiveCamera, 'fov' | 'aspect'>, fill: number) {
  const tanV = Math.tan(T.MathUtils.degToRad(camera.fov) / 2) * fill, tanH = tanV * camera.aspect;
  const up = new T.Vector3(0, 1, 0), right = new T.Vector3().crossVectors(up, VIEW).normalize(), trueUp = new T.Vector3().crossVectors(VIEW, right);
  const corner = new T.Vector3();
  let distance = 0;
  for (const sx of [-.5, .5]) for (const sy of [-.5, .5]) for (const sz of [-.5, .5]) {
    corner.set(sx * size.x, sy * size.y, sz * size.z);
    const depth = corner.dot(VIEW);
    distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanH, depth + Math.abs(corner.dot(trueUp)) / tanV);
  }
  return distance;
}

export async function readPreviewModel(fileId: string, options: RequestInit, message: string) {
  const response = await fetch(modelUrl(fileId), { credentials: 'same-origin', ...options, cache: MODEL_CACHE });
  if (!response.ok) throw new Error(message);
  const bytes = await response.arrayBuffer();
  options.signal?.throwIfAborted();
  return parsePreviewModel(bytes);
}

/** Parses a self-contained GLB (no external resources): a model from the server (its web copy is meshopt-compressed) or a local file before upload. */
export async function parsePreviewModel(bytes: ArrayBuffer) {
  const manager = new T.LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    throw new Error('模型包含外部资源。');
  });
  return (await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '')).scene;
}
