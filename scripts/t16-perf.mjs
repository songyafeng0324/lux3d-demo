// T16 D4: frame-time bench of the pavilion with Chrome's 60 Hz cap lifted, so the numbers show the real
// headroom rather than vsync. Fixed viewpoints, bloom on and off, MacBook-sized viewport at DPR 2 with the
// pixel ratio pinned at the 1.5 cap (adaptive resolution off), then one adaptive run at the entry. Evidence only, no thresholds. Usage (dev server running): node scripts/t16-perf.mjs
// Two clocks per view: `median`/`p95` are rAF intervals (what a player sees, but other GPU work on the Mac,
// such as another Chrome window, leaks into them); `gpu` is bloom + main render timed to gl.finish(), the
// steadier number for comparing builds. Compare builds by alternating runs, not one run each.
// Env: T10_BASE, T16_PERF_DPR (default 2), T16_PERF_MS (sample length per view, default 3000), T16_PERF_OUT
// (JSON file), T16_PERF_QUICK=1 (bloom on only, no adaptive run).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const BASE = process.env.T10_BASE || 'http://localhost:5173';
const DPR = Number(process.env.T16_PERF_DPR ?? 2), SAMPLE = Number(process.env.T16_PERF_MS ?? 3000), QUICK = !!process.env.T16_PERF_QUICK;
const browser = await chromium.launch({
  headless: true, channel: process.env.CHROME_CHANNEL ?? 'chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--use-angle=metal', '--enable-gpu',
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: DPR });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const t0 = Date.now();
await page.goto(BASE + '/');
await page.waitForFunction(() => ['intro', 'failed'].includes(window.__t10?.ui().phase), null, { timeout: 120000 });
const loadMs = Date.now() - t0;
await page.getByRole('button', { name: '进入藏宝阁' }).click();
await page.waitForFunction(n => window.__t10.ui().exhibits >= n, 1, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
const gpu = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
const VIEWS = [
  ['entry', 0, 24, 0, 0, 0.12, 'third'],
  ['atrium-up', 3, 7, 0, 0.3, 0.75, 'first'],
  ['upper-east', 15, 2, 9, 1.35, -0.12, 'third'],
  ['grand-stair', 0, -11, 0, 0, 0.18, 'third'],
  ['side-hall', -14, 20, 0, 0, 0.05, 'first'],
  ['exterior', 0, 26, 0, Math.PI, 0.02, 'third'],
];
// Time each frame's bloom + main render up to gl.finish() (adds a sync per frame; only for this bench).
await page.evaluate(() => {
  const e = window.__t10.engine, gl = e.renderer.getContext(), bloom = e.renderBloom.bind(e), main = e.composer.render.bind(e.composer);
  let t = 0; window.__gpu = [];
  e.renderBloom = dt => { gl.finish(); t = performance.now(); bloom(dt); };
  e.composer.render = dt => { main(dt); gl.finish(); window.__gpu.push(performance.now() - t); };
});
const sample = ms => page.evaluate(ms => new Promise(r => {
  const a = []; let last = performance.now(); const end = last + ms; window.__gpu.length = 0;
  const f = n => { a.push(n - last); last = n; n < end ? requestAnimationFrame(f) : r([a.slice(3).sort((x, y) => x - y), window.__gpu.slice(3).sort((x, y) => x - y)]); };
  requestAnimationFrame(f);
}), ms);
const q = (a, p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 100) / 100;
await page.evaluate(() => window.__t10.engine.debugResolution?.(1.5));   // engines before D4 had no adaptive resolution
const out = [];
for (const [name, x, z, y, yaw, pitch, view] of VIEWS) {
  const row = { name };
  for (const bloom of QUICK ? [true] : [true, false]) {
    await page.evaluate(([x, z, y, yaw, pitch, view, bloom]) => { const e = window.__t10.engine; e.setView(view); e.debugPlace(x, z, y, yaw, pitch); e.bloom.enabled = bloom; }, [x, z, y, yaw, pitch, view, bloom]);
    await page.waitForTimeout(500);
    const [a, g] = await sample(SAMPLE);
    const s = await page.evaluate(() => (({ calls, triangles, pixelRatio }) => ({ calls, triangles, pixelRatio }))(window.__t10.engine.debugState()));
    row[bloom ? 'bloom' : 'noBloom'] = { median: q(a, 0.5), p95: q(a, 0.95), fps: Math.round(1000 / q(a, 0.5)), gpu: q(g, 0.5), gpuP95: q(g, 0.95), frames: a.length, ...s };
  }
  out.push(row);
}
let adaptiveRow = null;
if (!QUICK) {
  await page.evaluate(() => { const e = window.__t10.engine; e.bloom.enabled = true; e.setView('third'); e.debugPlace(0, 24, 0, 0, 0.12); e.debugResolution(null); });
  // rAF timing is meaningless while the pixel ratio moves (each change reallocates the targets), so this
  // run reads the engine's own one-second frame count, once a second for 10 s, after it settles.
  await page.waitForTimeout(8000);
  const ticks = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(1000); ticks.push(await page.evaluate(() => (({ fps, pixelRatio }) => ({ fps, pixelRatio }))(window.__t10.engine.debugState()))); }
  const fps = ticks.map(t => t.fps).sort((a, b) => a - b);
  adaptiveRow = { fpsMedian: fps[5], fpsMin: fps[0], pixelRatios: [...new Set(ticks.map(t => t.pixelRatio))], ticks };
}
const memory = await page.evaluate(() => { const i = window.__t10.engine.renderer.info; return { geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length }; });
const result = { date: new Date().toISOString(), gpu, dpr: DPR, viewport: [1512, 945], loadMs, memory, errors, views: out, adaptiveEntry: adaptiveRow };
console.log(JSON.stringify(result, null, 1));
if (process.env.T16_PERF_OUT) await fs.writeFile(process.env.T16_PERF_OUT, JSON.stringify(result, null, 1) + '\n');
await browser.close();
