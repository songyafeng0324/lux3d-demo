// T15 real-Chrome check: third-person avatar in the pavilion (real dev server, public gallery) and
// in the room / shared room (intercepted APIs, no DB writes). Usage, with `npm run dev` running:
//   node scripts/t15-third-person-browser.mjs     T15_BASE=http://localhost:5173  CHROME_CHANNEL=chrome
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BASE = process.env.T15_BASE || 'http://localhost:5173';
const OUT = new URL(process.env.T15_EVIDENCE_DIR ? `file://${process.env.T15_EVIDENCE_DIR.replace(/\/?$/, '/')}` : '../docs/validation/evidence/t16/third-person/', import.meta.url);
await fs.mkdir(OUT, { recursive: true });
const channel = process.env.CHROME_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader'] });
const results = { base: BASE, browser: browser.version(), started: new Date().toISOString() };
const shot = (page, name) => page.screenshot({ path: new URL(name, OUT).pathname });
const errors = [];
const LAYOUT_ENTRY_Z = 24; // assets/t16/pavilion-layout.json entry
const LABEL_ID = { 拟人橘猫: 'humanoid-tabby', 白衣男孩: 'white-shirt-boy', 粉裤女孩: 'pink-shorts-girl', 黄衣牛角人: 'bull-tpose', 红衣小丸子: 'maruko-tpose', 蜡笔小新: 'shin-chan' };

