// T17 visual check of the personal room on the user's Mac: real API + PostgreSQL + Chrome in an
// ISOLATED temporary database and temp store on 127.0.0.1:13017 (the main database is never touched).
// Seeds the official items, places a few of them, then screenshots edit mode, walking views,
// the item drawer and the password form. Requires `npm run build` first (the API serves apps/web/dist).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import pg from 'pg';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker} from '@aholo/domain';
import {migrate} from './migrate.mjs';import {seedFurniture} from './seed-furniture.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13017,base=`http://127.0.0.1:${port}`,out=process.env.T17_EVIDENCE_DIR||'docs/validation/evidence/t17';await fs.mkdir(out,{recursive:true});
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_t17_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t17-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),pw='t17-shots-'+randomBytes(9).toString('hex');
let app,browser;const errors=[];
try{
 await migrate(pool);await seedFurniture(config);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const store=new LocalFileStore(root);await store.initialize();const worker=new GenerationWorker(pool,store,config);
 await seedAdmin(pool,{username:'t17_admin',nickname:'馆务管理员',password:pw});
 const call=async(pathname,method,body,headers={})=>{const h={origin:base,'idempotency-key':randomUUID(),...headers};if(!(body instanceof FormData)&&body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw new Error(pathname+' '+r.status+' '+text);return {r,data:text?JSON.parse(text).data:null};};
 const login=async username=>{const {r,data}=await call('/auth/login','POST',{username,password:pw});return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrfToken};};
 // A solid sample (the old chair GLB, imported only into this temp database) to show collisions next to the grass.
 const admin=await login('t17_admin'),form=new FormData();form.set('sourceType','furniture');form.set('name','测试木椅');form.set('description','');
 form.set('file',new Blob([await fs.readFile('tests/fixtures/models/chair.glb')]),'chair.glb');
 const {data:imported}=await call('/admin/assets','POST',form,{cookie:admin.cookie,'x-csrf-token':admin.csrf});assert.equal(await worker.tick(imported.id),true);
 await call('/auth/register','POST',{username:'t17_owner',nickname:'小屋主人',password:pw,confirmPassword:pw});
 const owner=await login('t17_owner');
 const items=(await call('/furniture','GET',undefined,{cookie:owner.cookie})).data.items;
 const grass=items.find(i=>i.name==='花草丛'),chair=items.find(i=>i.name==='测试木椅');assert.ok(grass?.walkThrough&&chair&&!chair.walkThrough);
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const [name,value]=owner.cookie.split('=');await context.addCookies([{name,value,url:base}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('response',r=>{if(r.status()>=400)errors.push(r.status()+' '+new URL(r.url()).pathname);});
 await page.goto(base+'/room');await page.waitForFunction(()=>window.__room?.snapshot()?.name);
 const placements=[
  ...[[-8,3.9],[-8.6,-.4],[-7.6,-3.6],[8,3.9],[8.6,-.4],[7.6,-3.6],[-3.6,7.4],[3.6,7.4],[-14,10],[14,10],[-14,-10],[14,-10]].map(([x,z],i)=>({id:'grass'+i,assetId:grass.id,position:[x,-.4,z],rotation:[0,i,0],scale:1.8})),
  {id:'chair1',assetId:chair.id,position:[-2,0,-1],rotation:[0,.4,0],scale:1},{id:'chair2',assetId:chair.id,position:[2,0,-1],rotation:[0,-.4,0],scale:1},
 ];
 for(const id of [grass.id,chair.id])await page.evaluate(id=>window.__room.engine.ensureModel(id),id);
 await page.evaluate(p=>window.__room.replace(p),placements);
 await page.waitForFunction(()=>window.__room.engine.instances.size>=14);await page.waitForTimeout(1500);
 await page.screenshot({path:path.join(out,'01-edit-overview.png')});
 await page.evaluate(()=>{const e=window.__room.engine;e.camera.position.set(-30,22,34);e.orbit.target.set(0,0,0);e.orbit.update();});await page.waitForTimeout(500);
 await page.screenshot({path:path.join(out,'02-edit-grounds.png')});
 await page.getByRole('button',{name:'打开物品库'}).click();await page.waitForTimeout(600);
 await page.screenshot({path:path.join(out,'03-drawer-tabs.png'),clip:{x:0,y:120,width:420,height:420}});
 console.log('tab style:',JSON.stringify(await page.evaluate(()=>{const b=document.querySelector('.sidebar-tabs button');const c=getComputedStyle(b);return {bg:c.backgroundColor,backdrop:c.backdropFilter,shadow:c.boxShadow,border:c.border,classes:b.className,parentBg:getComputedStyle(b.parentElement).backgroundColor};})));
 await page.getByRole('button',{name:'关闭物品抽屉'}).click();
 await page.getByRole('button',{name:'漫游参观'}).click();await page.waitForTimeout(1500);
 await page.screenshot({path:path.join(out,'04-visit-entry.png')});
 for(const [i,yaw,pitch,x,z,y] of [[5,Math.PI,-.12,0,8,-.4],[6,0,-.05,0,9,-.4],[7,Math.PI*.75,-.1,3,-1,0],[8,Math.PI/2,.05,-4,2,0],[9,Math.PI*1.25,.15,-1.5,1,0],[10,Math.atan2(13,15),.12,13,15,-.4],[11,Math.atan2(-12,-11),.1,-12,-11,-.4]]){
  await page.evaluate(([yaw,pitch,x,z,y])=>{const e=window.__room.engine;e.player={x,y,z,velocityY:null};e.yaw=yaw;e.pitch=pitch;e.placeVisitCamera(0);},[yaw,pitch,x,z,y]);
  await page.waitForTimeout(700);await page.screenshot({path:path.join(out,`${String(i).padStart(2,'0')}-visit.png`)});
 }
 // Editor push-out: drop a chair onto a side post and release; it must end up clear of it and still saved.
 await page.getByRole('button',{name:'布置小屋'}).click();await page.waitForTimeout(500);
 const result=await page.evaluate(()=>{const e=window.__room.engine;e.select('chair1');const object=e.instances.get('chair1');
  e.original=structuredClone(e.placements.find(p=>p.id==='chair1'));object.position.set(-5.85,0,-2.25);object.updateMatrixWorld(true);
  e.transform.dispatchEvent({type:'objectChange'});const red=e.outline.material.color.getHex();
  e.transform.dispatchEvent({type:'mouseUp'});return {red,after:e.placements.find(p=>p.id==='chair1').position};});
 assert.equal(result.red,0xc33d32,'outlined red while touching the post');
 assert.ok(result.after[0]>-5.85+.2||Math.abs(result.after[2]+2.25)>.3,'pushed clear of the post: '+JSON.stringify(result.after));
 await page.waitForFunction(()=>window.__room.save?.state?.status!=='dirty'&&window.__room.save?.state?.status!=='saving').catch(()=>{});
 await page.screenshot({path:path.join(out,'12-pushed-clear.png')});
 console.log('push-out:',JSON.stringify(result));
 // Password form: three eye toggles; short new password gets a Chinese message without a request.
 await page.getByRole('button',{name:'菜单'}).click();await page.getByRole('button',{name:/账号/}).first().click();
 const passwordForm=page.locator('form',{has:page.getByRole('heading',{name:'修改密码'})});await passwordForm.waitFor();
 assert.equal(await passwordForm.locator('.bag-password-toggle').count(),3);
 await passwordForm.locator('input[name=oldPassword]').fill('old-password-123');await passwordForm.locator('input[name=newPassword]').fill('short');await passwordForm.locator('input[name=confirmPassword]').fill('short');
 await passwordForm.locator('.bag-password-toggle').nth(1).click();
 assert.equal(await passwordForm.locator('input[name=newPassword]').getAttribute('type'),'text');
 await passwordForm.getByRole('button',{name:'修改并重新登录'}).click();
 await page.getByRole('alert').getByText('新密码长度须为 12～128 个字符。').waitFor();
 await page.screenshot({path:path.join(out,'13-password-form.png')});
 console.log('errors:',JSON.stringify(errors));
}finally{await browser?.close();await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
