// 项目报告书：把 docs/report/项目报告书.html 渲染成 PDF（A4 横版，每页一张）。
// 用法：node scripts/build-report.mjs [--shots=<目录>]   加 --shots 时同时把每页导出成 PNG 供目检。
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const html = path.resolve('docs/report/项目报告书.html');
const pdf = path.resolve('docs/report/藏宝阁与个人小屋-项目报告书.pdf');
const shots = process.argv.find(a => a.startsWith('--shots='))?.slice(8);

const browser = await chromium.launch({ headless: true, channel: process.env.CHROME_CHANNEL ?? 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 1.5 });
  await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
  const n = await page.locator('section.page').count();
  // 溢出检查：任何页面内容比页面高/宽，就提示
  const overflow = await page.evaluate(() => [...document.querySelectorAll('section.page')].map((p, i) => {
    const main = p.querySelector('.main'); const foot = p.querySelector('.foot');
    const bad = [];
    if (main && foot && main.scrollHeight > main.clientHeight + 1) bad.push(`main 内容超出 ${main.scrollHeight - main.clientHeight}px`);
    if (main) for (const el of main.querySelectorAll('*')) { const r = el.getBoundingClientRect(); const f = foot.getBoundingClientRect(); if (r.height && r.bottom > f.top + 2 && !el.closest('.foot')) { bad.push(`${el.tagName}.${el.className} 压到页脚 ${Math.round(r.bottom - f.top)}px`); break; } }
    return bad.length ? `第 ${i + 1} 页：${bad.join('；')}` : null;
  }).filter(Boolean));
  console.log('页数', n, overflow.length ? '\n' + overflow.join('\n') : '无溢出');
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
  console.log('PDF', pdf, ((await fs.stat(pdf)).size / 1048576).toFixed(2) + ' MB');
  if (shots) {
    await fs.mkdir(shots, { recursive: true });
    for (let i = 0; i < n; i++) await page.locator('section.page').nth(i).screenshot({ path: path.join(shots, `p${String(i + 1).padStart(2, '0')}.png`) });
    console.log('页面截图 →', shots);
  }
} finally { await browser.close(); }