async function pavilion() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('pavilion: ' + e.message));
  const st = () => page.evaluate(() => ({ ...window.__t10.engine.debugState(), ui: window.__t10.ui() }));
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__t10?.ui().phase === 'intro' && window.__t10.engine.debugState().avatar.loaded, null, { timeout: 60000 });
  let s = await st();
  assert.equal(s.view, 'third', 'third person is the default');
  assert.equal(s.avatar.character, 'humanoid-tabby');
  const height = s.avatar.bounds[1][1] - s.avatar.bounds[0][1];
  assert.ok(Math.abs(height - 1.5) < 0.06, `avatar height ${height}`);
  await page.getByRole('button', { name: '进入藏宝阁' }).click();
  await page.waitForTimeout(400);
  await shot(page, '01-pavilion-entry.png');

  // Idle → Run → Idle with real keys; facing follows the movement (north = π).
  await page.evaluate(() => window.__t10.engine.look(0, -0.2));
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__t10.engine.debugState().avatar.clip === 'Run', null, { timeout: 5000 });
  await page.waitForTimeout(900);
  s = await st();
  await page.keyboard.up('KeyW');
  assert.ok(s.player.z < LAYOUT_ENTRY_Z - 0.5, 'walked forward');
  assert.ok(Math.abs(Math.abs(s.avatar.facing) - Math.PI) < 0.1, `facing ${s.avatar.facing}`);
  await shot(page, '02-pavilion-run.png');
  await page.waitForFunction(() => window.__t10.engine.debugState().avatar.clip === 'Idle', null, { timeout: 3000 });
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyD');
  s = await st();
  assert.ok(Math.abs(Math.sin(s.avatar.facing) - 1) < 0.02, `strafe right faces east (+X): ${s.avatar.facing}`);

  // Analytic boom vs the real GLB: from many reachable spots and views, nothing of the model sits between pivot and camera.
  results.cameraProbe = await page.evaluate(() => {
    const e = window.__t10.engine, w = e.world, out = { views: 0, shortened: 0, hits: [] };
    const blocked = (x, z, y) => w.colliders.some(c => c.y1 > y + 0.05 && c.y0 < y + 1.7 && (c.kind === 'circle' ? Math.hypot(x - c.x, z - c.z) < c.r + 0.35 : x > c.x0 - 0.35 && x < c.x1 + 0.35 && z > c.z0 - 0.35 && z < c.z1 + 0.35));
    const pitches = [-1.15, -0.5, -0.2, 0.3, 0.8];
    for (const s of w.surfaces) {
      for (let x = s.x0 + 0.5; x <= s.x1 - 0.5; x += 2.3) for (let z = s.z0 + 0.5; z <= s.z1 - 0.5; z += 2.3) {
        const r = s.ramp, y = r ? r.y0 + (r.y1 - r.y0) * Math.min(1, Math.max(0, (z - r.zA) / (r.zB - r.zA))) : s.y;
        if (blocked(x, z, y)) continue;
        for (let k = 0; k < 8; k++) for (const pitch of pitches) {
          e.debugPlace(x, z, y, k * Math.PI / 4, pitch);
          const c = e.debugCameraClearance();
          out.views++;
          if (c.boom < 3.19) out.shortened++;
          // Any model surface closer than the camera, beyond 5 cm, is a clipping view.
          if (c.hit && c.hit.distance < c.boom - 0.05) out.hits.push({ at: [x, y, z].map(v => +v.toFixed(2)), yaw: k * 45, pitch, boom: +c.boom.toFixed(2), hit: +c.hit.distance.toFixed(2), mesh: c.hit.mesh });
        }
      }
    }
    e.resetToEntry();
    return out;
  });
  assert.ok(results.cameraProbe.views > 1500, 'too few camera probes');
  assert.deepEqual(results.cameraProbe.hits, [], 'camera clipped into the model');

  // Framing shots on both floors and the stairs.
  for (const [name, x, z, y, yaw, pitch] of [['03-pavilion-hall.png', 5, 9, 0, 0.5, -0.25], ['04-pavilion-stairs.png', 0, -19, 2.34, 0, -0.3], ['05-pavilion-upper.png', -16, 4, 9, -Math.PI / 2, -0.3], ['06-pavilion-wall.png', 8, 26.5, 0, 0, -0.2]]) {
    await page.evaluate(([x, z, y, yaw, pitch]) => window.__t10.engine.debugPlace(x, z, y, yaw, pitch), [x, z, y, yaw, pitch]);
    await page.waitForTimeout(350);
    await shot(page, name);
  }

  // E detail in third person: stand in front of an occupied plinth, aim with the view, press E.
  const exhibit = await page.evaluate(() => {
    const e = window.__t10.engine, d = e.debugState(), item = d.exhibits[0];
    if (!item) return null;
    const slot = e.world.slots.reduce((a, b) => Math.hypot(b.position[0] - item.position[0], b.position[2] - item.position[2]) < Math.hypot(a.position[0] - item.position[0], a.position[2] - item.position[2]) ? b : a);
    const [sx, sy, sz] = slot.position, px = sx - Math.sign(sx) * 1.8;
    e.debugPlace(px, sz, sy, Math.atan2(-(sx - px), 0), -0.45);
    return slot.id;
  });
  if (exhibit) {
    await page.locator('.t10-prompt').waitFor({ timeout: 5000 });
    await page.keyboard.press('KeyE');
    await page.locator('.t10-detail').waitFor();
    await shot(page, '07-pavilion-exhibit-detail.png');
    results.exhibitDetail = { slot: exhibit, opened: true };
    await page.keyboard.press('Escape');
  } else results.exhibitDetail = { opened: false, reason: 'gallery has no exhibit' };

  // Character picker: top-right 「角色」 button or C; six thumbnail cards; one click switches and closes.
  results.characters = [];
  await page.evaluate(() => window.__t10.engine.debugPlace(0, 6, 0, 0, -0.2));
  results.hints = { pavilion: await page.locator('.t10-hud-bottom > span').first().textContent() };
  const picker = page.getByRole('dialog', { name: '选择角色' });
  await page.locator('.t10-actions').getByRole('button', { name: /^角色/ }).click();
  await picker.waitFor();
  assert.equal((await st()).ui.overlay, 'character');
  await page.waitForFunction(() => { const imgs = [...document.querySelectorAll('.character-card img')]; return imgs.length === 6 && imgs.every(i => i.complete && i.naturalWidth > 0); });
  results.picker = { cards: (await picker.locator('.character-card').allTextContents()) };
  assert.deepEqual(results.picker.cards, Object.keys(LABEL_ID));
  await shot(page, '11-character-picker.png');
  await page.keyboard.press('Escape'); // Esc closes without changing
  await picker.waitFor({ state: 'detached' });
  await page.keyboard.press('KeyC'); await picker.waitFor();
  await page.keyboard.press('KeyC'); await picker.waitFor({ state: 'detached' }); // C toggles it shut
  assert.equal((await st()).avatar.character, 'humanoid-tabby');
  await page.keyboard.press('KeyV'); // from first person, a pick shows the new character in third person
  assert.equal((await st()).view, 'first');
  for (const [label, id] of Object.entries(LABEL_ID).filter(([l]) => l !== '拟人橘猫').concat([['拟人橘猫', 'humanoid-tabby']])) {
    await page.keyboard.press('KeyC');
    await picker.getByRole('button', { name: label, exact: true }).click();
    await picker.waitFor({ state: 'detached' });
    await page.waitForFunction(id => { const a = window.__t10.engine.debugState().avatar; return a.loaded && a.character === id && a.visible; }, id, { timeout: 30000 });
    s = await st();
    assert.equal(s.ui.overlay, null, 'picker closes on pick'); assert.equal(s.ui.phase, 'play', 'back to walking'); assert.equal(s.view, 'third');
    const a = s.avatar;
    results.characters.push({ label, id: a.character, height: +(a.bounds[1][1] - a.bounds[0][1]).toFixed(3) });
    assert.ok(Math.abs(a.bounds[1][1] - a.bounds[0][1] - 1.5) < 0.06, label + ' height');
  }

  // V toggles views and persists across reload.
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(150);
  s = await st();
  assert.equal(s.view, 'first');
  assert.equal(s.avatar.visible, false);
  assert.ok(Math.abs(s.camera[1] - (s.player.y + 1.6)) < 1e-6, 'first person eye height');
  await page.reload();
  await page.waitForFunction(() => window.__t10?.ui().phase === 'intro', null, { timeout: 60000 });
  assert.deepEqual((await st()).ui.avatar, { character: 'humanoid-tabby', view: 'first' });
  await page.getByRole('button', { name: '进入藏宝阁' }).click();

  // Frame rate, first vs third person, same spot.
  const measure = async () => { await page.waitForTimeout(400); return page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(f) : r(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); })); };
  await page.evaluate(() => window.__t10.engine.debugPlace(0, 6, 0, 0, -0.2));
  const first = await measure();
  await page.keyboard.press('KeyV');
  assert.equal((await st()).view, 'third');
  await page.evaluate(() => window.__t10.engine.debugPlace(0, 6, 0, 0, -0.2));
  const third = await measure();
  results.fps = { first, third, note: 'headless Chrome; M5 real-device numbers are the acceptance basis' };
  s = await st();
  results.renderInfo = { calls: s.calls, triangles: s.triangles };
  await context.close();
}

