// T19 check on the user's Mac: items in the personal room collide with each other, stack on larger
// items, carry what stands on them and bounce back when dropped onto another item. Real API +
// PostgreSQL + Chrome in an ISOLATED temporary database and store on 127.0.0.1:13019 (the main
// database is never touched). Requires `npm run build` first (the API serves apps/web/dist).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import pg from 'pg';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker} from '@aholo/domain';
import {migrate} from './migrate.mjs';import {seedFurniture} from './seed-furniture.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13019,base=`http://127.0.0.1:${port}`,out=process.env.T19_EVIDENCE_DIR||'docs/validation/evidence/t19';await fs.mkdir(out,{recursive:true});
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_t19_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t19-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),pw='t19-shots-'+randomBytes(9).toString('hex');
let app,browser;const errors=[];
try{
 await migrate(pool);await seedFurniture(config);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const store=new LocalFileStore(root);await store.initialize();const worker=new GenerationWorker(pool,store,config);
 await seedAdmin(pool,{username:'t19_admin',nickname:'馆务管理员',password:pw});
 const call=async(pathname,method,body,headers={})=>{const h={origin:base,'idempotency-key':randomUUID(),...headers};if(!(body instanceof FormData)&&body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw new Error(pathname+' '+r.status+' '+text);return {r,data:text?JSON.parse(text).data:null};};
 const login=async username=>{const {r,data}=await call('/auth/login','POST',{username,password:pw});return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrfToken};};
 // Two solid samples (old fixture GLBs, imported only into this temp database).
 const admin=await login('t19_admin');
 for(const [name,file] of [['测试方桌','table.glb'],['测试木椅','chair.glb']]){
  const form=new FormData();form.set('sourceType','furniture');form.set('name',name);form.set('description','');form.set('file',new Blob([await fs.readFile('tests/fixtures/models/'+file)]),file);
  const {data}=await call('/admin/assets','POST',form,{cookie:admin.cookie,'x-csrf-token':admin.csrf});assert.equal(await worker.tick(data.id),true);
 }
 await call('/auth/register','POST',{username:'t19_owner',nickname:'小屋主人',password:pw,confirmPassword:pw});
 const owner=await login('t19_owner');
 const items=(await call('/furniture','GET',undefined,{cookie:owner.cookie})).data.items;
 const table=items.find(i=>i.name==='测试方桌'),chair=items.find(i=>i.name==='测试木椅');assert.ok(table&&chair);
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const [name,value]=owner.cookie.split('=');await context.addCookies([{name,value,url:base}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('Failed to load resource'))errors.push(m.text());});page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(r.status()+' '+new URL(r.url()).pathname);});
 await page.goto(base+'/room');await page.waitForFunction(()=>window.__room?.snapshot()?.name);
 for(const id of [table.id,chair.id])await page.evaluate(id=>window.__room.engine.ensureModel(id),id);
 // A table, a small stool-sized chair (scale .35) beside it and a full-size chair further off.
 await page.evaluate(([t,c])=>window.__room.replace([
  {id:'table',assetId:t,position:[1.5,0,-1],rotation:[0,0,0],scale:1},
  {id:'small',assetId:c,position:[-1.5,0,-1],rotation:[0,0,0],scale:.35},
  {id:'big',assetId:c,position:[-3.5,0,1.5],rotation:[0,0,0],scale:1},
 ]),[table.id,chair.id]);
 await page.waitForFunction(()=>window.__room.engine.instances.size>=3);
 const saved=()=>page.waitForFunction(()=>window.__room.save?.state?.status==='saved',null,{timeout:10000});
 await saved();
 const view=()=>page.evaluate(()=>{const e=window.__room.engine;e.camera.position.set(-1,5.5,7.5);e.orbit.target.set(0,.5,-.5);e.orbit.update();});
 // Simulated gizmo drag on the X/Z plane, the same events TransformControls fires.
 const drag=(id,to)=>page.evaluate(([id,to])=>{const e=window.__room.engine;e.select(id);e.transform.axis='XZ';e.transform.dispatchEvent({type:'mouseDown'});
  const o=e.instances.get(id);o.position.x=to[0];o.position.z=to[1];o.updateMatrixWorld(true);e.transform.dispatchEvent({type:'objectChange'});
  const red=e.outline.material.color.getHex();e.transform.dispatchEvent({type:'mouseUp'});
  const pos=Object.fromEntries([...e.instances].map(([k,v])=>[k,v.position.toArray()]));return {red,pos};},[id,to]);
 const top=await page.evaluate(id=>{const e=window.__room.engine;return e.bounds.get(id).max[1];},table.id);
 await view();await page.waitForTimeout(800);await page.screenshot({path:path.join(out,'01-before.png')});
 // 1) Small chair onto the table: lands on the table top.
 const onTable=await drag('small',[1.2,-1.1]);
 assert.equal(onTable.red,0xbe8c45,'not red while resting on top');
 const smallMinY=await page.evaluate(()=>{const e=window.__room.engine,p=e.instances.get('small'),b=e.bounds.get(p.userData.assetId);return p.position.y+b.min[1]*.35;});
 assert.ok(Math.abs(smallMinY-top)<1e-6,`small chair bottom ${smallMinY} on table top ${top}`);
 await saved();await page.waitForTimeout(500);await page.screenshot({path:path.join(out,'02-stacked.png')});
 // 2) Move the table: the chair on it comes along and stays on top.
 const carried=await drag('table',[2.8,.2]);
 assert.ok(Math.abs(carried.pos.small[0]-(1.2+1.3))<1e-6&&Math.abs(carried.pos.small[2]-(-1.1+1.2))<1e-6,'rider moved by the same offset: '+JSON.stringify(carried.pos.small));
 assert.ok(Math.abs(carried.pos.small[1]-onTable.pos.small[1])<1e-6,'rider kept its height');
 await saved();await page.waitForTimeout(500);await page.screenshot({path:path.join(out,'03-carried.png')});
 const server=(await call('/rooms/me','GET',undefined,{cookie:owner.cookie})).data.placements;
 const s=server.find(p=>p.id==='small'),t=server.find(p=>p.id==='table');
 assert.ok(Math.abs(s.position[0]-2.5)<1e-6&&Math.abs(t.position[0]-2.8)<1e-6,'both saved: '+JSON.stringify(server));
 // 3) Drop the full-size chair into the table: red while overlapping, bounces back on release.
 const before=await page.evaluate(()=>window.__room.engine.instances.get('big').position.toArray());
 const bounced=await drag('big',[2.6,.1]);
 assert.equal(bounced.red,0xc33d32,'outlined red while overlapping the table');
 assert.deepEqual(bounced.pos.big,before,'bounced back to where it was');
 const notice=await page.getByText(/已弹回操作前的位置/).first().textContent();
 assert.match(notice,/和其他物品重叠/);
 await page.waitForTimeout(500);await page.screenshot({path:path.join(out,'04-bounced.png')});
 // 4) Adding an item from the drawer picks a spot clear of everything.
 for(let i=0;i<4;i++)await page.evaluate(id=>window.__room.add(id),chair.id);
 await page.waitForFunction(()=>window.__room.engine.instances.size>=7);
 const clash=await page.evaluate(()=>{const e=window.__room.engine,boxes=[...e.instances].map(([id,o])=>[id,new window.__room.engine.outline.box.constructor().setFromObject(o).expandByScalar(-.01)]);const hits=[];
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const [a,A]=boxes[i],[b,B]=boxes[j];if(A.intersectsBox(B)&&!((a==='small'&&b==='table')||(a==='table'&&b==='small')))hits.push(a+'×'+b);}return hits;});
 assert.deepEqual(clash,[],'new items do not overlap anything');
 await saved();await page.evaluate(()=>{const e=window.__room.engine;e.select(null);e.camera.position.set(-2,9,11);e.orbit.target.set(0,0,0);e.orbit.update();});await page.waitForTimeout(800);
 await page.screenshot({path:path.join(out,'05-added.png')});
 console.log('errors:',JSON.stringify(errors));assert.deepEqual(errors,[]);
 console.log('PASS T19 stack, carry, bounce and free spot');
}finally{await browser?.close();await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
