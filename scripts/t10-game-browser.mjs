// T10-C real-browser check: full-viewport game page, real keyboard walk up and back
// down the stairs, nav-vs-GLB surface probe, input exclusion, E detail, failure screen.
// Usage (repo root, `npm run dev` running): node scripts/t10-game-browser.mjs
//   T10_BASE=http://localhost:5173  CHROME_CHANNEL=chrome (set empty to use Playwright's Chromium)
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.T10_BASE || 'http://localhost:5173';
const OUT = process.env.T10_EVIDENCE_DIR
  ? pathToFileURL(resolve(process.env.T10_EVIDENCE_DIR) + sep)
  : new URL('../docs/validation/evidence/t10-c/', import.meta.url);
await fs.mkdir(OUT, { recursive: true });
const channel = process.env.CHROME_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader'] });
const [VW, VH] = (process.env.T10_VIEWPORT || '1440x900').split('x').map(Number);
const results = { scope: 'T10-C game front: walking/collision/HUD on the T10-B frame; no business features', base: BASE, browser: browser.version(), viewport: { width: VW, height: VH }, dpr: 1, started: new Date().toISOString() };
let frameMs = 16, ARRIVE = 0.3;
const shot = (page, name) => page.screenshot({ path: new URL(name, OUT).pathname });
const st = page => page.evaluate(() => ({ ...window.__t10.engine.debugState(), ui: window.__t10.ui() }));

const ROUTE = [
  [0, 0, 9], [8, 0, 9], [8, 0, -5.9], [1.5, 0, -5.9], [1.5, 0, -6.7], [1.5, 2.4, -11.5], [1.5, 2.4, -12.25],
  [-1.5, 2.4, -12.25], [-1.5, 2.4, -11.5], [-1.5, 4.8, -6.7], [-1.5, 4.8, -5.9], [-8, 4.8, -5.9], [-8, 4.8, 10],
  [8, 4.8, 10], [8, 4.8, -5.9], [-1.5, 4.8, -5.9], [-1.5, 4.8, -6.7], [-1.5, 2.4, -11.5], [-1.5, 2.4, -12.25],
  [1.5, 2.4, -12.25], [1.5, 2.4, -11.5], [1.5, 0, -6.7], [1.5, 0, -5.9], [8, 0, -5.9], [8, 0, 9], [0, 0, 9], [0, 0, 12.2],
];

/** Walk to a waypoint holding the real W key; only the view direction is set programmatically. */
async function walkTo(page, [x, y, z], trace) {
  const t0 = Date.now(); let best = Infinity, lastGain = Date.now(), down = false;
  try {
    for (;;) {
      const s = await st(page), d = Math.hypot(s.player.x - x, s.player.z - z);
      trace.push([+s.player.x.toFixed(3), +s.player.y.toFixed(3), +s.player.z.toFixed(3)]);
      if (d < ARRIVE) break;
      if (d < best - 0.05) { best = d; lastGain = Date.now(); }
      if (Date.now() - lastGain > Math.max(4000, frameMs * 8)) throw new Error(`stuck at ${JSON.stringify(s.player)} → ${x},${z}; state ${JSON.stringify({ ui: s.ui, enabled: s.enabled, locked: s.locked, keys: s.keys, yaw: s.yaw })}`);
      if (Date.now() - t0 > Math.max(60000, frameMs * 300)) throw new Error(`timeout → ${x},${z}`);
      await page.evaluate(([a, p]) => window.__t10.engine.look(a, p), [Math.atan2(-(x - s.player.x), -(z - s.player.z)), 0]);
      if (!down) { await page.keyboard.down('KeyW'); down = true; }
      await page.waitForTimeout(Math.max(d < 1 ? 8 : 25, frameMs * 0.6)); // never starve slow renderers of frames
    }
  } finally { if (down) await page.keyboard.up('KeyW'); }
  await page.waitForTimeout(60);
  const s = await st(page);
  // on a 0.5-slope flight, arriving ARRIVE metres early shifts height by ≤ ARRIVE/2
  assert.ok(Math.abs(s.player.y - y) < 0.05 + ARRIVE / 2, `height at ${[x, y, z]} was ${s.player.y}`);
  return s;
}

