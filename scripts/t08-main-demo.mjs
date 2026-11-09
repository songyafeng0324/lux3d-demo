// T08 on the MAIN local database: prepare the normal administrator through seedAdmin, then put the
// real T06-generated model through submit → review → 30-slot publish, and confirm it in Chrome.
// Idempotent and additive: it never deletes, never changes the furniture system account, never
// creates a Lux3D task. Secrets live only in the private Application Support folder (0600).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';import {chromium} from 'playwright';
import {loadConfig,createPool,seedAdmin} from '@aholo/domain';
import {buildApp} from '../apps/api/dist/app.js';
const port=13009,base=`http://127.0.0.1:${port}`,out='docs/validation/evidence/t08';
const priv=path.join(os.homedir(),'Library/Application Support/aholo-lux3d'),dir=path.join(priv,'t08');await fs.mkdir(dir,{recursive:true,mode:0o700});
const readJson=async f=>{try{return JSON.parse(await fs.readFile(f,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const save=(f,v)=>fs.writeFile(f,JSON.stringify(v,null,1),{mode:0o600});
const adminFile=path.join(dir,'admin-account.json'),stateFile=path.join(dir,'main-demo.json');
const demo=await readJson(path.join(priv,'t06/site-account.json'));assert.ok(demo?.username&&demo?.password&&demo?.taskId,'T06 demo account record is required');
const config={...loadConfig(),apiHost:'127.0.0.1',apiPort:port},pool=createPool(config.databaseUrl);
let admin=await readJson(adminFile);
if(!admin){admin={username:'aholo_admin',nickname:'馆务管理员',password:randomBytes(24).toString('base64url'),createdAt:new Date().toISOString()};await save(adminFile,admin);}
const seeded=await seedAdmin(pool,{username:admin.username,nickname:admin.nickname,password:admin.password});await pool.end();
const state=await readJson(stateFile)??{submitKey:randomUUID(),reviewKey:randomUUID()};await save(stateFile,state);
const app=await buildApp(config);await app.listen({host:'127.0.0.1',port});let browser;const result={adminSeeded:seeded.created,steps:[]};
const log=s=>{result.steps.push(s);console.log('OK '+s);};
try{
 async function call(method,url,body,headers={},key=randomUUID()){const r=await app.inject({method,url:'/api/v1'+url,headers:{origin:base,'idempotency-key':key,...headers},...(body!==undefined?{payload:body}:{})});if(r.statusCode>=400)throw new Error(`${method} ${url} ${r.statusCode} ${r.body}`);return r.statusCode===204?null:r.json().data;}
 async function login(username,password){const r=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:base,'idempotency-key':randomUUID()},payload:{username,password}});assert.equal(r.statusCode,200,`login ${username}: ${r.body}`);return {cookie:r.headers['set-cookie'].split(';')[0],'x-csrf-token':r.json().data.csrfToken,role:r.json().data.user.role};}
 const a=await login(admin.username,admin.password);assert.equal(a.role,'admin','normal administrator can log in');log(seeded.created?`created administrator ${admin.username}`:`administrator ${admin.username} already present`);
 const u=await login(demo.username,demo.password);
 const task=await call('GET','/generation-tasks/'+demo.taskId,undefined,{cookie:u.cookie});assert.ok(task.assetId,'T06 task delivered an asset');const assetId=task.assetId;
 const asset=await call('GET','/assets/'+assetId,undefined,{cookie:u.cookie});log(`real T06 model ${asset.name} (${assetId})`);
 let latest=(await call('GET','/submissions?assetId='+assetId,undefined,{cookie:u.cookie})).items[0];
 if(!latest||!['pending','approved'].includes(latest.status)){
  latest=await call('POST',`/assets/${assetId}/submissions`,{name:'瓷瓶（演示投稿）',description:'经本站单图生成并进入背包的瓷瓶模型，用于本地 MVP 演示投稿、审核与展陈流程。',era:'不详',material:'瓷',ownershipType:'personal_collection',holderName:demo.nickname??'藏友',location:'不详',officialUrl:''},u,state.submitKey);log('submitted with full public data');
 }else log(`existing submission ${latest.status}`);
 if(latest.status==='pending'){await call('POST',`/admin/submissions/${latest.id}/review`,{decision:'approve'},a,state.reviewKey);log('approved into candidates');}
 const candidate=(await call('GET','/admin/candidates',undefined,{cookie:a.cookie})).items.find(c=>c.assetId===assetId);assert.ok(candidate,'candidate exists');
 let slotNo=candidate.slotNo;
 if(!slotNo){const g=await call('GET','/admin/gallery',undefined,{cookie:a.cookie});const free=g.slots.find(s=>s.slotNo===1&&!s.candidateId)??g.slots.find(s=>!s.candidateId);assert.ok(free,'a free slot');slotNo=free.slotNo;
  const r=await call('PUT','/admin/gallery',{baseVersion:g.version,slots:g.slots.map(s=>({slotNo:s.slotNo,candidateId:s.slotNo===slotNo?candidate.id:s.candidateId}))},a);log(`published gallery version ${r.publishedVersion} with slot ${slotNo}`);}
 else log(`already exhibited in slot ${slotNo}`);
 const view=await call('GET','/gallery');assert.equal(view.slots[slotNo-1].exhibit?.candidateId,candidate.id);result.galleryVersion=view.version;result.slotNo=slotNo;result.exhibits=view.slots.filter(s=>s.exhibit).length;
 // Chrome: a logged-out visitor sees the real model on its plinth and opens the E detail.
 const layout=JSON.parse(await fs.readFile('assets/t16/pavilion-layout.json','utf8')),marker=layout.exhibitSlots.find(s=>s.id==='T'+String(slotNo).padStart(2,'0'));
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});const errors=[];
 const vp=await (await browser.newContext({viewport:{width:1440,height:900}})).newPage();vp.setDefaultTimeout(60000);vp.on('pageerror',e=>errors.push(e.message));
 await vp.goto(base+'/');await vp.waitForFunction(()=>window.__t10?.ui().phase==='intro',null,{timeout:90000});await vp.getByRole('button',{name:'进入藏宝阁'}).click();
 await vp.waitForFunction(n=>window.__t10.ui().exhibits>=n,result.exhibits,{timeout:90000});
 const [x,y,z]=marker.position,west=x<0;await vp.evaluate(([px,pz,py,yaw])=>window.__t10.engine.debugPlace(px,pz,py,yaw,-.22),[west?x+1.7:x-1.7,z,y,west?Math.PI/2:-Math.PI/2]);
 await vp.waitForFunction(id=>window.__t10.engine.debugState().target?.id===id,marker.id);await vp.screenshot({path:path.join(out,'main-01-visitor-prompt.png')});
 await vp.keyboard.press('KeyE');await vp.getByRole('dialog',{name:'瓷瓶（演示投稿）详情'}).getByText(`投稿 · ${latest.publicSnapshot?.sourceNickname??demo.nickname}`).waitFor();
 await vp.waitForFunction(()=>!document.querySelector('.t10-exhibit .bag-preview-status'),null,{timeout:90000});await vp.screenshot({path:path.join(out,'main-02-visitor-detail.png')});log('visitor sees the real model and its E detail in Chrome');
 const ap=await (await browser.newContext({viewport:{width:1440,height:900}})).newPage();ap.on('pageerror',e=>errors.push(e.message));
 await ap.goto(base+'/admin');await ap.getByLabel('用户名').fill(admin.username);await ap.getByLabel('密码',{exact:true}).fill(admin.password);await ap.getByRole('button',{name:'登录',exact:true}).click();
 await ap.getByRole('button',{name:'候选与展位'}).click();await ap.locator('.adm-slot',{hasText:'瓷瓶（演示投稿）'}).waitFor();await ap.screenshot({path:path.join(out,'main-03-admin-gallery.png')});log('administrator logs into /admin and sees the arrangement');
 assert.deepEqual(errors,[]);result.pass=true;result.chrome=browser.version();
}catch(e){result.pass=false;result.error=String(e.message??e).slice(0,500);console.error('FAIL',e);process.exitCode=1;}
finally{await browser?.close();await app.close();result.at=new Date().toISOString();await fs.writeFile(path.join(out,'main-demo.json'),JSON.stringify(result,null,1));console.log(JSON.stringify(result));}
