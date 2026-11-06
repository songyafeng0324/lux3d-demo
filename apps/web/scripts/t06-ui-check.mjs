// UI regression only: API responses are intercepted; no Lux3D requests or DB writes.
// Run with Vite already serving: T06_UI_BASE=http://localhost:5173 node apps/web/scripts/t06-ui-check.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const evidenceDir = process.env.T06_UI_EVIDENCE_DIR;
if (evidenceDir) await fs.mkdir(evidenceDir, { recursive: true });
const shot = async name => { if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, name) }); };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const user = { id: 'user-1', username: 'demo_user', nickname: '藏家', role: 'user' };
const now = new Date().toISOString(); let logged = false, assets = [], tasks = [], firstGeneration = true;
const generationKeys = [];
await page.route('**/api/v1/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname.replace('/api/v1', ''), method = req.method();
  const ok = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, requestId: 'qa' }) });
  const fail = (status, message) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA', message }, requestId: 'qa' }) });
  if (path === '/auth/register') return ok({ user });
  if (path === '/auth/login') { logged = true; return ok({ user, csrfToken: 'csrf-qa' }); }
  if (path === '/me' && method === 'GET') return logged ? ok({ user, roomId: 'room-1', quota: { day: '2026-11-05', total: 3, used: tasks.length, available: 3 - tasks.length }, activeTask: tasks.find(task => task.status === 'processing') ?? null, csrfToken: 'csrf-qa' }) : fail(401, '请先登录');
  if (path === '/furniture') return ok({ items: [], nextCursor: null });
  if (path === '/rooms/me') return ok({ id: 'room-1', name: '藏家小屋', version: 1, sceneVersion: 'courtyard-v1', placements: [], assets: [], shareEnabled: false });
  if (path === '/files/input-1/content') return route.fulfill({ status: 200, contentType: 'image/png', body: await fs.readFile(new URL('../../../tests/fixtures/lux3d-vase.png', import.meta.url)) });
  if (path === '/assets' && method === 'GET') return ok({ items: assets, nextCursor: null });
  if (path.startsWith('/assets/') && method === 'GET') { const asset = assets.find(item => item.id === path.split('/').at(-1)); return asset ? ok(asset) : fail(404, '未找到藏品'); }
  if (path === '/generation-tasks' && method === 'GET') return ok({ items: tasks, nextCursor: null });
  if (method !== 'GET' && !['/auth/register', '/auth/login'].includes(path)) assert.equal(req.headers()['x-csrf-token'], 'csrf-qa');
  if (path === '/uploads/images') return ok({ inputFileId: 'input-1' });
  if (path === '/generation-tasks' && method === 'POST') {
    generationKeys.push(req.headers()['idempotency-key']);
    tasks = [{ id: 'task-1', status: 'processing', submittedDay: '2026-11-05', createdAt: now, assetId: null, errorCode: null }];
    if (firstGeneration) { firstGeneration = false; return route.abort('connectionreset'); }
    return ok(tasks[0]);
  }
  if (path === '/files/model-1/content') return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: await fs.readFile(new URL('../../../assets/t10/pavilion-v1.glb', import.meta.url)) });
  if (path === '/assets/asset-1' && method === 'PATCH') { assets[0] = { ...assets[0], ...req.postDataJSON() }; return ok(assets[0]); }
  if (path === '/me' && method === 'PATCH') { user.nickname = req.postDataJSON().nickname; return ok({ user }); }
  if (['/me/password', '/auth/logout'].includes(path)) { logged = false; return route.fulfill({ status: 204 }); }
  return fail(404, path);
});
try {
  await page.goto(process.env.T06_UI_BASE || 'http://localhost:5173');
  await page.getByRole('button', { name: '进入藏宝阁', exact: true }).click();
  await page.keyboard.press('KeyM');
  await page.getByRole('button', { name: '账号设置' }).click();
  const account = page.getByRole('dialog', { name: '账号设置', exact: true });
  await account.getByRole('button', { name: '注册', exact: true }).click();
  await account.getByLabel('用户名', { exact: true }).fill('demo_user');
  await account.getByLabel('昵称', { exact: true }).fill('藏家');
  await account.getByLabel('密码', { exact: true }).fill('password-123456');
  await account.getByLabel('确认密码', { exact: true }).fill('password-123456');
  await account.getByRole('button', { name: '创建账号' }).click();
  await account.getByText('注册成功，请用刚才的账号和密码登录。').waitFor();
  await account.getByLabel('用户名', { exact: true }).fill('demo_user');
  await account.getByLabel('密码', { exact: true }).fill('password-123456');
  await account.getByRole('button', { name: '登录账号', exact: true }).click();
  await account.getByText('已登录。').waitFor();
  assert.equal(await account.getByLabel('选择生成图片').count(), 0);
  await page.goto(new URL('/room?backpack=1', page.url()).href);
  const bag = page.getByRole('dialog', { name: '背包', exact: true });
  await bag.getByText('今日可用').waitFor();
  await bag.getByLabel('选择生成图片').setInputFiles(new URL('../../../tests/fixtures/lux3d-vase.png', import.meta.url).pathname);
  await bag.getByRole('button', { name: '生成模型 · 使用 1 次' }).click();
  await bag.getByRole('button', { name: '确认原生成请求' }).waitFor();
  await shot('01-generation-retry.png');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '背包', exact: true }).click();
  await bag.getByRole('button', { name: '确认原生成请求' }).waitFor();
  await page.reload();
  await bag.getByRole('button', { name: '确认上次生成提交' }).click();
  await bag.getByText('任务已受理，离开页面后仍会继续。模型可预览后会进入背包。').waitFor();
  assert.equal(generationKeys.length, 2); assert.equal(generationKeys[0], generationKeys[1]);
  tasks[0] = { ...tasks[0], status: 'succeeded', assetId: 'asset-1' };
  assets = [{ id: 'asset-1', name: '资产01', description: '', modelFileId: 'model-1', originalImageId: 'input-1', createdAt: now, normalization: {}, bounds: {} }];
  await bag.getByRole('button', { name: '刷新', exact: true }).click();
  await bag.getByRole('button', { name: '查看藏品 →' }).click();
  await bag.getByText('拖动旋转 · 滚轮缩放').waitFor();
  await shot('02-model-preview.png');
  const saveAsset = bag.getByRole('button', { name: '保存资料' });
  const assetForm = bag.locator('form').filter({ has: page.getByRole('button', { name: '保存资料' }) });
  await assetForm.getByLabel('名称', { exact: true }).fill('我的瓷瓶');
  await assetForm.getByLabel('简介', { exact: true }).fill('个人收藏');
  await saveAsset.click();
  await bag.getByText('藏品资料已保存。').waitFor(); assert.equal(assets[0].name, '我的瓷瓶');
  await bag.getByRole('button', { name: '← 返回全部藏品' }).click();
  await bag.locator('.bag-asset-card img').waitFor();
  await page.waitForFunction(() => document.querySelector('.bag-asset-card img')?.naturalWidth > 0);
  assert.equal(await bag.locator('.bag-asset-card .asset-short-name').textContent(), '我的瓷瓶');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await page.getByRole('button', { name: '账号设置' }).click();
  await account.getByLabel('昵称', { exact: true }).fill('新藏家');
  await account.getByRole('button', { name: '保存昵称' }).click();
  await account.getByText('昵称已更新。').waitFor(); assert.equal(user.nickname, '新藏家');
  await page.locator('.room-identity').getByText('新藏家').waitFor();
  await account.getByLabel('原密码', { exact: true }).fill('password-123456');
  await account.getByLabel('新密码', { exact: true }).fill('new-password-123');
  await account.getByLabel('确认新密码', { exact: true }).fill('new-password-123');
  await account.getByRole('button', { name: '修改并重新登录' }).click();
  await account.getByText('密码已修改，请重新登录。').waitFor();
  assert.equal(await account.getByRole('button', { name: '登录账号', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /登录后进入自己的小屋/ }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pass: true, scope: 'UI with intercepted API; no supplier call', checks: ['register/login', 'quota', 'image upload', 'same-key replay after response loss', 'drawer close and reload retain request', 'task refresh', 'actual GLB render', 'asset editing', 'nickname editing', 'uploaded image thumbnail', 'account settings on both pages', 'password change clears room session'], browser: browser.version(), pageErrors: errors, generationRequests: generationKeys.length, sameKey: generationKeys[0] === generationKeys[1] }, null, 2));
} finally { await browser.close(); }
