import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createPool, loadConfig } from '@aholo/domain';
import { buildApp } from '../apps/api/dist/app.js';
import { exec } from './backup.mjs';
import { restoreCheck } from './restore-check.mjs';

const evidence = 'docs/validation/evidence/t09';
const privateRoot = path.join(os.homedir(), 'Library/Application Support/aholo-lux3d');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const round = ms => Math.round(ms * 100) / 100;
const writeReport = (name, value) => fs.writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');

async function verifyMain(base) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const original = await readJson('docs/validation/evidence/t06/real-delivery.json');
  const demo = await readJson(path.join(privateRoot, 't06/site-account.json'));
  const admin = await readJson(path.join(privateRoot, 't08/admin-account.json'));
  const layout = await readJson('assets/t16/pavilion-layout.json');
  const pool = createPool(loadConfig().databaseUrl);
  let database;
  try {
    const { rows: [model] } = await pool.query(`
      SELECT t.status, t.submitted_day::text, a.state AS asset_state, f.sha256,
             pa.provider_task_id, pa.delivery_receipt->>'rendered' AS rendered,
             (SELECT count(*)::int FROM quota_events WHERE task_id=t.id AND kind='reserve') AS reserve,
             (SELECT count(*)::int FROM quota_events WHERE task_id=t.id AND kind='refund') AS refund,
             (SELECT count(*)::int FROM provider_attempts WHERE task_id=t.id) AS attempts
      FROM generation_tasks t JOIN assets a ON a.id=t.result_asset_id
      JOIN files f ON f.id=a.model_file_id JOIN provider_attempts pa ON pa.id=t.attempt_id
      WHERE t.id=$1 AND a.id=$2 AND f.state='committed'`, [demo.taskId, original.asset_id]);
    assert.ok(model);
    assert.deepEqual([model.status, model.asset_state, model.rendered, model.reserve, model.refund, model.attempts],
      ['succeeded', 'ready', 'true', 1, 0, 1]);
    assert.equal(model.sha256, original.sha256);
    assert.equal(model.provider_task_id, original.provider_task_id);
    database = {
      version: (await pool.query('SHOW server_version')).rows[0].server_version,
      migrations: (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name),
      model,
    };
  } finally {
    await pool.end();
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl'] });
  const pageErrors = [];
  const viewport = { width: 1440, height: 900 };
  const hint = '请使用配有键盘和鼠标的电脑操作 3D 场景。';
  async function page(options = { viewport }) {
    const context = await browser.newContext(options);
    const tab = await context.newPage();
    tab.on('pageerror', error => pageErrors.push(error.message));
    return tab;
  }
  async function get(tab, pathname) {
    const response = await tab.request.get(base + '/api/v1' + pathname);
    assert.equal(response.status(), 200);
    return (await response.json()).data;
  }
  async function login(tab, account) {
    const response = await tab.request.post(base + '/api/v1/auth/login', {
      headers: { origin: base }, data: { username: account.username, password: account.password },
    });
    assert.equal(response.status(), 200);
  }

  try {
    const owner = await page();
    await owner.goto(base + '/room?backpack=1');
    const bag = owner.getByRole('dialog', { name: '背包' });
    await bag.getByLabel('用户名', { exact: true }).fill(demo.username);
    await bag.getByLabel('密码', { exact: true }).fill(demo.password);
    assert.equal(await bag.getByText(/找回密码|重置密码|临时密码/).count(), 0);
    await bag.getByRole('button', { name: '登录并打开背包' }).click();
    await bag.getByRole('button', { name: /资产01/ }).click();
    await bag.getByText('拖动旋转 · 滚轮缩放').waitFor();
    await owner.screenshot({ path: path.join(evidence, 'real-backpack.png') });
    const modelResponse = await owner.request.get(base + '/api/v1/files/' + original.model_file_id + '/content');
    assert.equal(modelResponse.status(), 200);
    assert.equal(modelResponse.headers()['cache-control'], 'private, no-store');
    assert.equal(hash(await modelResponse.body()), original.sha256);
    const task = await get(owner, '/generation-tasks/' + demo.taskId);
    assert.equal(task.assetId, original.asset_id);
    assert.equal(task.status, 'succeeded');
    const submission = (await get(owner, '/submissions?assetId=' + original.asset_id)).items[0];
    assert.equal(submission.status, 'approved');
    const room = await get(owner, '/rooms/me');
    assert.ok(room.placements.some(placement => placement.assetId === original.asset_id));
    await owner.close();

    const visitor = await page();
    const sharedUrl = base + new URL(room.shareUrl, base).pathname;
    await visitor.goto(sharedUrl);
    await visitor.waitForFunction(count => window.__room?.engine.debug().instances === count, room.placements.length);
    assert.equal(await visitor.getByRole('toolbar').count(), 0);
    assert.equal(await visitor.getByText(hint, { exact: true }).isVisible(), false);
    await visitor.screenshot({ path: path.join(evidence, 'real-shared-room.png') });

    const gallery = await get(visitor, '/gallery');
    const slot = gallery.slots.find(item => item.exhibit?.model.modelFileId === original.model_file_id);
    assert.ok(slot);
    const marker = layout.exhibitSlots.find(item => item.id === 'T' + String(slot.slotNo).padStart(2, '0'));
    const [x, y, z] = marker.position;
    const started = performance.now();
    await visitor.goto(base);
    await visitor.getByRole('button', { name: '进入藏宝阁' }).click();
    await visitor.waitForFunction(() => window.__t10?.ui().exhibits > 0);
    const exhibitLoadMs = round(performance.now() - started);
    await visitor.evaluate(([px, pz, py, yaw]) => window.__t10.engine.debugPlace(px, pz, py, yaw, -.22),
      [x + (x < 0 ? 1.7 : -1.7), z, y, x < 0 ? Math.PI / 2 : -Math.PI / 2]);
    await visitor.locator('.t10-prompt').getByText(slot.exhibit.name, { exact: true }).waitFor();
    await visitor.keyboard.press('KeyE');
    const detail = visitor.getByRole('dialog', { name: slot.exhibit.name + '详情' });
    await detail.getByText('投稿 · ' + submission.publicSnapshot.sourceNickname).waitFor();
    await detail.getByText(submission.publicSnapshot.holderName, { exact: true }).waitFor();
    await detail.getByText('拖动旋转 · 滚轮缩放').waitFor();
    const canvas = detail.locator('.bag-preview canvas');
    const before = hash(await canvas.screenshot());
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await visitor.mouse.move(cx, cy);
    await visitor.mouse.down();
    await visitor.mouse.move(cx + 50, cy + 20, { steps: 12 });
    await visitor.mouse.up();
    await visitor.waitForTimeout(300);
    const rotated = hash(await canvas.screenshot());
    assert.notEqual(rotated, before);
    await visitor.mouse.wheel(0, -200);
    await visitor.waitForTimeout(300);
    assert.notEqual(hash(await canvas.screenshot()), rotated);
    await visitor.screenshot({ path: path.join(evidence, 'real-exhibit.png') });
    await visitor.keyboard.press('Escape');
    await detail.waitFor({ state: 'hidden' });
    await visitor.close();

    const manager = await page();
    await login(manager, admin);
    await manager.goto(base + '/admin');
    await manager.getByRole('button', { name: '用户与额度' }).click();
    await manager.locator('.adm-row', { hasText: demo.username }).click();
    assert.equal(await manager.getByText(/找回密码|重置密码|临时密码|停用账号|编辑房间/).count(), 0);
    const users = await get(manager, '/admin/users');
    const user = users.items.find(item => item.username === demo.username);
    const accountInfo = await get(manager, '/admin/users/' + user.id);
    assert.ok(accountInfo.user.createdAt && accountInfo.user.nickname);
    assert.ok(accountInfo.counts.assets > 0);
    await manager.close();

    const mobile = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    assert.ok(await mobile.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches));
    await mobile.goto(base);
    await mobile.getByText(hint, { exact: true }).waitFor();
    await mobile.screenshot({ path: path.join(evidence, 'mobile-hint.png') });
    await mobile.goto(sharedUrl);
    await mobile.getByText(hint, { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
    await writeReport('main.json', {
      pass: true, chrome: browser.version(), database, taskId: demo.taskId, assetId: original.asset_id,
      roomVersion: room.version, placements: room.placements.length, galleryVersion: gallery.version, slot: slot.slotNo,
      exhibitLoadMs, anonymousRoom: true, previewRotateZoom: true, adminAccountDetail: true,
      noPasswordRecoveryControls: true, touchHint: true, newProviderCalls: 0, pageErrors,
    });
  } finally {
    await browser.close();
  }
}

async function tenSessions(base) {
  const samples = new Map();
  async function request(kind, pathname, { method = 'GET', body, auth = {} } = {}) {
    const started = performance.now();
    const response = await fetch(base + '/api/v1' + pathname, {
      method, headers: { origin: base, 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...auth },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    const entries = samples.get(kind) ?? [];
    entries.push(round(performance.now() - started));
    samples.set(kind, entries);
    assert.ok(response.ok, kind + ' HTTP ' + response.status + ' ' + result.error?.code);
    return { data: result.data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const password = randomBytes(18).toString('base64url');
  const prefix = 't09_' + randomBytes(5).toString('hex');
  const users = Array.from({ length: 10 }, (_, index) => ({
    username: prefix + index, nickname: '验收访客 ' + index, password, confirmPassword: password,
  }));
  for (const body of users) await request('setup', '/auth/register', { method: 'POST', body });
  samples.delete('setup');

  const rounds = 20;
  const started = performance.now();
  const outcomes = await Promise.allSettled(users.map(async ({ username }, index) => {
    const login = await request('login', '/auth/login', { method: 'POST', body: { username, password } });
    const auth = { cookie: login.cookie, 'x-csrf-token': login.data.csrfToken };
    const initialRoom = (await request('room', '/rooms/me', { auth })).data;
    const furniture = (await request('furniture', '/furniture', { auth })).data.items[0];
    assert.ok(furniture);
    const placements = [{ id: 't09-placement', assetId: furniture.id, position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }];
    let version = initialRoom.version;
    for (let step = 1; step <= rounds; step++) {
      const [backpack, gallery, saved] = await Promise.all([
        request('backpack', '/assets', { auth }),
        request('gallery', '/gallery'),
        request('save', '/rooms/me/layout', {
          method: 'PUT', auth, body: { baseVersion: version, editSequence: step, name: '验收小屋 ' + index + '-' + step, placements },
        }),
      ]);
      assert.deepEqual(backpack.data.items, []);
      assert.equal(gallery.data.slots.length, 30);
      assert.equal(saved.data.savedVersion, version + 1);
      assert.equal(saved.data.editSequence, step);
      version = saved.data.savedVersion;
    }
    const finalRoom = (await request('room', '/rooms/me', { auth })).data;
    assert.equal(finalRoom.id, initialRoom.id);
    assert.equal(finalRoom.version, version);
    assert.equal(finalRoom.name, '验收小屋 ' + index + '-' + rounds);
    assert.deepEqual(finalRoom.placements, placements);
    return { cookie: login.cookie, user: login.data.user.id, room: initialRoom.id };
  }));
  const sessions = outcomes.map(outcome => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
  for (const key of ['cookie', 'user', 'room']) assert.equal(new Set(sessions.map(session => session[key])).size, 10);
  const latencyMs = Object.fromEntries([...samples].sort().map(([kind, values]) => {
    values.sort((a, b) => a - b);
    return [kind, { requests: values.length, p50: values[Math.ceil(values.length * .5) - 1],
      p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) }];
  }));
  return { pass: true, sessions: sessions.length, rounds, requests: [...samples.values()].flat().length,
    errors: 0, elapsedMs: round(performance.now() - started), latencyMs };
}

async function sampleRoom(base) {
  const account = await readJson(path.join(privateRoot, 't06/site-account.json'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.5 });
    const cdp = await page.context().newCDPSession(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const login = await page.request.post(base + '/api/v1/auth/login', {
      headers: { origin: base }, data: { username: account.username, password: account.password },
    });
    assert.equal(login.status(), 200);
    const { data: { csrfToken } } = await login.json();
    const room = (await (await page.request.get(base + '/api/v1/rooms/me')).json()).data;
    const furniture = (await (await page.request.get(base + '/api/v1/furniture')).json()).data.items;
    assert.ok(room.placements.length && furniture.length >= 3);
    const personal = room.placements.find(placement => !furniture.some(item => item.id === placement.assetId));
    assert.ok(personal);
    let version = room.version;
    const open = async count => {
      const started = performance.now();
      await page.goto(base + '/room');
      await page.waitForFunction(count => window.__room?.engine.debug().instances === count, count);
      return round(performance.now() - started);
    };
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    const cases = [];
    for (const count of [30, 100]) {
      const placements = Array.from({ length: count }, (_, index) => {
        const item = index % 2 === 0 ? personal : { ...personal, assetId: furniture[index % 3].id, scale: .6 };
        return { ...item, id: 't09-mixed-' + index, position: [(index % 10 - 4.5) * .6, 0, (Math.floor(index / 10) - 4.5) * .6] };
      });
      const save = await page.request.put(base + '/api/v1/rooms/me/layout', {
        headers: { origin: base, 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID() },
        data: { baseVersion: version, editSequence: count, name: '性能验收小屋', placements },
      });
      assert.equal(save.status(), 200);
      version = (await save.json()).data.savedVersion;
      const firstLoadMs = await open(count);
      const metrics = await page.evaluate(async () => {
        const frames = [];
        for (let previous = await new Promise(requestAnimationFrame); frames.length < 120;) {
          const now = await new Promise(requestAnimationFrame);
          frames.push(now - previous);
          previous = now;
        }
        frames.sort((a, b) => a - b);
        const renderer = window.__room.engine.renderer;
        const gl = renderer.getContext();
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return { frameMedianMs: frames[60], frameP95Ms: frames[113], drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles, pixelRatio: renderer.getPixelRatio(),
          gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
      });
      const heapBefore = await heap();
      const reentryMs = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        await page.goto('about:blank');
        reentryMs.push(await open(count));
      }
      cases.push({ placements: count, firstLoadMs, reentryMs, heapBefore, heapAfter: await heap(), ...metrics });
    }
    assert.deepEqual(errors, []);
    await writeReport('room-performance.json', { chrome: browser.version(), viewport: [1500, 1000], cases, errors });
  } finally {
    await browser.close();
  }
}

async function verifyRestore(backupDir) {
  const base = 'http://127.0.0.1:13010';
  const result = await restoreCheck(backupDir, loadConfig(), async config => {
    const app = await buildApp({ ...config, publicOrigin: base });
    try {
      await app.listen({ host: '127.0.0.1', port: 13010 });
      const load = await tenSessions(base);
      await writeReport('load.json', load);
      const { stdout } = await exec(process.execPath, ['scripts/t07-browser.mjs'], {
        env: { ...process.env, T07_BASE: base, T07_EVIDENCE_DIR: path.join(evidence, 'restored-room'),
          T07_PRIVATE_DIR: path.join(config.dataDir, 't07-private') },
      });
      process.stdout.write(stdout);
      await sampleRoom(base);
    } finally {
      await app.close();
    }
  });
  await writeReport('restore.json', { pass: true, ...result, applicationVerified: true });
}

await fs.mkdir(evidence, { recursive: true });
if (process.argv[2] === 'main') await verifyMain(process.env.T09_BASE || 'http://127.0.0.1:13009');
else if (process.argv[2] === 'restore' && process.argv[3]) await verifyRestore(process.argv[3]);
else throw new Error('Usage: node scripts/t09-acceptance.mjs main | restore <backup-directory>');
