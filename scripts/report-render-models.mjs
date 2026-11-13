// 项目报告书素材：把 Lux3D 生成的 GLB 渲染成 PNG（与参考图并排对比用）。
// 用法：node scripts/report-render-models.mjs   （CHROME_CHANNEL=chrome，默认用本机 Chrome）
// 输入清单写在下方 JOBS；输出到 docs/report/assets/models/<id>.png（600×600，浅灰渐变底）。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const sharp = createRequire(path.resolve('packages/domain/package.json'))('sharp');
const ROOT = path.resolve('.');
const OUT = path.resolve('docs/report/assets/models');
const THREE = path.resolve('node_modules/three');
const SIZE = 600;

const t17 = ['八仙桌', '圈椅', '博古架', '四扇屏风', '落地宫灯', '铜香炉', '荷花缸', '太湖石', '松树盆景', '高花几'];
const JOBS = [
  ...t17.map((n, i) => ({ id: `t17-${String(i + 1).padStart(2, '0')}`, glb: `assets/furniture/references/t17-models/assets/t17-${String(i + 1).padStart(2, '0')}-turbo/glb.glb`, yaw: 0.6 })),
  ...['B1-stone-lion', 'B2-stone-lamp', 'B3-incense-burner', 'B4-vase', 'B5-jade-bi', 'B6-bronze-jue', 'B7-ruyi', 'B8-book-box', 'B9-jade-mountain'].map(k => ({ id: k, glb: `assets/t16/props/source/${k}.glb`, yaw: 0.5 })),
];

const PAGE = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const px = ${SIZE};
const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(px, px);
renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
document.body.append(renderer.domElement);
// 径向渐变背景
const bg = document.createElement('canvas'); bg.width = bg.height = 256;
const g = bg.getContext('2d'); const gr = g.createRadialGradient(128, 110, 10, 128, 128, 190);
gr.addColorStop(0, '#f4f1ea'); gr.addColorStop(1, '#cfc9bd'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
const bgTex = new T.CanvasTexture(bg); bgTex.colorSpace = T.SRGBColorSpace;
window.render = async (url, yaw) => {
  const scene = new T.Scene(); scene.background = bgTex;
  scene.add(new T.HemisphereLight(0xffffff, 0x8a8072, 1.5));
  const key = new T.DirectionalLight(0xffffff, 2.6); key.position.set(3, 4, 5); scene.add(key);
  const fill = new T.DirectionalLight(0xfff0dd, 1.0); fill.position.set(-4, 2, 2); scene.add(fill);
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene; model.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(model), size = box.getSize(new T.Vector3()), c = box.getCenter(new T.Vector3());
  const holder = new T.Group(); holder.rotation.y = yaw;
  model.position.sub(c); holder.add(model); scene.add(holder);
  const r = Math.max(size.y, Math.hypot(size.x, size.z) * 0.9);
  const camera = new T.PerspectiveCamera(30, 1, 0.01, 100);
  camera.position.set(0, r * 0.35, r * 2.35); camera.lookAt(0, 0, 0);
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
    const [root, rel] = url.startsWith('/three/') ? [THREE, url.slice(7)] : url.startsWith('/file/') ? [ROOT, url.slice(6)] : [null, null];
    const file = root && path.resolve(root, rel);
    if (!file || !file.startsWith(root + path.sep)) throw new Error('outside');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const channel = process.env.CHROME_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready);
  await fs.mkdir(OUT, { recursive: true });
  for (const job of JOBS) {
    const data = await page.evaluate(([u, y]) => window.render(u, y), ['/file/' + job.glb, job.yaw]);
    const out = path.join(OUT, job.id + '.png');
    await sharp(Buffer.from(data.split(',')[1], 'base64')).png().toFile(out);
    console.log(job.id, (await fs.stat(out)).size, 'bytes');
  }
} finally { await browser.close(); server.close(); }
