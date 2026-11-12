// Real-Chrome check of model caching (2026-11-12): user models load their web copy, the browser keeps it and a
// second visit only asks the server (bodiless 304); revoking access still stops the cached file.
// ISOLATED temporary database and store on 127.0.0.1:13012; the main database and file store are never touched.
// Requires `npm run build` first (the API serves apps/web/dist). Usage:
//   node scripts/model-cache-browser.mjs [model.glb ...]     (default: the small test fixtures; pass real Lux3D GLBs to measure)
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import pg from 'pg';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker,enqueueWebCopies} from '@aholo/domain';
import {GALLERY_SLOT_COUNT} from '@aholo/contracts';
import {migrate} from './migrate.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13012,base=`http://127.0.0.1:${port}`,out=process.env.MODEL_CACHE_EVIDENCE||'docs/validation/evidence/model-cache';await fs.mkdir(out,{recursive:true});
const models=process.argv.slice(2).length?process.argv.slice(2):['tests/fixtures/models/cabinet.glb','tests/fixtures/models/table.glb'];
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_cache_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-cache-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),store=new LocalFileStore(root);await store.initialize();
const pw='cache-browser-'+randomBytes(9).toString('hex'),result={models:[],visits:{}},errors=[];
let app,browser;
async function call(pathname,method,body,headers={}){const h={origin:base,'idempotency-key':randomUUID(),...headers};if(!(body instanceof FormData)&&body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json().catch(()=>null);assert.ok(r.ok,`${method} ${pathname} ${r.status} ${JSON.stringify(j)}`);return j.data;}
const login=async username=>{const r=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({username,password:pw})});const j=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],'x-csrf-token':j.data.csrfToken};};
/** Bytes on the wire and statuses of model requests during `fn` (CDP: encodedDataLength includes headers). */
async function measure(page,fn){
 const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');
 const seen=new Map();
 // The wire status comes from ExtraInfo: after a 304, responseReceived reports the cached 200.
 const wire=new Map();cdp.on('Network.responseReceivedExtraInfo',e=>wire.set(e.requestId,e.statusCode));
 cdp.on('Network.responseReceived',e=>{if(e.response.url.includes('/content'))seen.set(e.requestId,{url:e.response.url,status:e.response.status,bytes:0,done:false});});
 cdp.on('Network.loadingFinished',e=>{const s=seen.get(e.requestId);if(s){s.bytes=e.encodedDataLength;s.done=true;}});
 await fn();
 const t=Date.now();while([...seen.values()].some(s=>!s.done)&&Date.now()-t<30000)await new Promise(r=>setTimeout(r,100));
 await cdp.detach();const list=[...seen.values()];
 for(const [id,s] of seen)s.status=wire.get(id)??s.status;
 return {requests:list.length,bytes:list.reduce((n,s)=>n+s.bytes,0),statuses:list.map(s=>s.status).sort(),urls:[...new Set(list.map(s=>new URL(s.url).search))]};
}
try{
 await migrate(pool);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const worker=new GenerationWorker(pool,store,config);
 await seedAdmin(pool,{username:'cache_admin',nickname:'馆务',password:pw});
 await call('/auth/register','POST',{username:'cache_owner',nickname:'屋主',password:pw,confirmPassword:pw});
 const admin=await login('cache_admin'),owner=await login('cache_owner');
 // Each model goes through the real import (Chrome render validation) twice: as an official item for the room, as an official candidate for the gallery.
 const furniture=[],candidates=[];
 for(const [i,file] of models.entries())for(const sourceType of ['furniture','official_candidate']){
  const fd=new FormData();for(const [k,v] of Object.entries({sourceType,name:`样本${i+1}`,description:'缓存验证样本。',era:'当代',material:'木',ownershipType:'museum',holderName:'示例馆',location:'北京',officialUrl:'https://example.org/c'}))if(sourceType==='official_candidate'||['sourceType','name'].includes(k))fd.set(k,v);
  fd.set('file',new Blob([await fs.readFile(file)]),path.basename(file).endsWith('.glb')?path.basename(file):'model.glb');
  const {id}=await call('/admin/assets','POST',fd,admin);
  let s;for(let n=0;n<20;n++){await worker.tick(id);s=(await call('/admin/imports/'+id,'GET',undefined,admin));if(s.status!=='processing')break;}
  assert.equal(s.status,'succeeded',`import ${file}: ${JSON.stringify(s)}`);(sourceType==='furniture'?furniture:candidates).push(s.assetId);
 }
 assert.equal(await enqueueWebCopies(pool),models.length*2);while(await worker.tick());
 for(const r of (await pool.query("SELECT o.byte_size original,c.byte_size copy FROM model_web_copies w JOIN files o ON o.id=w.model_file_id JOIN files c ON c.id=w.file_id JOIN assets a ON a.model_file_id=o.id AND a.source_type='furniture'")).rows)result.models.push({original:Number(r.original),copy:Number(r.copy)});
 // The owner's room holds each official item; the gallery shows each candidate.
 const me=await call('/rooms/me','GET',undefined,owner);
 await call('/rooms/me/layout','PUT',{baseVersion:me.version,editSequence:1,name:'缓存小屋',placements:furniture.map((assetId,i)=>({id:'p'+i,assetId,position:[i*2-1,0,1],rotation:[0,0,0],scale:1}))},owner);
 const share=await call('/rooms/me/share','PUT',{enabled:true},owner);
 const cands=(await call('/admin/candidates','GET',undefined,admin)).items;
 const g=await call('/gallery','GET');
 await call('/admin/gallery','PUT',{baseVersion:g.version,slots:Array.from({length:GALLERY_SLOT_COUNT},(_,i)=>({slotNo:i+1,candidateId:cands[i]?.id??null}))},admin);

 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
 const ctx=await browser.newContext({viewport:{width:1280,height:800}});
 await ctx.addCookies([{name:'aholo_session',value:owner.cookie.split('=')[1],url:base}]);
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 const roomReady=()=>page.waitForFunction(n=>window.__room?.engine.debug().models===n,furniture.length,{timeout:60000});
 result.visits.roomFirst=await measure(page,async()=>{await page.goto(base+'/room');await roomReady();});
 result.visits.roomSecond=await measure(page,async()=>{await page.reload();await roomReady();});
 await page.screenshot({path:path.join(out,'room-second-visit.jpg'),quality:80});
 const visitor=await (await browser.newContext({viewport:{width:1280,height:800}})).newPage();visitor.on('pageerror',e=>errors.push(e.message));
 const sharedReady=()=>visitor.waitForFunction(n=>window.__room?.engine.debug().models===n,furniture.length,{timeout:60000});
 result.visits.sharedFirst=await measure(visitor,async()=>{await visitor.goto(share.shareUrl);await sharedReady();});
 result.visits.sharedSecond=await measure(visitor,async()=>{await visitor.reload();await sharedReady();});
 const grant=await visitor.evaluate(()=>window.__room.snapshot().grant),modelFile=await visitor.evaluate(()=>window.__room.snapshot().assets[0].modelFileId);
 const hall=await ctx.newPage();hall.on('pageerror',e=>errors.push(e.message));
 const hallReady=async()=>{await hall.waitForFunction(()=>window.__t10?.ui().phase==='intro',null,{timeout:60000});await hall.getByRole('button',{name:'进入藏宝阁'}).click();await hall.waitForFunction(n=>window.__t10.engine.debugState().exhibits.length===n,candidates.length,{timeout:90000});};
 result.visits.galleryFirst=await measure(hall,async()=>{await hall.goto(base+'/');await hallReady();});
 result.visits.gallerySecond=await measure(hall,async()=>{await hall.reload();await hallReady();});
 await hall.screenshot({path:path.join(out,'gallery-second-visit.jpg'),quality:80});

 // Revocation: after the owner closes the share, the visitor's cached model is refused even with the old grant.
 await call('/rooms/me/share','PUT',{enabled:false},owner);
 result.revoked=await visitor.evaluate(async({grant,modelFile})=>{const r=await fetch('/api/v1/files/'+modelFile+'/content?variant=web',{headers:{Authorization:'Bearer '+grant.token,'X-Snapshot-Grant':grant.id},credentials:'same-origin',cache:'no-cache'});return r.status;},{grant,modelFile});
 const v=result.visits;
 for(const k of ['roomFirst','sharedFirst','galleryFirst'])assert.ok(v[k].statuses.every(s=>s===200)&&v[k].requests>=models.length,`${k} ${JSON.stringify(v[k])}`);
 for(const k of ['roomSecond','sharedSecond','gallerySecond']){assert.ok(v[k].requests>=models.length&&v[k].statuses.every(s=>s===304),`${k} revalidates: ${JSON.stringify(v[k])}`);assert.ok(v[k].bytes<2000*v[k].requests,`${k} downloads no body: ${v[k].bytes}`);}
 for(const k of Object.keys(v))assert.deepEqual(v[k].urls,['?variant=web'],`${k} loads the web copy`);
 assert.equal(result.revoked,404,'closed share: the cached copy is not served');
 assert.deepEqual(errors,[]);
 result.passed=true;console.log(JSON.stringify(result,null,1));
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({...result,checkedAt:new Date().toISOString(),browser:browser.version()},null,1)+'\n');
}finally{await browser?.close();await app?.close();await pool.end().catch(()=>{});await bootstrap.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
