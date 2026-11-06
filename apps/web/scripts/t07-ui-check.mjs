// Formal-room UI regression against isolated intercepted APIs. No supplier/DB calls.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const evidenceDir = process.env.T07_UI_EVIDENCE_DIR;
if (evidenceDir) await fs.mkdir(evidenceDir, { recursive: true });
const shot = async (page, name) => { if (evidenceDir) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(evidenceDir, name) }); } };
const BASE = process.env.T07_UI_BASE || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [], writes = [], receipts = new Map(), modelReads = [], renewals = [];
let roomVersion = 0, roomName = '初始小屋', placements = [{ id: 'placement-1', assetId: 'asset-1', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }];
let shareEnabled = false, loseSave = true, rejectSave = 0, loadFailed = false, delaySave = null, releaseAck;
let sharedReadCount = 0;
let signedIn = true, expireSave = false;
const models = Array.from({ length: 32 }, (_, i) => ({ id: 'asset-' + (i + 1), name: '个人藏品' + (i + 1), description: '', modelFileId: 'model-' + (i + 1), originalImageId: null, createdAt: new Date().toISOString(), normalization: { scale: .5, translation: [0, 0, 0] }, bounds: { min: [-.5, 0, -.5], max: [.5, 1, .5] } }));
const furniture = { ...models[0], id: 'furniture-1', name: '官方长案' };
const all = [...models, furniture];
const roomModels = () => [...new Set(placements.map(p => p.assetId))].map(id => { const model = all.find(m => m.id === id); return { id, modelFileId: model.modelFileId, normalization: model.normalization, bounds: model.bounds }; });
const ownerRoom = () => ({ id: 'room-1', name: roomName, version: roomVersion, sceneVersion: 'courtyard-v1', placements, shareEnabled, shareUrl: shareEnabled ? '/shared/stable-token' : null, assets: roomModels() });
const sourcePositions = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 2, 1]);
const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true }], buffers: [{ byteLength: sourcePositions.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: sourcePositions.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, -1], max: [1, 2, 1] }] };
let chunk = Buffer.from(JSON.stringify(json)); chunk = Buffer.concat([chunk, Buffer.alloc((4 - chunk.length % 4) % 4, 32)]);
const glb = Buffer.alloc(12 + 8 + chunk.length + 8 + sourcePositions.byteLength); glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(chunk.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); chunk.copy(glb, 20); glb.writeUInt32LE(sourcePositions.byteLength, 20 + chunk.length); glb.writeUInt32LE(0x004e4942, 24 + chunk.length); Buffer.from(sourcePositions.buffer).copy(glb, 28 + chunk.length);
await context.route('**/api/v1/**', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', ''), method = request.method();
  const ok = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'room-qa' }) });
  const fail = (status, message) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA', message }, requestId: 'room-qa' }) });
  const user = { id: 'user-1', username: 'qa_user', nickname: '藏家', role: 'user' };
  if (path === '/me') return signedIn ? ok({ user, roomId: 'room-1', quota: { day: '2026-11-05', total: 3, used: 0, available: 3 }, activeTask: null, csrfToken: 'csrf-room' }) : fail(401, '请先登录');
  if (path === '/auth/login') { signedIn = true; return ok({ user, csrfToken: 'csrf-room' }); }
  if (path === '/assets') { const offset = Number(url.searchParams.get('cursor') || 0); return ok({ items: models.slice(offset, offset + 30), nextCursor: offset + 30 < models.length ? String(offset + 30) : null }); }
  if (path === '/collections') return ok({ items: [], nextCursor: null });
  if (path === '/furniture') return ok({ items: [furniture], nextCursor: null });
  if (path === '/rooms/me' && method === 'GET') return loadFailed ? fail(503, '临时读取失败') : ok(ownerRoom());
  if (path.startsWith('/files/')) { modelReads.push(request.headers()); return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb }); }
  if (path === '/rooms/me/layout') {
    assert.equal(request.headers()['x-csrf-token'], 'csrf-room');
    const key = request.headers()['idempotency-key'], body = request.postDataJSON(); writes.push({ key, body });
    if (expireSave) { expireSave = false; signedIn = false; return fail(401, '登录已失效'); }
    if (receipts.has(key)) return ok(receipts.get(key));
    if (rejectSave) { const status = rejectSave; rejectSave = 0; return fail(status, '确定拒绝此布局'); }
    if (body.baseVersion !== roomVersion) return fail(409, '版本冲突');
    roomVersion++; roomName = body.name; placements = body.placements;
    const receipt = { savedVersion: roomVersion, editSequence: body.editSequence }; receipts.set(key, receipt);
    if (loseSave) { loseSave = false; return route.abort('connectionreset'); }
    if (delaySave) { delaySave = null; await new Promise(resolve => { releaseAck = resolve; }); }
    return ok(receipt);
  }
  if (path === '/rooms/me/share') { shareEnabled = request.postDataJSON().enabled; return ok({ enabled: shareEnabled, shareUrl: '/shared/stable-token' }); }
  if (path === '/shared-rooms/stable-token') { sharedReadCount++; return ok({ name: roomName, ownerNickname: '藏家', version: roomVersion, sceneVersion: 'courtyard-v1', placements, assets: roomModels(), grant: { id: 'grant-1', token: 'grant-token', expiresAt: new Date(Date.now() + 60_000).toISOString() } }); }
  if (path === '/snapshots/grant-1/room-like') return ok({ popularity: 0, state: 'guest' });
  if (path === '/snapshots/grant-1/renew') { renewals.push(request.headers()); if (renewals.length === 1) return route.abort('connectionreset'); return ok({ grant: { id: 'grant-1', token: 'grant-token', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }); }
  return fail(404, path);
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
const saved = p => p.waitForFunction(() => window.__room?.save?.state.status === 'saved');
try {
  await page.goto(BASE + '/room'); await saved(page);
  assert.equal(writes.length, 0, 'loading must never create an empty layout');
  const canvasRect = target => target.evaluate(() => { const r = document.querySelector('.scene-canvas canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  assert.deepEqual(await canvasRect(page), [0, 0, 1440, 900]);
  assert.equal(await page.getByRole('complementary', { name: '物品抽屉' }).count(), 0, 'catalog drawer starts closed');
  await page.getByRole('button', { name: '打开物品库', exact: true }).click();
  assert.deepEqual(await canvasRect(page), [0, 0, 1440, 900], 'opening drawer must not shrink canvas');
  assert.equal(await page.locator('.room-catalog .room-asset-card').count(), 33, 'all personal pages plus furniture must load');
  await page.waitForFunction(() => document.querySelector('.room-catalog .asset-thumbnail img')?.naturalWidth === 192);
  assert.equal(await page.locator('.room-catalog .asset-short-name').first().textContent(), '个人藏品1');
  await page.getByLabel('房间名称').fill('第一次保存'); await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  await page.getByLabel('房间名称').fill('网络失败后继续编辑'); await page.getByRole('button', { name: '重试保存', exact: true }).click(); await saved(page);
  assert.equal(writes[0].key, writes[1].key); assert.deepEqual(writes[0].body, writes[1].body); assert.notEqual(writes[1].key, writes[2].key); assert.equal(roomName, '网络失败后继续编辑');
  expireSave = true;
  await page.getByLabel('房间名称').fill('会话过期保留的草稿');
  await page.getByRole('button', { name: /登录后进入自己的小屋/ }).click();
  const account = page.getByRole('dialog', { name: '账号设置' });
  await account.getByLabel('用户名').fill('qa_user');
  assert.equal(await page.getByLabel('房间名称').inputValue(), '会话过期保留的草稿');
  assert.equal(await page.getByLabel('房间名称').isDisabled(), true);
  const expired = writes.at(-1);
  await account.getByLabel('密码', { exact: true }).fill('password-123456');
  await account.getByRole('button', { name: '登录账号' }).click();
  await account.getByText('已登录。').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '重试保存' }).click();
  await saved(page);
  assert.deepEqual(writes.at(-1), expired, 'reauthenticated owner replays the exact pending draft');
  assert.equal(roomName, '会话过期保留的草稿');
  await page.getByRole('button', { name: '打开物品库', exact: true }).click();
  await page.evaluate(() => { window.__room.engine.home(); window.__room.engine.select('placement-1'); });
  await page.getByRole('button', { name: '移动', exact: true }).click();
  delaySave = true; await page.getByLabel('房间名称').fill('等待旧回执');
  await page.waitForFunction(() => window.__room.save.state.status === 'saving');
  while (!releaseAck) await new Promise(resolve => setTimeout(resolve, 20));
  const geometry = await page.evaluate(() => window.__room.engine.debug());
  let point;
  for (const radius of [.6, 1, 1.4, 1.8, 2.2, 2.6, 3]) {
    const x = geometry.point.x + (geometry.axes[0].x - geometry.point.x) * radius, y = geometry.point.y + (geometry.axes[0].y - geometry.point.y) * radius;
    await page.mouse.move(x, y);
    if (await page.evaluate(() => window.__room.engine.debug().axis) === 'X') { point = { x, y }; break; }
  }
  assert.ok(point, 'actual transform gizmo picker must be found');
  await page.mouse.down(); assert.equal(await page.evaluate(() => window.__room.engine.debug().orbitEnabled), false);
  await page.mouse.move(point.x + 18, point.y - 12, { steps: 10 });
  const dragged = await page.evaluate(() => window.__room.engine.instances.get('placement-1').position.toArray());
  assert.notDeepEqual(dragged, [0, 0, 0]);
  releaseAck(); await saved(page);
  assert.deepEqual(await page.evaluate(() => window.__room.engine.instances.get('placement-1').position.toArray()), dragged, 'save ACK must not snap an active real drag back');
  await page.mouse.up(); await saved(page);
  assert.deepEqual(await page.evaluate(() => window.__room.snapshot().placements[0].position), dragged);
  for (const status of [413, 422]) { rejectSave = status; await page.getByLabel('房间名称').fill('拒绝' + status); await page.waitForFunction(() => window.__room.save.state.status === 'rejected'); const previous = writes.at(-1).key; await page.getByLabel('房间名称').fill('修正' + status); await saved(page); assert.notEqual(writes.at(-1).key, previous); }
  roomVersion++; roomName = '另一页的确认版本'; await page.getByLabel('房间名称').fill('本页冲突草稿'); await page.getByRole('button', { name: '载入已确认版本' }).waitFor(); assert.equal(await page.getByLabel('房间名称').inputValue(), '本页冲突草稿');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '载入已确认版本' }).click(); assert.equal(await page.getByLabel('房间名称').inputValue(), '本页冲突草稿');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '载入已确认版本' }).click(); await saved(page); assert.equal(await page.getByLabel('房间名称').inputValue(), '另一页的确认版本');
  await page.evaluate(() => window.__room.add('asset-32')); await saved(page);
  assert.equal(await page.evaluate(() => window.__room.engine.debug().instances), 2);
  await page.evaluate(() => window.__room.add('asset-1')); await saved(page);
  assert.equal(await page.evaluate(() => {
    const instances = [...window.__room.engine.instances.values()].filter(instance => instance.userData.assetId === 'asset-1');
    const geometries = instances.map(instance => { let geometry; instance.traverse(object => { if (object.isMesh) geometry = object.geometry.uuid; }); return geometry; });
    return geometries.length === 2 && geometries[0] === geometries[1];
  }), true, 'same-source placements must share geometry');
  await page.getByRole('button', { name: '房间物品', exact: false }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.placement-list img')].filter(image => image.complete && image.naturalWidth === 192).length === 3);
  const copies = page.locator('.placement-list .room-placement-card').filter({ hasText: '个人藏品1' });
  assert.equal(await copies.nth(0).locator('img').getAttribute('src'), await copies.nth(1).locator('img').getAttribute('src'));
  await page.getByRole('button', { name: '移除摆放3', exact: true }).click(); await saved(page);
  assert.equal(await page.evaluate(() => window.__room.engine.debug().instances), 2, 'removal must retain the other same-source placement');
  assert.deepEqual(await page.evaluate(() => window.__room.engine.debug().assetBounds['asset-1']), models[0].bounds, 'normalization must match server bounds');
  await page.evaluate(() => {
    const [first, second] = window.__room.snapshot().placements;
    window.__room.replace([{ ...first, position: [0, 0, 1.75], scale: 2 }, { ...second, position: [7.5, -.4, 0] }]);
  });
  await saved(page);
  const lock = async target => {
    await target.locator('.scene-canvas canvas').click();
    await target.waitForFunction(() => Boolean(document.pointerLockElement));
  };
  const keyUntil = async (target, key, predicate) => {
    await target.keyboard.down(key);
    try { await target.waitForFunction(predicate); } finally { await target.keyboard.up(key); }
  };
  const checkJump = async target => {
    await target.keyboard.press('Space');
    await target.waitForFunction(() => window.__room.engine.debug().airborne && window.__room.engine.debug().camera[1] > 2);
    await target.waitForFunction(() => !window.__room.engine.debug().airborne && window.__room.engine.debug().camera[1] === 1.65);
  };
  const checkAssetBlocks = async target => {
    await target.keyboard.down('w');
    try { await target.waitForFunction(() => window.__room.engine.debug().camera[2] < 3.2); await target.waitForTimeout(450); }
    finally { await target.keyboard.up('w'); }
    const [, , z] = await target.evaluate(() => window.__room.engine.debug().camera);
    assert.ok(z >= 3.03 && z < 3.2, 'scaled asset stops first-person movement before its front face');
  };
  await page.getByRole('button', { name: '第一人称参观', exact: true }).click();
  await lock(page);
  await checkAssetBlocks(page);
  await checkJump(page);
  await keyUntil(page, 's', () => window.__room.engine.debug().camera[2] > 8.6);
  const outside = await page.evaluate(() => window.__room.engine.debug().camera);
  assert.ok(outside[2] <= 8.7 && outside[1] < 1.3, 'player reaches the visible dirt edge at outdoor floor height');
  await keyUntil(page, 'w', () => window.__room.engine.debug().camera[2] < 4.8);
  assert.equal((await page.evaluate(() => window.__room.engine.debug().camera))[1], 1.65, 'porch step allows walking back indoors');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.pointerLockElement === null);
  await page.getByRole('button', { name: '回到入口', exact: false }).click();
  assert.deepEqual(await page.evaluate(() => window.__room.engine.debug().camera.map(n => Number(n.toFixed(3)))), [0, 1.425, 5.1]);
  await page.getByRole('button', { name: '布置小屋', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__room.engine.debug().orbitEnabled), true);
  await shot(page, 'owner-room.png');
  await page.getByRole('button', { name: '开启分享', exact: true }).click(); await page.getByRole('button', { name: '关闭分享', exact: true }).waitFor();
  assert.equal(await page.locator('.room-share-panel a').getAttribute('href'), '/shared/stable-token');
  await page.getByRole('button', { name: '关闭分享', exact: true }).click(); await page.getByRole('button', { name: '开启分享', exact: true }).waitFor();
  await page.getByRole('button', { name: '开启分享', exact: true }).click(); assert.equal(await page.locator('.room-share-panel a').getAttribute('href'), '/shared/stable-token');
  const viewer = await context.newPage(); viewer.on('pageerror', error => errors.push(error.message)); await viewer.clock.install();
  const modelStart = modelReads.length; await viewer.goto(BASE + '/shared/stable-token'); await viewer.waitForFunction(() => window.__room?.snapshot()?.placements.length === 2);
  assert.deepEqual(await canvasRect(viewer), [0, 0, 1440, 900]);
  assert.equal(await viewer.locator('.scene-sidebar,input,[role=toolbar]').count(), 0); assert.equal(await viewer.getByRole('button', { name: '移动', exact: true }).count(), 0);
  assert.equal(await viewer.evaluate(() => window.__room.save), null);
  await lock(viewer);
  await checkAssetBlocks(viewer);
  await checkJump(viewer);
  await viewer.keyboard.press('Escape');
  await shot(viewer, 'shared-room.png');
  const visitorHeaders = modelReads.slice(modelStart); assert.ok(visitorHeaders.length > 0); for (const headers of visitorHeaders) { assert.equal(headers.authorization, 'Bearer grant-token'); assert.equal(headers['x-snapshot-grant'], 'grant-1'); }
  const sharedAtLoad = sharedReadCount;
  await viewer.clock.fastForward(1500); await viewer.waitForFunction(() => document.querySelector('.scene-notice')?.textContent.includes('续期'));
  await viewer.clock.fastForward(31_000); await page.waitForTimeout(150);
  assert.equal(renewals.length, 2); assert.equal(renewals[0]['idempotency-key'], renewals[1]['idempotency-key']); assert.equal(renewals[1]['x-snapshot-grant'], 'grant-1'); assert.equal(sharedReadCount, sharedAtLoad, 'renewal must not fetch latest layout');
  loadFailed = true; const failedPage = await context.newPage(); failedPage.on('pageerror', error => errors.push(error.message)); const writesBefore = writes.length; await failedPage.goto(BASE + '/room'); await failedPage.getByRole('button', { name: '重试读取', exact: true }).waitFor(); assert.equal(await failedPage.getByLabel('房间名称').isDisabled(), true); await failedPage.waitForTimeout(650); assert.equal(writes.length, writesBefore);
  loadFailed = false; await failedPage.getByRole('button', { name: '重试读取', exact: true }).click(); await saved(failedPage);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, scope: 'intercepted APIs; no supplier calls', checks: ['owner/visitor full viewport and overlay drawer', 'all catalog pages', 'static GLB thumbnails reused across placement copies', 'initial load never PUT', 'response-loss same-key retry followed by new draft', 'session expiry preserves draft and same-key replay after login', 'real mouse gizmo drag does not orbit or snap on ACK', '413/422 clear rejected request', '409 retains draft until explicit reload', 'dynamic UUID placement', 'same-source clone and removal share resources', 'server normalization matches geometry', 'real pointer-lock visit walk and return', 'stable share link reopen', 'visitor has no editor/backpack/details', 'visitor files carry grant scope', 'renewal retries same key and keeps snapshot', 'load failure never PUT'], pageErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); }
