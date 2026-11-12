// First-screen download budget for the pavilion home page (`/`), measured on the production build.
// Serves apps/web/dist from a throwaway local static server that compresses like the production Nginx
// (gzip level 1 for everything except PNG/JPEG/WebP; SPA fallback; /api answers 404 so the page runs
// without a database, like a visitor whose gallery cannot be read yet), opens it in
// real Chrome and splits every request by when it started: before the intro screen (「进入藏宝阁」)
// appeared = the first screen, while the intro was showing, and after entering.
// Usage (repo root, after `npm run build`): node scripts/first-screen-bytes.mjs [--throttle-mbps=10] [--out=path.json]
//   CHROME_CHANNEL=chrome (set empty to use Playwright's Chromium)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// DIST=<dir> measures another build (e.g. an older commit's apps/web/dist) with the same server.
const ROOT = process.env.DIST ? path.resolve(process.env.DIST) + path.sep : fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const MBPS = Number(arg('throttle-mbps') ?? 0);
const OUT = arg('out');
// --shots=<dir>: no byte count; screenshots of the intro camera on arrival and (new build) once the full-size
// textures are in, to compare previews, the final look and an older build at the same view.
const SHOTS = arg('shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml' };

const RAW = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"NOT_FOUND"}}'); return; }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try { if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { file = path.join(ROOT, 'index.html'); }
  const raw = await fs.readFile(file), ext = path.extname(file);
  RAW.set(url.pathname, raw.length);
  const gzip = !['.png', '.jpg', '.webp', '.avif'].includes(ext) && /gzip/.test(req.headers['accept-encoding'] ?? '');
  const body = gzip ? zlib.gzipSync(raw, { level: 1 }) : raw;
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'content-length': body.length, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const channel = process.env.CHROME_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), args: ['--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (MBPS) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: MBPS * 1e6 / 8, uploadThroughput: 2e6 / 8 });
  }
  // Each resource is classed by when it STARTED (Resource Timing): before the intro screen appeared, while it
  // was showing, or after the click on 「进入藏宝阁」. transferSize is what crossed the wire (gzip included).
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(2000);
    new MutationObserver((_, observer) => {
      if (![...document.querySelectorAll('button')].some(b => b.textContent === '进入藏宝阁')) return;
      window.__introAt = performance.now(); observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(base + '/');
  await page.waitForFunction(() => ['intro', 'failed'].includes(window.__t10?.ui().phase), null, { timeout: 600000, polling: 100 });
  if (SHOTS) {
    await fs.mkdir(SHOTS, { recursive: true });
    const hide = () => page.addStyleTag({ content: '.t10-screen{display:none!important}' });   // the veil, not the hall
    await hide(); await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, 'intro-on-arrival.png') });
    const done = await page.waitForFunction(() => window.__t10.engine.debugState().detailDone !== false, null, { timeout: 120000, polling: 250 }).then(() => true, () => false);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, 'intro-full-detail.png') });
    console.log(`shots in ${SHOTS}; detail done: ${done}`);
    process.exitCode = done ? 0 : 1;
  } else {
    const phase = await page.evaluate(() => window.__t10.ui().phase);
    await page.waitForTimeout(500);
    const enterAt = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: '进入藏宝阁' }).click();
    // The old build has no detailDone flag (everything loaded before the intro): give it the fixed wait.
    await page.waitForFunction(() => window.__t10.engine.debugState().detailDone !== false, null, { timeout: 600000, polling: 250 }).catch(() => {});
    await page.waitForTimeout(MBPS ? 5000 : 1500);
    const { introAt, entries } = await page.evaluate(() => ({
      introAt: window.__introAt,
      entries: performance.getEntriesByType('resource').map(e => ({ url: e.name, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, decoded: e.decodedBodySize })),
    }));
    const rows = entries.filter(e => e.url.startsWith('http')).map(e => {
      const u = new URL(e.url);
      return { stage: e.start < introAt ? 'first-screen' : e.start < enterAt ? 'behind-intro' : 'after-enter', path: u.pathname, bytes: e.transfer, raw: RAW.get(u.pathname) ?? e.decoded, startMs: Math.round(e.start), endMs: Math.round(e.end) };
    });
    const sum = (s, k = 'bytes') => rows.filter(r => r.stage === s).reduce((a, r) => a + r[k], 0);
    const count = s => rows.filter(r => r.stage === s).length;
    const stages = Object.fromEntries(['first-screen', 'behind-intro', 'after-enter'].map(s => [s, { requests: count(s), bytes: sum(s), raw: sum(s, 'raw') }]));
    const result = {
      measured: new Date().toISOString(), browser: browser.version(), throttleMbps: MBPS || null, phase, introMs: Math.round(introAt),
      // bytes = transferred (gzip where Nginx would), raw = file size on disk
      stages, requests: rows.sort((a, b) => b.bytes - a.bytes),
    };
    const mb = n => (n / 1e6).toFixed(2) + ' MB';
    console.log(`phase=${phase}; intro screen at ${Math.round(introAt)} ms${MBPS ? ` (${MBPS} Mbit/s, 60 ms latency)` : ''}`);
    for (const [s, v] of Object.entries(stages)) console.log(`${s.padEnd(13)} ${mb(v.bytes)} transferred (${mb(v.raw)} raw) in ${v.requests} requests`);
    for (const r of result.requests) console.log(`${r.stage.padEnd(13)} ${(r.bytes / 1e3).toFixed(1).padStart(10)} kB ${(r.raw / 1e3).toFixed(1).padStart(10)} kB raw ${String(r.startMs).padStart(7)}-${String(r.endMs).padEnd(7)} ms  ${r.path}`);
    if (OUT) await fs.writeFile(OUT, JSON.stringify(result, null, 2) + '\n');
  }
} finally {
  await browser.close();
  server.close();
}
