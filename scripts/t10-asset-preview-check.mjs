import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=new URL('../docs/validation/evidence/t10-b/',import.meta.url);
const audit=JSON.parse(await fs.readFile(new URL('../assets/t10/geometry-audit.json',import.meta.url),'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const results={scope:'T10-B static GLB preview, not game navigation',browser:browser.version(),viewport:{width:1440,height:900},dpr:1};
try{
const page=await browser.newPage({viewport:results.viewport,deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:5174/preview.html');await page.waitForFunction(()=>window.__T10_PREVIEW?.ready||window.__T10_PREVIEW?.error);
const initial=await page.evaluate(()=>window.__T10_PREVIEW);assert.equal(initial.error,null);assert.equal(initial.stats.slotCount,30);assert.equal(initial.stats.meshCount,audit.meshObjects);assert.ok(Math.abs(initial.stats.floorChecks.upper.y-4.8)<.01);assert.ok(Math.abs(initial.stats.floorChecks.landing.y-2.4)<.01);assert.ok(initial.stats.floorChecks.atrium.y<.1);
await page.waitForTimeout(2000);await page.screenshot({path:new URL('browser-entry.png',out).pathname});
await page.getByRole('button',{name:'二层',exact:true}).click();await page.waitForTimeout(500);await page.screenshot({path:new URL('browser-upper.png',out).pathname});assert.equal(await page.evaluate(()=>window.__T10_PREVIEW.view),'upper');
await page.getByRole('button',{name:'楼梯',exact:true}).click();await page.waitForTimeout(500);await page.screenshot({path:new URL('browser-stairs.png',out).pathname});
await page.getByRole('button',{name:'外观',exact:true}).click();await page.getByRole('button',{name:'隐藏屋顶'}).click();await page.waitForTimeout(500);await page.screenshot({path:new URL('browser-cutaway.png',out).pathname});assert.equal(await page.evaluate(()=>window.__T10_PREVIEW.roofHidden),true);
await page.getByRole('button',{name:'显示屋顶'}).click();await page.waitForTimeout(500);await page.screenshot({path:new URL('browser-exterior.png',out).pathname});
results.state=await page.evaluate(()=>window.__T10_PREVIEW);results.errors=errors;assert.deepEqual(errors,[]);
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);results.smallViewport=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,canvasWidth:document.querySelector('canvas').clientWidth}));assert.equal(results.smallViewport.overflow,false);
// Verify visible failure, rather than a false ready, when asset loading fails.
const fail=await browser.newPage();await fail.route('**/pavilion-v1.glb',r=>r.abort());await fail.goto('http://127.0.0.1:5174/preview.html');await fail.waitForFunction(()=>Boolean(window.__T10_PREVIEW?.error));results.failedAssetShowsError=await fail.locator('#error').isVisible();assert.equal(results.failedAssetShowsError,true);await fail.close();
await fs.writeFile(new URL('browser-check.json',out),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
