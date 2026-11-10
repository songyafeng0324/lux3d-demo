// T18 check on the user's Mac: owner deletes a generated asset from the backpack (with a second
// confirmation), thumbnails fill their frame, and the admin upload previews the chosen GLB on the right.
// Real API + PostgreSQL + Chrome in an ISOLATED temporary database and store on 127.0.0.1:13018
// (the main database is never touched). Requires `npm run build` first (the API serves apps/web/dist).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';import pg from 'pg';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin} from '@aholo/domain';
import {migrate} from './migrate.mjs';import {seedFurniture} from './seed-furniture.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13018,base=`http://127.0.0.1:${port}`,out=process.env.T18_EVIDENCE_DIR||'docs/validation/evidence/t18';await fs.mkdir(out,{recursive:true});
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_t18_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t18-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),pw='t18-shots-'+randomBytes(9).toString('hex');
let app,browser;const errors=[];
try{
 await migrate(pool);await seedFurniture(config);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const store=new LocalFileStore(root);await store.initialize();
 await seedAdmin(pool,{username:'t18_admin',nickname:'馆务管理员',password:pw});
 const call=async(pathname,method,body,headers={})=>{const h={origin:base,'idempotency-key':randomUUID(),...headers};if(body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw new Error(pathname+' '+r.status+' '+text);return {r,data:text?JSON.parse(text).data:null};};
 await call('/auth/register','POST',{username:'t18_owner',nickname:'小屋主人',password:pw,confirmPassword:pw});
 const login=async username=>{const {r,data}=await call('/auth/login','POST',{username,password:pw});return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrfToken,user:data.user};};
 const owner=await login('t18_owner');
 // Two already-delivered personal assets (real GLB bytes, no original photo so the card shows the render).
 const assets={};
 for(const [name,file] of [['测试方桌','table.glb'],['测试柜子','cabinet.glb']]){
  const bytes=await fs.readFile('tests/fixtures/models/'+file),hash=createHash('sha256').update(bytes).digest('hex'),fileId=randomUUID(),image=randomUUID(),id=randomUUID(),task=randomUUID();
  await store.commit(await store.putStaged(bytes),fileId,hash);
  const png=Buffer.from('fixture-'+id),pngHash=createHash('sha256').update(png).digest('hex');await store.commit(await store.putStaged(png),image,pngHash);
  await pool.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,'model',$1::text,$3,$4,'model/gltf-binary','committed'),($5::uuid,$2,'input_image',$5::text,$6,$7,'image/png','committed')",[fileId,owner.user.id,hash,bytes.length,image,pngHash,png.length]);
  await pool.query("INSERT INTO generation_tasks(id,user_id,input_file_id,submitted_day,policy_version) VALUES($1,$2,$3,'2026-11-10','t18-fixture')",[task,owner.user.id,image]);
  await pool.query("INSERT INTO assets(id,owner_id,source_type,generation_task_id,model_file_id,name,normalization,bounds) VALUES($1,$2,'personal',$3,$4,$5,$6,$7)",[id,owner.user.id,task,fileId,name,{scale:1,translation:[0,0,0]},{min:[-.5,0,-.5],max:[.5,.8,.5]}]);
  await pool.query("UPDATE generation_tasks SET status='succeeded',result_asset_id=$2 WHERE id=$1",[task,id]);assets[name]=id;
 }
 // The cabinet stands in the owner's room so the delete has something to clean.
 const room=(await call('/rooms/me','GET',undefined,{cookie:owner.cookie})).data;
 await call('/rooms/me/layout','PUT',{baseVersion:room.version,editSequence:1,name:room.name,placements:[{id:'cab',assetId:assets['测试柜子'],position:[0,0,-1],rotation:[0,0,0],scale:1}]},{cookie:owner.cookie,'x-csrf-token':owner.csrf});
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const watch=page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource'))errors.push(m.text());});page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(r.status()+' '+new URL(r.url()).pathname);});};
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const [name,value]=owner.cookie.split('=');await context.addCookies([{name,value,url:base}]);
 const page=await context.newPage();watch(page);
 await page.goto(base+'/room');await page.waitForFunction(()=>window.__room?.snapshot()?.placements?.length===1);
 // Item drawer thumbnails (official grass + personal assets).
 await page.getByRole('button',{name:'打开物品库'}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.room-app .asset-thumbnail img')].filter(i=>i.complete&&i.naturalWidth).length>=3,null,{timeout:30000});await page.waitForTimeout(300);
 await page.screenshot({path:path.join(out,'01-drawer-thumbnails.png'),clip:{x:0,y:100,width:440,height:560}});
 await page.getByRole('button',{name:'关闭物品抽屉'}).click();
 // Backpack: trash button sits after the rename pencil; first click only asks.
 await page.getByRole('button',{name:'背包',exact:true}).click();
 const bag=page.locator('.bag-drawer');await bag.getByRole('button',{name:'删除藏品：测试柜子'}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.bag-asset-card .asset-thumbnail img')].filter(i=>i.complete&&i.naturalWidth).length>=2,null,{timeout:30000});
 const order=await bag.locator('.bag-asset-card').filter({hasText:'测试柜子'}).locator('.bag-card-title button').evaluateAll(b=>b.map(x=>x.getAttribute('aria-label')||x.textContent));
 assert.deepEqual(order,['测试柜子','修改名称：测试柜子','删除藏品：测试柜子'],'delete comes right after rename');
 await page.screenshot({path:path.join(out,'02-backpack-cards.png'),clip:{x:880,y:0,width:560,height:620}});
 await bag.getByRole('button',{name:'删除藏品：测试柜子'}).click();
 const confirm=bag.getByRole('group',{name:'确认删除：测试柜子'});await confirm.waitFor();
 assert.equal((await call('/assets','GET',undefined,{cookie:owner.cookie})).data.items.length,2,'nothing deleted before confirming');
 await page.screenshot({path:path.join(out,'03-delete-confirm.png'),clip:{x:880,y:0,width:560,height:620}});
 // Escape cancels the confirmation only.
 await page.keyboard.press('Escape');await confirm.waitFor({state:'detached'});
 await bag.getByRole('button',{name:'删除藏品：测试柜子'}).click();await confirm.getByRole('button',{name:'确认删除'}).click();
 await bag.getByRole('status').filter({hasText:'已删除「测试柜子」'}).waitFor();
 const notice=await bag.getByRole('status').filter({hasText:'已删除'}).textContent();
 assert.match(notice,/1 间小屋撤下 1 处摆放/);
 assert.equal(await bag.locator('.bag-asset-card',{hasText:'测试柜子'}).count(),0);
 await page.screenshot({path:path.join(out,'04-deleted.png'),clip:{x:880,y:0,width:560,height:620}});
 await page.getByRole('button',{name:'关闭背包'}).click();
 await page.waitForFunction(()=>window.__room.snapshot().placements.length===0&&window.__room.save?.state?.status==='saved',null,{timeout:10000});
 assert.equal((await call('/rooms/me','GET',undefined,{cookie:owner.cookie})).data.placements.length,0,'room placement removed on the server');
 // Admin upload: choosing a GLB previews it on the right; the list button says 删除.
 const admin=await login('t18_admin');const adminCtx=await browser.newContext({viewport:{width:1440,height:900}});
 const [an,av]=admin.cookie.split('=');await adminCtx.addCookies([{name:an,value:av,url:base}]);
 const ap=await adminCtx.newPage();watch(ap);await ap.goto(base+'/admin');
 await ap.getByRole('button',{name:'资产与上传'}).click();await ap.getByLabel('GLB 模型').setInputFiles('tests/fixtures/models/chair.glb');
 await ap.getByRole('heading',{name:'待上传：chair.glb'}).waitFor();
 await ap.waitForFunction(()=>!document.querySelector('.adm-detail .bag-preview-status'),null,{timeout:15000});await ap.waitForTimeout(600);
 await ap.screenshot({path:path.join(out,'05-admin-upload-preview.png')});
 await ap.locator('.adm-row',{hasText:'测试方桌'}).click();await ap.getByRole('button',{name:'删除…'}).waitFor();
 assert.equal(await ap.getByText('风险删除').count(),0);
 await ap.screenshot({path:path.join(out,'06-admin-delete-button.png')});
 console.log('errors:',JSON.stringify(errors));assert.deepEqual(errors,[]);
}finally{await browser?.close();await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
