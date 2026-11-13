// 项目报告书素材：用真实 Chrome 打开线上首页，拍进场画面、大殿、仰望、二层等机位。
// 用法：node scripts/report-live-shots.mjs [BASE=https://yafeng.fun]  输出到 docs/report/assets/live/
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'https://yafeng.fun';
const OUT = path.resolve('docs/report/assets/live');
await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('pageerror', e.message));
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const shot = async name => { await page.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 88 }); console.log('shot', name); };
await page.waitForTimeout(15000);
await shot('01-intro');
const btn = page.getByRole('button', { name: /进入藏宝阁/ });
await btn.click();
await page.waitForTimeout(12000);
await shot('02-hall');
const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
await hold('w', 2500); await page.waitForTimeout(1500); await shot('03-walk');
// 仰望天井
await page.mouse.move(720, 450); await page.mouse.move(720, 150, { steps: 10 }); await page.waitForTimeout(1500); await shot('04-look-up');

// 展品详情：走到镇阁台前按 E
await page.mouse.move(720, 150); await page.mouse.move(720, 450, { steps: 10 });
await hold('w', 900); await page.waitForTimeout(800);
await page.keyboard.press('e'); await page.waitForTimeout(3500); await shot('05-exhibit-detail');
await page.keyboard.press('Escape'); await page.waitForTimeout(800);
// 向左转身看西侧柱间展品
await page.mouse.move(720, 450); await page.mouse.move(420, 450, { steps: 12 }); await page.waitForTimeout(800);
await hold('w', 1800); await page.waitForTimeout(1200); await shot('06-west-bay');
await browser.close();