try {
  const page = await browser.newPage({ viewport: results.viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => ['intro', 'failed'].includes(window.__t10?.ui().phase), null, { timeout: 60000 });
  assert.equal((await st(page)).ui.phase, 'intro');
  results.layout = await page.evaluate(() => {
    const c = document.querySelector('.t10-canvas canvas').getBoundingClientRect();
    return { canvas: [c.left, c.top, c.width, c.height], viewport: [innerWidth, innerHeight], scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  });
  assert.deepEqual(results.layout.canvas, [0, 0, VW, VH]);
  assert.deepEqual(results.layout.scroll, [VW, VH]);
  frameMs = await page.evaluate(() => new Promise(r => { const a = []; let l = performance.now(); const f = n => { a.push(n - l); l = n; a.length < 6 ? requestAnimationFrame(f) : r(a.slice(1).sort((x, y) => x - y)[2]); }; requestAnimationFrame(f); }));
  results.measuredFrameMs = Math.round(frameMs);
  // arrival radius must cover one frame's step (walk 3 m/s × dt, dt capped at 0.25 s) or slow renderers oscillate
  ARRIVE = Math.max(0.3, 3 * Math.min(frameMs, 250) / 1000);
  await page.waitForTimeout(Math.max(800, frameMs * 3));
  await shot(page, '01-intro.png');

  await page.getByRole('button', { name: '进入藏宝阁' }).click();
  await page.waitForTimeout(300);
  let s = await st(page);
  assert.equal(s.ui.phase, 'play'); assert.equal(s.enabled, true);
  results.pointerLockAfterEnter = s.locked;
  results.meshesAfterMerge = s.meshes;

  // Nav surfaces vs real GLB geometry (downward rays from 0.5 m above each surface).
  results.surfaceProbe = await page.evaluate(() => {
    const e = window.__t10.engine, w = e.world, out = { checked: 0, mismatches: [] };
    const blocked = (x, z, y) => w.colliders.some(c => c.y1 > y + 0.05 && c.y0 < y + 0.6 && (c.kind === 'circle' ? Math.hypot(x - c.x, z - c.z) < c.r + 0.25 : x > c.x0 - 0.15 && x < c.x1 + 0.15 && z > c.z0 - 0.15 && z < c.z1 + 0.15));
    for (const s of w.surfaces) {
      for (let x = s.x0 + 0.2; x <= s.x1 - 0.2; x += 0.6) for (let z = s.z0 + 0.2; z <= s.z1 - 0.2; z += 0.6) {
        const ramp = s.ramp, y = ramp ? ramp.y0 + (ramp.y1 - ramp.y0) * Math.min(1, Math.max(0, (z - ramp.zA) / (ramp.zB - ramp.zA))) : s.y;
        if (blocked(x, z, y)) continue;
        if (s.id === 'ground' && Math.abs(x) < 2.9 && z < -6.5) continue; // under stairs: sealed off, not walkable
        const hit = e.probeGround(x, z, y + 0.5);
        out.checked++;
        const tol = ramp ? 0.2 : 0.06;
        if (hit === null || Math.abs(hit - y) > tol) out.mismatches.push({ s: s.id, x: +x.toFixed(2), z: +z.toFixed(2), nav: +y.toFixed(3), glb: hit === null ? null : +hit.toFixed(3) });
      }
    }
    return out;
  });
  assert.ok(results.surfaceProbe.checked > 1500, 'too few probe points');
  assert.deepEqual(results.surfaceProbe.mismatches, []);

  // Input exclusion: drawers/menus stop walking; closing leaves a click-to-resume pause.
  const start = (await st(page)).player;
  const holdW = async () => { await page.keyboard.down('KeyW'); await page.waitForTimeout(Math.max(600, frameMs * 4)); await page.keyboard.up('KeyW'); return (await st(page)).player; };
  await page.keyboard.press('KeyB');
  s = await st(page); assert.equal(s.ui.overlay, 'bag'); assert.equal(s.enabled, false);
  await shot(page, '02-bag.png');
  assert.deepEqual(await holdW(), start, 'walked with bag open');
  await page.keyboard.press('Escape');
  s = await st(page); assert.equal(s.ui.overlay, null); assert.equal(s.ui.phase, 'paused');
  assert.deepEqual(await holdW(), start, 'walked while paused');
  await page.keyboard.press('KeyM');
  s = await st(page); assert.equal(s.ui.overlay, 'menu');
  await shot(page, '03-menu.png');
  await page.getByRole('button', { name: '继续参观' }).click();
  s = await st(page); assert.equal(s.ui.phase, 'play'); assert.equal(s.ui.overlay, null);
  // A focused text field must not drive movement either.
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'probe-input'; document.body.append(i); i.focus(); });
  assert.deepEqual(await holdW(), start, 'walked while typing');
  await page.evaluate(() => { document.getElementById('probe-input').remove(); document.querySelector('.t10-canvas canvas').focus(); });
  results.inputExclusion = 'bag, paused, menu and focused input all blocked movement';

  // Real walk: entry → east aisle → stairs up → whole upper ring → stairs down → entry.
  const trace = [], legs = [];
  const tWalk = Date.now();
  for (const wp of ROUTE) {
    s = await walkTo(page, wp, trace);
    legs.push({ to: wp, at: [+s.player.x.toFixed(2), +s.player.y.toFixed(2), +s.player.z.toFixed(2)], floor: s.floor });
    const key = wp.join(',');
    if (key === '1.5,0,-6.7') { await page.evaluate(() => window.__t10.engine.look(0, 0.25)); await page.waitForTimeout(Math.max(150, frameMs * 2.5)); await shot(page, '04-stair-bottom.png'); }
    if (key === '1.5,2.4,-12.25' && legs.length < 10) { await page.evaluate(() => window.__t10.engine.look(Math.PI / 2, 0.3)); await page.waitForTimeout(Math.max(150, frameMs * 2.5)); await shot(page, '05-landing.png'); }
    if (key === '-8,4.8,-5.9') { await page.evaluate(() => window.__t10.engine.look(Math.PI * 0.85, -0.25)); await page.waitForTimeout(Math.max(150, frameMs * 2.5)); await shot(page, '06-upper-gallery.png'); }
  }
  results.walk = { seconds: Math.round((Date.now() - tWalk) / 1000), samples: trace.length, maxY: Math.max(...trace.map(p => p[1])), legs };
  assert.equal(results.walk.maxY, 4.8);
  for (const [x, y, z] of trace) {
    if (y > 4.6) assert.ok(!(x > -6 && x < 6 && z > -4.5 && z < 7.5), `upper trace inside atrium ${[x, y, z]}`);
    if (y > 4.6 && x > -2.7 && x < 2.7 && z > -13 && z < -6.7) assert.ok(x < -0.3, `upper trace inside stair well ${[x, y, z]}`);
  }
  const floorsSeen = new Set(legs.map(l => l.floor));
  assert.deepEqual([...floorsSeen].sort(), ['ground', 'stairs', 'upper']);
  s = await st(page);
  assert.ok(Math.hypot(s.player.x, s.player.z - 12.2) < ARRIVE + 0.05 && s.player.y === 0, 'did not return to entry');

  // E detail on a ground plinth (T05 at x=-9.6, z=0).
  for (const wp of [[-7.6, 0, 9], [-7.6, 0, 0]]) await walkTo(page, wp, trace);
  await page.evaluate(() => window.__t10.engine.look(Math.PI / 2, -0.35));
  await page.waitForTimeout(Math.max(300, frameMs * 3));
  s = await st(page); assert.equal(s.target?.id, 'T05');
  assert.ok(await page.getByText('查看 一层西侧 · 展位 T05').isVisible());
  await shot(page, '07-e-prompt.png');
  await page.keyboard.press('KeyE');
  s = await st(page); assert.equal(s.ui.overlay, 'detail'); assert.equal(s.ui.detail, 'T05'); assert.equal(s.enabled, false);
  await shot(page, '08-detail.png');
  await page.keyboard.press('Escape');
  s = await st(page); assert.equal(s.ui.overlay, null); assert.equal(s.ui.phase, 'paused');
  await page.mouse.click(720, 450);
  s = await st(page); assert.equal(s.ui.phase, 'play');
  await page.keyboard.press('KeyM'); await page.getByRole('button', { name: '回到入口' }).click();
  s = await st(page); assert.deepEqual(s.player, { x: 0, y: 0, z: 12.2 }); assert.equal(s.ui.phase, 'play');

  // Pointer-lock loss (Esc in a real browser) pauses; only if the browser granted the lock.
  if (s.locked) {
    await page.evaluate(() => document.exitPointerLock()); await page.waitForTimeout(150);
    s = await st(page); assert.equal(s.ui.phase, 'paused'); results.lockLossPauses = true;
    await page.mouse.click(720, 450); await page.waitForTimeout(150);
  } else results.lockLossPauses = 'not tested: headless browser did not grant pointer lock';

  // Short frame-time sample at the entry view and in the upper gallery.
  const sample = async () => page.evaluate(() => new Promise(r => { const t = []; let last = performance.now(); const f = n => { t.push(n - last); last = n; if (t.length < 120) requestAnimationFrame(f); else { t.sort((a, b) => a - b); r({ medianMs: +t[60].toFixed(2), p95Ms: +t[114].toFixed(2) }); } }; requestAnimationFrame(f); }));
  const perf = { entry: { ...(await sample()), ...(({ calls, triangles, pixelRatio }) => ({ calls, triangles, pixelRatio }))(await st(page)) } };
  await page.evaluate(() => window.__t10.engine.debugPlace(-8, -5.9, 4.8, Math.PI * 0.85, -0.25)); // framing only
  perf.upper = { ...(await sample()), calls: (await st(page)).calls };
  results.performance = perf;
  results.errors = errors; assert.deepEqual(errors, []);

  // Narrow window keeps the canvas full-bleed with no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  results.narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, canvas: document.querySelector('.t10-canvas canvas').clientWidth }));
  assert.deepEqual(results.narrow, { overflow: false, canvas: 390 });
  await page.waitForTimeout(Math.max(300, frameMs * 3));
  await shot(page, '09-narrow.png');
  await page.close();

  // Asset failure shows an explicit error rather than a fake ready state.
  const fail = await browser.newPage();
  await fail.route('**/pavilion-v1*.glb', r => r.abort());
  await fail.goto(BASE + '/');
  await fail.waitForFunction(() => window.__t10?.ui().phase === 'failed', null, { timeout: 30000 });
  results.failedAssetShowsError = await fail.getByText('古阁暂时无法打开').isVisible();
  assert.equal(results.failedAssetShowsError, true);
  await fail.close();

  // Other routes still mount.
  const other = await browser.newPage();
  await other.goto(BASE + '/workbench');
  results.workbenchRoute = await other.getByRole('link', { name: /进入藏宝阁/ }).isVisible();
  assert.equal(results.workbenchRoute, true);
  await other.close();

  results.pass = true;
} catch (e) {
  results.pass = false; results.failure = String(e?.stack || e); throw e;
} finally {
  results.finished = new Date().toISOString();
  await fs.writeFile(new URL('browser-check.json', OUT), JSON.stringify(results, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify({ pass: results.pass, walk: { seconds: results.walk?.seconds, maxY: results.walk?.maxY }, probe: results.surfaceProbe?.checked, performance: results.performance }, null, 2));
