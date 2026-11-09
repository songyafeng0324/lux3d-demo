// T15: render the character-picker thumbnails from the runtime GLBs (same model the scene loads),
// so every card matches what the player will see. Headless Chrome, transparent background,
// Idle pose, three-quarter front view; written as 256px WebP next to the runtime GLBs.
// Usage (after build-characters): node scripts/render-character-thumbs.mjs   CHROME_CHANNEL=chrome
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const sharp = createRequire(path.resolve('packages/domain/package.json'))('sharp');
const RUNTIME = path.resolve('assets/characters/runtime');
const OUT = path.join(RUNTIME, 'thumbs');
const THREE = path.resolve('node_modules/three');
const SIZE = 256;
const manifest = JSON.parse(await fs.readFile(path.join(RUNTIME, 'manifest.json'), 'utf8'));

const PAGE = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const px = ${SIZE * 2};
const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(px, px); renderer.setClearColor(0, 0);
renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
document.body.append(renderer.domElement);
window.render = async (file) => {
  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xfff4e0, 0x3a2a1e, 1.6));
  const key = new T.DirectionalLight(0xffffff, 2.4); key.position.set(2, 3, 4); scene.add(key);
  const rim = new T.DirectionalLight(0xffe2b0, 1.2); rim.position.set(-3, 2, -2); scene.add(rim);
  const gltf = await new GLTFLoader().loadAsync('/glb/' + file);
  const model = gltf.scene, mixer = new T.AnimationMixer(model);
  const idle = gltf.animations.find(a => a.name === 'Idle');
  mixer.clipAction(idle).play(); mixer.update(0.4);
  model.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(model, true), size = box.getSize(new T.Vector3()), c = box.getCenter(new T.Vector3());
  const holder = new T.Group(); holder.scale.setScalar(1.5 / size.y);
  model.position.set(-c.x, -box.min.y, -c.z); holder.add(model); holder.rotation.y = 0.42; scene.add(holder);
  const camera = new T.PerspectiveCamera(26, 1, 0.05, 50);
  camera.position.set(0, 0.95, 3.75); camera.lookAt(0, 0.74, 0);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.ready = true;
</script>`;

const types = { '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    const [root, rel] = url.startsWith('/three/') ? [THREE, url.slice(7)] : url.startsWith('/glb/') ? [RUNTIME, url.slice(5)] : [null, null];
    const file = root && path.resolve(root, rel);
    if (!file || !file.startsWith(root + path.sep)) throw new Error('outside');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const channel = process.env.CHROME_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: SIZE * 2, height: SIZE * 2 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready);
  await fs.mkdir(OUT, { recursive: true });
  for (const item of manifest.items) {
    const data = await page.evaluate(file => window.render(file), item.file);
    const out = path.join(OUT, item.id + '.webp');
    await sharp(Buffer.from(data.split(',')[1], 'base64')).resize(SIZE, SIZE).webp({ quality: 86, alphaQuality: 90 }).toFile(out);
    console.log(item.id, (await fs.stat(out)).size, 'bytes');
  }
} finally { await browser.close(); server.close(); }
