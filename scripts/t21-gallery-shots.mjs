// T21 check on the user's Mac: the admin "候选与展位" page is candidate-first — candidates on the left with the
// first one selected and previewed, a slot panel (1–30 by tier) behind the top-right button, and one publish for
// all changes. Real API + PostgreSQL + worker validation + Chrome in an ISOLATED temporary database and store on
// 127.0.0.1:13021 (the main database is never touched). Requires `npm run build` first.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import pg from 'pg';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker} from '@aholo/domain';
import {migrate} from './migrate.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13021,base=`http://127.0.0.1:${port}`,out=process.env.T21_EVIDENCE_DIR||'docs/validation/evidence/t21';await fs.mkdir(out,{recursive:true});
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_t21_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t21-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),pw='t21-shots-'+randomBytes(9).toString('hex');
let app,browser;const errors=[];
try{
 await migrate(pool);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const store=new LocalFileStore(root);await store.initialize();const worker=new GenerationWorker(pool,store,config);
 await seedAdmin(pool,{username:'t21_admin',nickname:'馆务管理员',password:pw});
 const call=async(pathname,method,body,headers={})=>{const h={origin:base,'idempotency-key':randomUUID(),...headers};if(!(body instanceof FormData)&&body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw new Error(`${method} ${pathname} ${r.status} ${text}`);return {r,data:JSON.parse(text).data};};
 const {r:loginR,data:login}=await call('/auth/login','POST',{username:'t21_admin',password:pw});const admin={cookie:loginR.headers.get('set-cookie').split(';')[0],csrf:login.csrfToken};
 // Three public-collection candidates (fixture GLBs, imported only into this temp database); the newest is listed first.
 for(const [name,file,era,material] of [['乌木圈椅','chair.glb','明代','乌木'],['黄花梨方桌','table.glb','清代','黄花梨'],['紫檀顶箱柜','cabinet.glb','清代','紫檀']]){
  const form=new FormData();form.set('sourceType','official_candidate');for(const [k,v] of Object.entries({name,description:`${name}，测试用候选藏品。`,era,material,ownershipType:'museum',holderName:'测试博物馆',location:'北京',officialUrl:''}))form.set(k,v);
  form.set('file',new Blob([await fs.readFile('tests/fixtures/models/'+file)]),file);const {data}=await call('/admin/assets','POST',form,{cookie:admin.cookie,'x-csrf-token':admin.csrf});assert.equal(await worker.tick(data.id),true);
 }
 // Start from a published gallery with 乌木圈椅 on slot 1, so replacing is visible.
 const cands=(await call('/admin/candidates','GET',undefined,{cookie:admin.cookie})).data.items;const id=n=>cands.find(c=>c.publicSnapshot.name===n).id;
 const g=(await call('/admin/gallery','GET',undefined,{cookie:admin.cookie})).data;
 await call('/admin/gallery','PUT',{baseVersion:g.version,slots:g.slots.map(s=>({slotNo:s.slotNo,candidateId:s.slotNo===1?id('乌木圈椅'):null}))},{cookie:admin.cookie,'x-csrf-token':admin.csrf});

 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const context=await browser.newContext({viewport:{width:1440,height:960}});
 const [name,value]=admin.cookie.split('=');await context.addCookies([{name,value,url:base}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource'))errors.push(m.text());});page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(r.status()+' '+new URL(r.url()).pathname);});
 await page.goto(base+'/admin');await page.getByRole('button',{name:'候选与展位'}).click();
 const rows=page.locator('.adm-gallery .adm-row'),detail=page.locator('.adm-gallery .adm-detail');
 // 1) First look: the first candidate is selected and its model previews on the right.
 await rows.first().and(page.locator('[aria-pressed=true]')).waitFor();
 assert.equal(await rows.first().locator('strong').textContent(),'紫檀顶箱柜');
 await detail.locator('h2',{hasText:'紫檀顶箱柜'}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.adm-detail canvas')&&!document.querySelector('.adm-detail .bag-preview-status'),null,{timeout:60000});
 assert.equal(await rows.filter({hasText:'乌木圈椅'}).locator('small').textContent(),'镇阁 · 展位 1');
 await page.screenshot({path:path.join(out,'01-first-look.png')});
 // 2) The slot panel: 30 slots grouped by tier, the occupied one offers to replace.
 await page.getByRole('button',{name:'安排展位 ▾'}).click();const panel=page.getByRole('dialog',{name:'为「紫檀顶箱柜」选择展位'});
 assert.equal(await panel.locator('.adm-slot').count(),30);
 assert.deepEqual(await panel.locator('.adm-tier h3').allTextContents(),['镇阁 展位 1 · 最大边 5 m','甲 展位 2–10 · 最大边 2.5 m','乙 展位 11–30 · 最大边 1.6 m']);
 const slot=n=>page.getByRole('dialog').locator('.adm-slot').filter({has:page.locator('small',{hasText:new RegExp(`^${n} · `)})});
 await slot(1).getByText('替换「乌木圈椅」').waitFor();
 await page.screenshot({path:path.join(out,'02-slot-panel.png')});
 // 3) Replace slot 1: the chair leaves the gallery, nothing is published yet.
 await slot(1).click();await panel.waitFor({state:'detached'});
 assert.equal(await rows.filter({hasText:'紫檀顶箱柜'}).locator('small').textContent(),'镇阁 · 展位 1');
 assert.equal(await rows.filter({hasText:'乌木圈椅'}).locator('small').textContent(),'未上展');
 // 4) Another one onto a 甲 slot, then move it: still one change for it.
 await rows.filter({hasText:'黄花梨方桌'}).click();await detail.locator('h2',{hasText:'黄花梨方桌'}).waitFor();
 await page.getByRole('button',{name:'安排展位 ▾'}).click();await slot(3).click();
 await page.getByRole('button',{name:'调整展位 ▾'}).click();await page.getByRole('dialog').locator('.adm-slot[aria-current=true]').getByText('当前位置').waitFor();
 await page.getByRole('dialog').locator('.adm-slot').filter({has:page.locator('small',{hasText:/^5 · /})}).click();
 assert.equal(await rows.filter({hasText:'黄花梨方桌'}).locator('small').textContent(),'甲 · 展位 5');
 await page.locator('.adm-unsaved',{hasText:'未保存 2 处'}).waitFor();
 assert.equal(await page.locator('.adm-gallery .adm-row[data-changed=true]').count(),3,'three candidates moved');
 await page.screenshot({path:path.join(out,'03-unsaved.png')});
 // Leaving the tab with unsaved changes asks first; dismissing keeps the draft.
 page.once('dialog',d=>{assert.match(d.message(),/还没保存/);void d.dismiss();});
 await page.getByRole('button',{name:'资产与上传'}).click();await page.locator('.adm-unsaved').waitFor();
 // 5) Filter, then publish once.
 await page.getByLabel('候选筛选').selectOption('free');await rows.first().waitFor();assert.deepEqual(await rows.locator('strong').allTextContents(),['乌木圈椅']);
 await detail.locator('h2',{hasText:'乌木圈椅'}).waitFor();await page.getByLabel('候选筛选').selectOption('all');
 await page.getByRole('button',{name:'保存并发布'}).click();await page.getByText(/已发布展陈第 \d+ 版/).waitFor();
 await page.locator('.adm-unsaved').waitFor({state:'detached'});
 const published=(await call('/admin/gallery','GET',undefined,{cookie:admin.cookie})).data.slots;
 assert.equal(published[0].candidateId,id('紫檀顶箱柜'));assert.equal(published[4].candidateId,id('黄花梨方桌'));assert.equal(published[2].candidateId,null);assert.ok(!published.some(s=>s.candidateId===id('乌木圈椅')));
 await page.screenshot({path:path.join(out,'04-published.png')});
 // 6) Remove from the gallery.
 await rows.filter({hasText:'黄花梨方桌'}).click();await page.getByRole('button',{name:'调整展位 ▾'}).click();await page.getByRole('button',{name:'撤下展位'}).click();
 assert.equal(await rows.filter({hasText:'黄花梨方桌'}).locator('small').textContent(),'未上展');await page.locator('.adm-unsaved',{hasText:'未保存 1 处'}).waitFor();
 await page.getByRole('button',{name:'放弃修改'}).click();await page.locator('.adm-unsaved').waitFor({state:'detached'});
 assert.equal(await rows.filter({hasText:'黄花梨方桌'}).locator('small').textContent(),'甲 · 展位 5');
 // Phone width: list above detail, no horizontal page scroll.
 await page.setViewportSize({width:390,height:900});await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'no horizontal scroll at 390px');
 await page.getByRole('button',{name:'调整展位 ▾'}).click();await page.screenshot({path:path.join(out,'05-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,out}));
}finally{await browser?.close();await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