async function room() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const user = { id: 'user-1', username: 'qa_user', nickname: '藏家', role: 'user' };
  const placements = [{ id: 'placement-1', assetId: 'furniture-1', position: [2, 0.025, -1], rotation: [0, 0, 0], scale: 1 }];
  const model = { id: 'furniture-1', name: '官方长案', description: '', modelFileId: 'model-1', originalImageId: null, createdAt: new Date().toISOString(), normalization: { scale: 0.5, translation: [0, 0, 0] }, bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] } };
  const roomModels = [{ id: model.id, modelFileId: model.modelFileId, normalization: model.normalization, bounds: model.bounds }];
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 2, 1]);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, -1], max: [1, 2, 1] }] };
  let chunk = Buffer.from(JSON.stringify(json)); chunk = Buffer.concat([chunk, Buffer.alloc((4 - chunk.length % 4) % 4, 32)]);
  const head = Buffer.alloc(20); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + chunk.length + positions.byteLength, 8); head.writeUInt32LE(chunk.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(positions.byteLength, 0); binHead.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([head, chunk, binHead, Buffer.from(positions.buffer)]);
  await context.route('**/api/v1/**', route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '');
    const ok = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 't15' }) });
    if (path === '/me') return ok({ user, roomId: 'room-1', quota: { day: '2026-11-09', total: 10, used: 0, available: 10 }, activeTask: null, csrfToken: 'csrf' });
    if (path === '/assets' || path === '/collections') return ok({ items: [], nextCursor: null });
    if (path === '/furniture') return ok({ items: [model], nextCursor: null });
    if (path === '/rooms/me') return ok({ id: 'room-1', name: '听雨小筑', version: 1, sceneVersion: 'courtyard-v1', placements, shareEnabled: true, shareUrl: '/shared/t15-token', assets: roomModels });
    if (path.startsWith('/files/')) return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb });
    if (path === '/shared-rooms/t15-token') return ok({ name: '听雨小筑', ownerNickname: '藏家', version: 1, sceneVersion: 'courtyard-v1', placements, assets: roomModels, grant: { id: 'grant-1', token: 'grant', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    if (path === '/snapshots/grant-1/room-like') return ok({ popularity: 0, state: 'guest' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA', message: path }, requestId: 't15' }) });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('room: ' + e.message));
  const st = p => p.evaluate(() => window.__room.engine.debug());
  await page.goto(BASE + '/room');
  await page.waitForFunction(() => window.__room?.engine.debug().instances === 1, null, { timeout: 30000 });
  assert.equal((await st(page)).avatar.visible, false, 'no avatar while arranging');
  assert.equal(await page.getByRole('button', { name: /^角色/ }).count(), 0, 'no character button while arranging');
  await page.getByRole('button', { name: '漫游参观', exact: true }).click();
  await page.waitForFunction(() => window.__room.engine.debug().avatar.visible, null, { timeout: 30000 });
  await page.locator('.scene-canvas canvas').click();
  await page.waitForFunction(() => Boolean(document.pointerLockElement));
  await page.keyboard.down('w');
  await page.waitForFunction(() => window.__room.engine.debug().avatar.clip === 'Run');
  await page.waitForTimeout(1600);
  let s = await st(page);
  await page.keyboard.up('w');
  assert.ok(s.player.z < 3, 'walked indoors');
  assert.ok(s.camera[1] < 4.8 - 0.3, `camera under the roof (${s.camera[1]})`);
  const indoorCamera = s.camera, indoorBoom = s.boom;
  await page.waitForTimeout(300);
  await shot(page, '08-room-visit-indoor.png');
  await page.keyboard.press('Escape');
  results.hints.room = await page.locator('.visit-actions > span').textContent();
  const roomPicker = page.getByRole('dialog', { name: '选择角色' });
  await page.locator('.room-header-actions').getByRole('button', { name: /^角色/ }).click();
  await roomPicker.getByRole('button', { name: '粉裤女孩', exact: true }).click();
  await roomPicker.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__room.engine.debug().avatar.character === 'pink-shorts-girl' && window.__room.engine.debug().avatar.visible, null, { timeout: 30000 });
  await page.waitForFunction(() => Boolean(document.pointerLockElement), null, { timeout: 3000 }); // walking resumes

  // Shift quick walk in the room, as in the pavilion.
  const walk = async shift => {
    await page.evaluate(() => window.__room.engine.home());
    const z0 = (await st(page)).player.z, t0 = Date.now();
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.down('w'); await page.waitForTimeout(600);
    const z1 = (await st(page)).player.z, t1 = Date.now();
    await page.keyboard.up('w'); if (shift) await page.keyboard.up('Shift');
    return (z0 - z1) / ((t1 - t0) / 1000);
  };
  const walkSpeed = await walk(false), runSpeed = await walk(true);
  results.roomSpeed = { walk: +walkSpeed.toFixed(2), shift: +runSpeed.toFixed(2) };
  assert.ok(runSpeed > walkSpeed * 1.5, `Shift speeds up the room walk (${walkSpeed} → ${runSpeed})`);
  await page.keyboard.press('Escape');
  // Shift+C (while quick-walking) does not open the picker; Tab stays on the cards; Esc closes.
  await page.keyboard.press('Shift+KeyC');
  await page.waitForTimeout(150);
  assert.equal(await roomPicker.count(), 0, 'Shift+C ignored');
  await page.keyboard.press('KeyC'); await roomPicker.waitFor();
  for (let i = 0; i < 8; i++) await page.keyboard.press(i % 3 ? 'Tab' : 'Shift+Tab');
  assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('.character-picker'))), 'Tab focus stays in the picker');
  await page.keyboard.press('Escape'); await roomPicker.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /回到入口/ }).click();
  await page.waitForTimeout(300);
  await shot(page, '09-room-visit-entry.png');
  await page.keyboard.press('KeyV');
  s = await st(page);
  assert.equal(s.view, 'first');
  assert.ok(Math.abs(s.camera[1] - (s.player.y + 1.625)) < 1e-6, 'room first person eye height');
  await page.keyboard.press('KeyV');

  const guest = await context.newPage();
  guest.on('pageerror', e => errors.push('shared: ' + e.message));
  await guest.goto(BASE + '/shared/t15-token');
  await guest.waitForFunction(() => window.__room?.engine.debug().avatar.visible, null, { timeout: 30000 });
  const g = await st(guest);
  assert.equal(g.mode, 'share');
  assert.equal(g.avatar.character, 'pink-shorts-girl', 'per-browser choice carries to the shared page');
  await guest.waitForTimeout(300);
  await shot(guest, '10-shared-room.png');
  results.hints.shared = await guest.locator('.visit-actions > span').textContent();
  assert.ok(results.hints.pavilion && results.hints.pavilion === results.hints.room && results.hints.room === results.hints.shared, 'same control hint in all three scenes');
  assert.equal(await guest.locator('.room-header-actions').getByRole('button', { name: /^角色/ }).count(), 1);
  await guest.keyboard.press('KeyC');
  const guestPicker = guest.getByRole('dialog', { name: '选择角色' });
  await guestPicker.getByRole('button', { name: '白衣男孩', exact: true }).click();
  await guestPicker.waitFor({ state: 'detached' });
  await guest.waitForFunction(() => window.__room.engine.debug().avatar.character === 'white-shirt-boy', null, { timeout: 30000 });
  results.room = { indoorCamera, indoorBoom, sharedCharacter: g.avatar.character, sharedBoom: g.boom };
  await context.close();
}

try {
  await pavilion();
  await room();
  assert.deepEqual(errors, []);
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = String(error?.stack || error);
  throw error;
} finally {
  results.errors = errors;
  await fs.writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ passed: results.passed, cameraProbe: results.cameraProbe && { views: results.cameraProbe.views, shortened: results.cameraProbe.shortened, hits: results.cameraProbe.hits.length }, fps: results.fps, characters: results.characters, error: results.error?.split('\n')[0] }, null, 2));
}
