// T08 browser check on the user's Mac: real API + real PostgreSQL + real Chrome, but in an
// ISOLATED temporary database and private temp store served on 127.0.0.1:13008. The main
// aholo_lux3d database, its file store and the Lux3D account are never touched.
// Requires `npm run build` first (the API serves apps/web/dist).
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';import pg from 'pg';import sharp from 'sharp';import {chromium} from 'playwright';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker,validateModel,sha256} from '@aholo/domain';
import {migrate} from './migrate.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const port=13008,base=`http://127.0.0.1:${port}`,out=process.env.T08_EVIDENCE_DIR || 'docs/validation/evidence/t08';await fs.mkdir(out,{recursive:true});
const main=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
const db='aholo_t08b_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t08b-')),u=new URL(main.databaseUrl);u.pathname='/'+db;
const config={...main,databaseUrl:u.href,dataDir:root,apiHost:'127.0.0.1',apiPort:port,publicOrigin:base,generationEnabled:false};
const pool=createPool(u.href),store=new LocalFileStore(root);await store.initialize();
let app,browser;const checks=[],errors=[],started=Date.now();
const step=async(name,fn)=>{const t=Date.now();await fn();checks.push({name,ms:Date.now()-t});console.log('PASS '+name);};
const pw='t08-browser-'+randomBytes(9).toString('hex');
try{
 await migrate(pool);app=await buildApp(config);await app.listen({host:'127.0.0.1',port});
 const worker=new GenerationWorker(pool,store,config);
 assert.equal((await seedAdmin(pool,{username:'t08_admin',nickname:'馆务管理员',password:pw})).created,true);
 async function call(pathname,method,body,headers={}){const h={origin:base,'idempotency-key':randomUUID(),...headers};if(!(body instanceof FormData)&&body!==undefined)h['content-type']='application/json';const r=await fetch(base+'/api/v1'+pathname,{method,headers:h,body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw new Error(`${method} ${pathname} ${r.status} ${text}`);return {r,data:text?JSON.parse(text).data:null};}
 const login=async username=>{const {r,data}=await call('/auth/login','POST',{username,password:pw});return {cookie:r.headers.get('set-cookie').split(';')[0],'x-csrf-token':data.csrfToken,user:data.user};};
 await call('/auth/register','POST',{username:'t08_collector',nickname:'藏友小周',password:pw,confirmPassword:pw});
 await call('/auth/register','POST',{username:'t13_visitor',nickname:'收藏访客',password:pw,confirmPassword:pw});
 const admin=await login('t08_admin'),collector=await login('t08_collector');
 // Official public candidates: real GLB upload → real import worker (Chrome render validation) → candidate.
 for(const [file,name,era,material] of [['table.glb','明式长案','明代','黄花梨'],['cabinet.glb','双门陈列柜','清代','紫檀']]){
  const fd=new FormData();for(const [k,v] of Object.entries({sourceType:'official_candidate',name,description:`${name}，馆藏木作样本。`,era,material,ownershipType:'museum',holderName:'示例博物院',location:'北京',officialUrl:'https://example.org/collection'}))fd.set(k,v);
  fd.set('file',new Blob([await fs.readFile('assets/furniture/'+file)]),file);
  const {data}=await call('/admin/assets','POST',fd,{cookie:admin.cookie,'x-csrf-token':admin['x-csrf-token']});
  for(let i=0;i<20;i++){await worker.tick(data.id);const s=(await call('/admin/imports/'+data.id,'GET',undefined,{cookie:admin.cookie})).data;if(s.status==='succeeded')break;assert.notEqual(s.status,'failed','import '+name);}
 }
 const furnitureForm=new FormData();
 furnitureForm.set('sourceType','furniture');furnitureForm.set('name','验收木椅');
 furnitureForm.set('file',new Blob([await fs.readFile('assets/furniture/chair.glb')]),'chair.glb');
 const {data:furnitureImport}=await call('/admin/assets','POST',furnitureForm,{cookie:admin.cookie,'x-csrf-token':admin['x-csrf-token']});
 assert.equal(await worker.tick(furnitureImport.id),true);
 assert.equal((await call('/admin/imports/'+furnitureImport.id,'GET',undefined,{cookie:admin.cookie})).data.status,'succeeded');
 assert.ok((await call('/furniture','GET',undefined,{cookie:collector.cookie})).data.items.some(item=>item.name==='验收木椅'));
 // One already-delivered personal model (real GLB, real Chrome validation for its bounds). Generation itself is T06.
 const glb=await fs.readFile('assets/furniture/chair.glb'),verified=await validateModel(glb),png=await sharp({create:{width:96,height:96,channels:3,background:'#8e2c22'}}).png().toBuffer();
 const modelId=randomUUID(),imageId=randomUUID(),taskId=randomUUID(),assetId=randomUUID();
 await store.commit(await store.putStaged(glb),modelId,sha256(glb));await store.commit(await store.putStaged(png),imageId,sha256(png));
 const c=await pool.connect();try{await c.query('BEGIN');
  await c.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,'model',$1::text,$3,$4,'model/gltf-binary','committed'),($5::uuid,$2,'input_image',$5::text,$6,$7,'image/png','committed')",[modelId,collector.user.id,sha256(glb),glb.length,imageId,sha256(png),png.length]);
  await c.query("INSERT INTO generation_tasks(id,user_id,input_file_id,submitted_day,policy_version) VALUES($1,$2,$3,'2026-11-05','t08-browser-fixture')",[taskId,collector.user.id,imageId]);
  await c.query("INSERT INTO assets(id,owner_id,source_type,generation_task_id,model_file_id,original_image_id,name,normalization,bounds) VALUES($1,$2,'personal',$3,$4,$5,'资产01',$6,$7)",[assetId,collector.user.id,taskId,modelId,imageId,verified.normalization,verified.bounds]);
  await c.query("UPDATE generation_tasks SET status='succeeded',result_asset_id=$2 WHERE id=$1",[taskId,assetId]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}

 browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
 const ctx=()=>browser.newContext({viewport:{width:1440,height:900}});
 const userCtx=await ctx(),adminCtx=await ctx(),visitorCtx=await ctx();const up=await userCtx.newPage(),ap=await adminCtx.newPage(),vp=await visitorCtx.newPage();
 for(const [n,p] of [['user',up],['admin',ap],['visitor',vp]]){p.setDefaultTimeout(45000);p.on('pageerror',e=>errors.push(n+': '+e.message));}
 const ui=p=>p.evaluate(()=>window.__t10.ui());
 const enter=async p=>{await p.goto(base+'/');await p.waitForFunction(()=>window.__t10?.ui().phase==='intro',null,{timeout:90000});await p.getByRole('button',{name:'进入藏宝阁'}).click();await p.waitForFunction(()=>window.__t10.ui().phase==='play');};
 const faceSlot=async(p,x,z,yaw)=>{await p.evaluate(([x,z,yaw])=>{window.__t10.engine.debugPlace(x,z,0,yaw,-.22);},[x,z,yaw]);};

 await step('user submits a backpack model with full public data, withdraws and resubmits',async()=>{
  await up.goto(base+'/room?backpack=1');
  const bag=up.getByRole('dialog',{name:'背包'});await bag.getByLabel('用户名').fill('t08_collector');await bag.getByLabel('密码',{exact:true}).fill(pw);await bag.getByRole('button',{name:'登录并打开背包'}).click();
  await up.waitForFunction(() => document.querySelector('.bag-asset-card img')?.naturalWidth > 0);
  const card=bag.locator('.bag-asset-card').filter({hasText:'资产01'});
  assert.equal(await card.locator('.bag-approved').count(),0);
  await card.getByRole('button',{name:'预览模型：资产01',exact:true}).click();
  const preview=bag.getByRole('region',{name:'藏品预览'});
  await preview.getByRole('heading',{name:'资产01（藏友小周）'}).waitFor();
  await card.getByRole('button',{name:'修改名称：资产01',exact:true}).click();
  await bag.getByRole('textbox',{name:'藏品名称'}).fill('私藏靠背椅');
  await bag.getByRole('button',{name:'保存名称'}).click();
  await preview.getByRole('heading',{name:'私藏靠背椅（藏友小周）'}).waitFor();
  assert.equal(await bag.getByLabel('简介',{exact:true}).count(),0);
  assert.equal(await bag.locator('.bag-submit').count(),0);
  await bag.getByRole('button',{name:'投稿',exact:true}).click();
  await bag.getByLabel('选择要投稿的藏品').selectOption(assetId);
  const panel=bag.locator('.bag-submit');await panel.getByLabel('公共名称').waitFor();
  await panel.getByLabel('公共名称').fill('紫檀靠背椅');await panel.getByLabel('简介').fill('清代紫檀靠背椅，背板浮雕卷草纹。');await panel.getByLabel('年代').fill('不详');await panel.getByLabel('材质').fill('紫檀');
  await panel.getByLabel('归属类型').selectOption('personal_collection');await panel.getByLabel('收藏方名称').fill('藏友小周');await panel.getByLabel('所在地').fill('浙江杭州');
  await panel.getByRole('button',{name:'提交审核'}).click();await panel.getByText(/待审核/).waitFor();await up.screenshot({path:path.join(out,'01-user-submitted.png')});
  await panel.getByRole('button',{name:'撤回申请'}).click();await panel.getByRole('button',{name:'提交审核'}).waitFor();assert.equal(await panel.getByLabel('公共名称').inputValue(),'紫檀靠背椅','withdrawn data is prefilled for resubmission');
  await panel.getByRole('button',{name:'提交审核'}).click();await panel.getByText(/待审核/).waitFor();
 });
 await step('admin reviews earliest pending with rotatable model and original, approves into candidates',async()=>{
  await ap.goto(base+'/admin');await ap.getByLabel('用户名').fill('t08_admin');await ap.getByLabel('密码',{exact:true}).fill(pw);await ap.getByRole('button',{name:'登录',exact:true}).click();
  await ap.locator('.adm-row',{hasText:'紫檀靠背椅'}).click();await ap.locator('.adm-detail .bag-preview canvas').waitFor();await ap.waitForFunction(()=>!document.querySelector('.adm-detail .bag-preview-status'),null,{timeout:60000});
  assert.ok(await ap.locator('.adm-media img').evaluate(i=>i.complete&&i.naturalWidth>0),'original image visible');assert.equal(await ap.locator('.adm-detail').getByRole('textbox').count(),1,'only the rejection reason is editable');
  await ap.screenshot({path:path.join(out,'02-admin-review.png')});
  await ap.getByRole('button',{name:'通过，进入候选库'}).click();await ap.getByText(/已通过，进入候选库/).waitFor();
  const bag=up.getByRole('dialog',{name:'背包'});
  await bag.getByRole('button',{name:'刷新',exact:true}).click();
  await bag.locator('.bag-submit').getByText(/等待管理员安排展位/).waitFor();
  await bag.getByRole('button',{name:'藏品',exact:true}).click();
  await bag.locator('.bag-asset-card.approved').getByText('已通过',{exact:true}).waitFor();
  await up.screenshot({path:path.join(out,'t12-approved-card.png')});

  const adminRoom=await adminCtx.newPage();
  try{
   await adminRoom.goto(base+'/room');
   await adminRoom.getByRole('textbox',{name:'房间名称'}).waitFor();
   await adminRoom.waitForFunction(()=>window.__room?.snapshot()?.name==='个人小屋');
  }finally{await adminRoom.close();}
 });
 await step('admin arranges slots 1/2/19 from more candidates and publishes one gallery version',async()=>{
  await ap.getByRole('button',{name:'候选与展位'}).click();await ap.locator('.adm-slot').first().waitFor();
  for(const [slot,name] of [[0,'紫檀靠背椅'],[1,'明式长案'],[18,'双门陈列柜']]){await ap.locator('.adm-slot').nth(slot).click();await ap.locator('.adm-cand',{hasText:name}).click();}
  await ap.screenshot({path:path.join(out,'03-admin-gallery.png')});await ap.getByRole('button',{name:'保存并发布'}).click();await ap.getByText(/已发布展陈第 1 版/).waitFor();
 });
 let oldVisitorExhibits;
 await step('visitor sees real exhibits fitted on plinths in the full-viewport pavilion and opens E detail',async()=>{
  await enter(vp);await vp.waitForFunction(()=>window.__t10.ui().exhibits===3,null,{timeout:90000});
  assert.deepEqual(await vp.locator('.t10-canvas canvas').evaluate(el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];}),[0,0,1440,900]);
  const st=await vp.evaluate(()=>window.__t10.engine.debugState());const e1=st.exhibits.find(e=>e.slotNo===1);const [min,max]=e1.bounds;
  assert.ok(Math.abs(min[1]-1.17)<.02,'rests on plinth top '+min[1]);assert.ok(Math.abs((min[0]+max[0])/2+9.6)<.05&&Math.abs((min[2]+max[2])/2+10)<.05,'centred on T01');assert.ok(Math.max(max[0]-min[0],max[1]-min[1],max[2]-min[2])<=.801,'fitted size');
  await faceSlot(vp,-7.9,-10,Math.PI/2);await vp.waitForFunction(()=>window.__t10.engine.debugState().target?.id==='T01');await vp.locator('.t10-prompt').getByText('紫檀靠背椅').waitFor();await vp.screenshot({path:path.join(out,'04-visitor-prompt.png')});
  await vp.keyboard.press('KeyE');const dlg=vp.getByRole('dialog',{name:'紫檀靠背椅详情'});await dlg.getByText('投稿 · 藏友小周').waitFor();
  for(const t of ['不详','紫檀','个人收藏','藏友小周','浙江杭州'])await dlg.getByText(t,{exact:true}).first().waitFor();
  await vp.waitForFunction(()=>!document.querySelector('.t10-exhibit .bag-preview-status'),null,{timeout:60000});
  const layout = await dlg.evaluate(dialog => {
    const preview = dialog.querySelector('.bag-preview-wrap').getBoundingClientRect();
    const details = dialog.querySelector('.t10-exhibit-text');
    const rect = dialog.getBoundingClientRect();
    return {width:rect.width/innerWidth,height:rect.height/innerHeight,ratio:preview.width/details.clientWidth,previewHeight:preview.height};
  });
  assert.ok(layout.width > .96 && layout.width < .98 && Math.abs(layout.height - .83) < .01);
  assert.ok(Math.abs(layout.ratio - 3) < .05 && layout.previewHeight > 600);
  await vp.screenshot({path:path.join(out,'05-visitor-detail.png')});
  const text = dlg.locator('.t10-exhibit-text');
  const shortDescription = await text.locator('.t10-exhibit-desc').textContent();
  await text.locator('.t10-exhibit-desc').evaluate(element => { element.textContent = element.textContent.repeat(100); });
  assert.ok(await text.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop > 0; }), 'long details scroll inside the right column');
  await text.locator('.t10-exhibit-desc').evaluate((element, value) => { element.textContent = value; }, shortDescription);
  await vp.setViewportSize({width:390,height:844});
  assert.equal(await dlg.evaluate(dialog => {
    const preview = dialog.querySelector('.bag-preview-wrap').getBoundingClientRect();
    const details = dialog.querySelector('.t10-exhibit-text').getBoundingClientRect();
    return details.top >= preview.bottom && dialog.scrollWidth <= dialog.clientWidth;
  }), true, 'narrow detail stacks the model and text without horizontal overflow');
  await vp.setViewportSize({width:1440,height:900});
  await dlg.getByRole('button',{name:'添加到我的藏品'}).click();
  const account=vp.getByRole('dialog',{name:'账号设置',exact:true});
  await account.getByLabel('用户名',{exact:true}).fill('t13_visitor');
  await account.getByLabel('密码',{exact:true}).fill(pw);
  await account.getByRole('button',{name:'登录账号',exact:true}).click();
  await dlg.getByRole('button',{name:'添加到我的藏品'}).click();
  await dlg.getByRole('button',{name:'已收藏',exact:true}).waitFor();
  await vp.keyboard.press('Escape');await vp.waitForFunction(()=>window.__t10.ui().overlay===null);
  await vp.locator('.t10-canvas').click();await vp.waitForFunction(()=>window.__t10.ui().phase==='play');await faceSlot(vp,-6.6,-8.6,Math.PI*.5);await vp.evaluate(()=>window.__t10.engine.look(Math.PI*.5,-.12));await vp.waitForTimeout(500);await vp.screenshot({path:path.join(out,'06-visitor-hall.png')});
  oldVisitorExhibits=(await ui(vp)).exhibits;
 });
 await step('T13 collection preview, current author, room save, share and uncollect',async()=>{
  const collectorRoom=await visitorCtx.newPage();
  const shared=await browser.newPage({viewport:{width:1440,height:900}});
  collectorRoom.on('pageerror',error=>errors.push('collector room: '+error.message));
  shared.on('pageerror',error=>errors.push('shared room: '+error.message));
  try{
   await collectorRoom.goto(base+'/room?backpack=1');
   const bag=collectorRoom.getByRole('dialog',{name:'背包',exact:true});
   await bag.getByRole('button',{name:'我收藏的',exact:true}).click();
   await bag.getByRole('button',{name:'预览模型：紫檀靠背椅',exact:true}).click();
   const preview=bag.getByRole('region',{name:'藏品预览'});
   await preview.getByRole('heading',{name:'紫檀靠背椅（藏友小周）'}).waitFor();
   await preview.locator('canvas').waitFor();
   await collectorRoom.waitForFunction(()=>!document.querySelector('.bag-side-preview .bag-preview-status'));
   assert.equal(await bag.getByRole('button',{name:/修改名称/}).count(),0);
   assert.equal(await bag.evaluate(dialog=>dialog.querySelector('.bag-side-preview').getBoundingClientRect().right < dialog.querySelector('.bag-drawer').getBoundingClientRect().left),true);
   await call('/me','PATCH',{nickname:'作者现用昵称'},collector);
   await preview.getByRole('heading',{name:'紫檀靠背椅（作者现用昵称）'}).waitFor();
   await collectorRoom.screenshot({path:path.join(out,'t13-collected-preview.png')});
   await bag.getByRole('button',{name:'关闭背包',exact:true}).click();
   await collectorRoom.getByRole('button',{name:'打开物品库',exact:true}).click();
   for(const [index,name] of ['紫檀靠背椅','紫檀靠背椅','验收木椅'].entries()){
    await collectorRoom.getByRole('button',{name,exact:true}).click();
    await collectorRoom.waitForFunction(n=>window.__room?.snapshot()?.placements.length===n,index+1);
   }
   await collectorRoom.waitForFunction(()=>window.__room?.save?.state.status==='saved');
   await collectorRoom.getByRole('button',{name:'开启分享',exact:true}).click();
   const shareLink=collectorRoom.locator('.room-share-panel a');
   await shareLink.waitFor();
   await shared.goto(await shareLink.getAttribute('href'));
   await shared.waitForFunction(()=>window.__room?.snapshot()?.placements.length===3);
   await collectorRoom.reload();
   await collectorRoom.waitForFunction(()=>window.__room?.snapshot()?.placements.length===3);
   await bag.getByRole('button',{name:'我收藏的',exact:true}).click();
   await bag.getByRole('button',{name:'取消收藏：紫檀靠背椅',exact:true}).click();
   await bag.getByText('还没有收藏的展品').waitFor();
   await collectorRoom.waitForFunction(()=>window.__room?.snapshot()?.placements.length===1&&window.__room?.engine.debug().instances===1);
   await shared.reload();
   await shared.waitForFunction(()=>window.__room?.snapshot()?.placements.length===1);
  }finally{await shared.close();await collectorRoom.close();}
 });
 await step('admin adjusts only today\'s quota for the collector',async()=>{
  await ap.getByRole('button',{name:'用户与额度'}).click();await ap.locator('.adm-row',{hasText:'t08_collector'}).click();await ap.getByLabel('当天总额度').fill('5');await ap.getByRole('button',{name:'调整',exact:true}).click();await ap.getByText(/今天的总额度调为 5/).waitFor();
  const me=(await call('/me','GET',undefined,{cookie:collector.cookie})).data;assert.deepEqual([me.quota.total,me.quota.available],[5,5]);await ap.screenshot({path:path.join(out,'07-admin-quota.png')});
 });
 await step('risk delete clears room placement, candidate and slot; open page keeps loaded scene, refresh shows the result',async()=>{
  await call('/rooms/me/layout','PUT',{baseVersion:0,editSequence:1,name:'藏友小屋',placements:[{id:'p1',assetId,position:[0,0,0],rotation:[0,0,0],scale:1}]},{cookie:collector.cookie,'x-csrf-token':collector['x-csrf-token']});
  await ap.getByRole('button',{name:'资产与上传'}).click();await ap.getByLabel('GLB 模型').waitFor();assert.deepEqual(await ap.locator('input[type=file]').evaluateAll(inputs=>inputs.map(input=>input.accept)),['.glb,model/gltf-binary']);await ap.locator('.adm-row',{hasText:'私藏靠背椅'}).click();await ap.getByRole('button',{name:'风险删除…'}).click();await ap.screenshot({path:path.join(out,'08-admin-delete-confirm.png')});
  await ap.getByRole('button',{name:'确认删除'}).click();await ap.getByText(/已删除。清理 1 间小屋中的 1 处摆放，移出候选库，展位 1 已清空/).waitFor();
  assert.equal((await ui(vp)).exhibits,oldVisitorExhibits,'already-open page keeps its loaded exhibits');
  await enter(vp);await vp.waitForFunction(()=>window.__t10.ui().exhibits===2,null,{timeout:90000});await faceSlot(vp,-7.9,-10,Math.PI/2);await vp.waitForFunction(()=>window.__t10.engine.debugState().target?.id==='T01');await vp.keyboard.press('KeyE');await vp.getByText('虚位以待').waitFor();
  const room=(await call('/rooms/me','GET',undefined,{cookie:collector.cookie})).data;assert.equal(room.placements.length,0);assert.equal((await fetch(base+'/api/v1/assets/'+assetId,{headers:{cookie:collector.cookie}})).status,404);
  await vp.screenshot({path:path.join(out,'09-visitor-after-delete.png')});
 });
 assert.deepEqual(errors,[]);
 const result={pass:true,chrome:browser.version(),os:`${os.type()} ${os.release()} ${os.arch()}`,viewport:[1440,900],isolatedDatabase:true,checks,ms:Date.now()-started};
 await fs.writeFile(path.join(out,'browser-check.json'),JSON.stringify(result,null,1));console.log(JSON.stringify(result));
}catch(e){
 console.error('FAIL',e);
 if(browser)for(const c of browser.contexts())for(const [i,p] of c.pages().entries())await p.screenshot({path:path.join(out,`fail-${browser.contexts().indexOf(c)}-${i}.png`)}).catch(()=>{});
 console.error('page errors:',errors);process.exitCode=1;
}finally{await browser?.close();await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
