// T16 D1: framing screenshots of the graybox pavilion from fixed viewpoints (evidence only, no assertions
// beyond page health). Usage (repo root, dev server running): node scripts/t16-graybox-shots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const BASE = process.env.T10_BASE || 'http://localhost:5173';
const OUT = process.env.T16_SHOTS_OUT ? new URL(`file://${process.env.T16_SHOTS_OUT.replace(/\/?$/, '/')}`) : new URL('../docs/validation/evidence/t16/', import.meta.url);
await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL ?? 'chrome', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto(BASE + '/');
await page.waitForFunction(() => ['intro', 'failed'].includes(window.__t10?.ui().phase), null, { timeout: 60000 });
await page.getByRole('button', { name: '进入藏宝阁' }).click();
await page.waitForFunction(n => window.__t10.ui().exhibits >= n, 1, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
const VIEWS = (process.env.T16_VIEWS ? JSON.parse(process.env.T16_VIEWS) : [
  ['01-entry', 0, 24, 0, 0, 0.12, 'third'],
  ['02-atrium-up', 3, 7, 0, 0.3, 0.75, 'first'],
  ['03-upper-east', 15, 2, 9, 1.35, -0.12, 'third'],
  ['04-grand-stair', 0, -11, 0, 0, 0.18, 'third'],
  ['05-alcove', -17.5, 5, 0, -1.35, -0.05, 'third'],
  ['06-exterior', 0, 26, 0, Math.PI, 0.02, 'third'],
  ['07-landing-back', 0, -27, 4.5, Math.PI, -0.15, 'third'],
  ['08-side-hall', -14, 20, 0, 0, 0.05, 'first'],
]);
const out = [];
for (const [name, x, z, y, yaw, pitch, view] of VIEWS) {
  await page.evaluate(([x, z, y, yaw, pitch, view]) => { const e = window.__t10.engine; e.setView(view); e.debugPlace(x, z, y, yaw, pitch); }, [x, z, y, yaw, pitch, view]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: new URL(name + '.png', OUT).pathname });
  out.push({ name, ...(await page.evaluate(() => (({ fps, calls, triangles, exhibits }) => ({ fps, calls, triangles, exhibits: exhibits.length }))(window.__t10.engine.debugState()))) });
}
console.log(JSON.stringify({ errors, out }, null, 1));
await browser.close();
