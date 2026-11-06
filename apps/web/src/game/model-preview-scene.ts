import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fileUrl } from './backpack-api.js';

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

export function framePreview(model: T.Object3D, camera: T.PerspectiveCamera) {
  const bounds = new T.Box3().setFromObject(model);
  if (bounds.isEmpty()) throw new Error('模型没有可显示的几何。');
  const size = bounds.getSize(new T.Vector3());
  const radius = Math.max(size.x, size.y, size.z);
  if (!(radius > 0 && Number.isFinite(radius))) throw new Error('模型尺寸无效。');
  model.position.sub(bounds.getCenter(new T.Vector3()));
  camera.near = radius / 1000;
  camera.far = radius * 100;
  camera.position.set(radius * 1.7, radius * .9, radius * 2.3);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  return radius;
}

export async function readPreviewModel(fileId: string, options: RequestInit, message: string) {
  const response = await fetch(fileUrl(fileId), { credentials: 'same-origin', ...options });
  if (!response.ok) throw new Error(message);
  const bytes = await response.arrayBuffer();
  options.signal?.throwIfAborted();
  const manager = new T.LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    throw new Error('模型包含外部资源。');
  });
  return (await new GLTFLoader(manager).parseAsync(bytes, '')).scene;
}
