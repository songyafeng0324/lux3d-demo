// T20 check on the user's Mac: the admin "上传历史" lists official-item and public-collection uploads with
// their status, and a failed upload says why in Chinese. Real API + PostgreSQL + worker validation + Chrome
// in an ISOLATED temporary database and store on 127.0.0.1:13020 (the main database is never touched).
// Requires `npm run build` first (the API serves apps/web/dist).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import pg from 'pg';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker} from '@aholo/domain';
import {migrate} from './migrate.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13020,base=`http://127.0.0.1:${port}`,out=process.env.T20_EVIDENCE_DIR||'docs/validation/evidence/t20';await fs.mkdir(out,{recursive:true});
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_t20_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t20-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),pw='t20-shots-'+randomBytes(9).toString('hex');
let app,browser;const errors=[];
/** A minimal valid GLB edited by `edit`; `indices` adds a zero-filled index accessor of that many entries. */
function glb(edit=()=>{}){
 const j={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-.5,0,0],max:[.5,1,0]}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36}],buffers:[{byteLength:36}]};
 edit(j);let json=Buffer.from(JSON.stringify(j));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const b=Buffer.from(new Float32Array([-.5,0,0,.5,0,0,0,1,0]).buffer),h=Buffer.alloc(20),bh=Buffer.alloc(8);
 h.writeUInt32LE(0x46546c67,0);h.writeUInt32LE(2,4);h.writeUInt32LE(28+json.length+b.length,8);h.writeUInt32LE(json.length,12);h.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(b.length);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([h,json,bh,b]);
}
try{
 await migrate(pool);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const store=new LocalFileStore(root);await store.initialize();const worker=new GenerationWorker(pool,store,config);
 await seedAdmin(pool,{username:'t20_admin',nickname:'馆务管理员',password:pw});
 const call=async(pathname,method,body,headers={})=>{const h={origin:base,'idempotency-key':randomUUID(),...headers};if(!(body instanceof FormData)&&body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw new Error(`${method} ${pathname} ${r.status} ${text}`);return {r,data:JSON.parse(text).data};};
 const {r:loginR,data:login}=await call('/auth/login','POST',{username:'t20_admin',password:pw});const admin={cookie:loginR.headers.get('set-cookie').split(';')[0],csrf:login.csrfToken};
 // Background rows through the API: other typical refusals, so the list shows several kinds of reasons.
 const seed=async(name,bytes,file)=>{const form=new FormData();form.set('sourceType','furniture');form.set('name',name);form.set('description','');form.set('file',new Blob([bytes]),file);const {data}=await call('/admin/assets','POST',form,{cookie:admin.cookie,'x-csrf-token':admin.csrf});await worker.tick(data.id);return data.id;};
 await seed('外链贴图测试',glb(j=>{j.images=[{uri:'https://example.invalid/wood.png'}];}),'linked.glb');
 await seed('Draco 压缩测试',glb(j=>{j.extensionsUsed=['KHR_draco_mesh_compression'];j.extensionsRequired=['KHR_draco_mesh_compression'];}),'draco.glb');
 await seed('截断文件测试',(await fs.readFile('tests/fixtures/models/chair.glb')).subarray(0,4096),'cut.glb');
 // A pre-T20 failure (only the error code was kept) shows the honest fallback text.
 await pool.query("UPDATE asset_imports SET error_detail=NULL,created_at=created_at-interval '1 day' WHERE metadata_snapshot->>'name'='截断文件测试'");

 const overBudget=path.join(root,'over-budget.glb');await fs.writeFile(overBudget,glb(j=>{j.accessors.push({componentType:5125,count:525003,type:'SCALAR'});j.meshes[0].primitives=[{attributes:{POSITION:0},indices:1},{attributes:{POSITION:0},indices:1}];}));
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const [name,value]=admin.cookie.split('=');await context.addCookies([{name,value,url:base}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource'))errors.push(m.text());});page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(r.status()+' '+new URL(r.url()).pathname);});
 await page.goto(base+'/admin');await page.getByRole('button',{name:'资产与上传'}).click();
 const history=page.locator('.adm-history');await history.getByText('外链贴图测试').waitFor();
 const latestId=async()=>(await pool.query('SELECT id FROM asset_imports ORDER BY created_at DESC LIMIT 1')).rows[0].id;
 const upload=page.locator('form.adm-upload');

 // 1) Legal GLB as an official item through the real form.
 await upload.getByRole('radio',{name:'官方物品'}).click();
 await upload.locator('input[name=file]').setInputFiles('tests/fixtures/models/table.glb');
 await upload.locator('input[name=name]').fill('测试方桌');
 await upload.getByRole('button',{name:'上传'}).click();
 const first=history.locator('.adm-import').first();await first.getByText('测试方桌').waitFor();
 assert.equal(await first.locator('.adm-status').textContent(),'处理中');
 await page.screenshot({path:path.join(out,'01-processing.png'),fullPage:true});
 assert.equal(await worker.tick(await latestId()),true);
 await page.waitForFunction(()=>document.querySelector('.adm-import .adm-status')?.textContent==='成功');
 // A finished upload refreshes the asset list beside it.
 await page.locator('.adm-row').filter({hasText:'测试方桌'}).waitFor();

 // 2) Over-budget GLB as a public collection item through the same form.
 await upload.getByRole('radio',{name:'公共藏品'}).click();
 await upload.locator('input[name=file]').setInputFiles(overBudget);
 for(const [field,v] of [['name','超面数测试鼎'],['description','校验失败样例'],['era','商代晚期'],['material','青铜'],['holderName','测试馆'],['location','测试地点']])await upload.locator(`[name=${field}]`).fill(v);
 await upload.locator('select[name=ownershipType]').selectOption('museum');
 await upload.getByRole('button',{name:'上传'}).click();
 await history.locator('.adm-import').first().getByText('超面数测试鼎').waitFor();
 assert.equal(await worker.tick(await latestId()),true);
 await page.waitForFunction(()=>document.querySelector('.adm-import .adm-status')?.textContent==='失败');
 const reason=await history.locator('.adm-import').first().locator('.adm-import-reason').textContent();
 assert.equal(reason,'三角面 350,002 个，超过上限 350,000 个，请减面后再上传');
 const texts=await history.locator('.adm-import').allTextContents();
 assert.ok(texts.some(t=>t.includes('外链贴图测试')&&t.includes('贴图是外链')),'external texture reason');
 assert.ok(texts.some(t=>t.includes('Draco 压缩测试')&&t.includes('Draco 网格压缩')),'compression reason');
 assert.ok(texts.some(t=>t.includes('截断文件测试')&&t.includes('早期记录')),'pre-T20 fallback');
 assert.ok(texts.every(t=>!t.includes('MODEL_INVALID')),'no bare error code');
 await page.screenshot({path:path.join(out,'02-history.png'),fullPage:true});
 await history.screenshot({path:path.join(out,'03-history-detail.png')});
 // Type filter.
 await history.getByLabel('上传类型').selectOption('official_candidate');
 await page.waitForFunction(()=>[...document.querySelectorAll('.adm-import strong')].every(n=>n.textContent==='超面数测试鼎'));
 await history.screenshot({path:path.join(out,'04-filter-collection.png')});
 // Phone width: the list stays readable, no horizontal scroll.
 await history.getByLabel('上传类型').selectOption('');await page.setViewportSize({width:390,height:900});await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'no horizontal scroll at 390px');
 await history.screenshot({path:path.join(out,'05-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,reason,rows:texts.length,out}));
}finally{await browser?.close();await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
