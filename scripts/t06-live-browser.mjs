// Read the private demo account; exercise the real site. No generation submitted.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {chromium} from 'playwright';
const root=path.join(os.homedir(),'Library/Application Support/aholo-lux3d/t06'),account=JSON.parse(await fs.readFile(path.join(root,'site-account.json'),'utf8')),base='http://localhost:5173',out='docs/validation/evidence/t06';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl']}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const hash=b=>createHash('sha256').update(b).digest('hex');
try{
 await page.goto(base+'/room?backpack=1');const bag=page.getByRole('dialog',{name:'背包',exact:true});
 await bag.getByLabel('用户名',{exact:true}).fill(account.username);await bag.getByLabel('密码',{exact:true}).fill(account.password);await bag.getByRole('button',{name:'登录并打开背包'}).click();await bag.getByText('今日可用').waitFor();
 const me=await page.request.get(base+'/api/v1/me').then(r=>r.json());assert.equal(me.data.quota.used,1);assert.equal(me.data.quota.available,2);assert.equal(me.data.activeTask,null);
 await bag.getByRole('button',{name:/资产01/}).click();await bag.getByText('拖动旋转 · 滚轮缩放').waitFor({timeout:30000});
 const canvas=bag.locator('.bag-preview canvas');const start=hash(await canvas.screenshot());const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.6,{steps:15});await page.mouse.up();await page.waitForTimeout(300);const rotated=hash(await canvas.screenshot());assert.notEqual(rotated,start);
 await page.mouse.wheel(0,-220);await page.waitForTimeout(300);const zoomed=hash(await canvas.screenshot());assert.notEqual(zoomed,rotated);
 await page.screenshot({path:out+'/backpack-real-model.png'});await page.keyboard.press('Escape');await page.getByRole('button',{name:'背包',exact:true}).click();await bag.getByText('今日可用').waitFor();assert.equal(await canvas.count(),1);
 await page.reload();await bag.getByText('今日可用').waitFor();await bag.getByRole('button',{name:'生成任务',exact:true}).click();await bag.getByText('已入背包',{exact:true}).waitFor();await page.screenshot({path:out+'/task-succeeded.png'});
 assert.deepEqual(errors,[]);const report={pass:true,realAPI:true,realGeneratedModel:true,username:account.username,taskId:account.taskId,browser:await browser.version(),quota:me.data.quota,sessionSurvivesReload:true,rotationChangesPixels:true,zoomChangesPixels:true,pageErrors:errors,checkedAt:new Date().toISOString()};await fs.writeFile(out+'/browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
