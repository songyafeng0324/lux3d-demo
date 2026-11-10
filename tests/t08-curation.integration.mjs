import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {loadConfig,createPool,LocalFileStore,seedAdmin,GenerationWorker,cleanupTick} from '@aholo/domain';
import {migrate} from '../scripts/migrate.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const placement=(assetId,id,position=[0,0,0])=>({id,assetId,position,rotation:[0,0,0],scale:1});
const publicFields=(over={})=>({name:'青花缠枝莲纹瓶',description:'明代青花瓷瓶，器身绘缠枝莲纹。',era:'明代',material:'瓷',ownershipType:'museum',holderName:'某市博物馆',location:'江西景德镇',officialUrl:'',...over});
function multi(fields,bytes,filename){const boundary='aholo-'+randomUUID(),chunks=[];for(const[k,v]of Object.entries(fields))chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`));return {payload:Buffer.concat(chunks),type:`multipart/form-data; boundary=${boundary}`};}

test('T08 real PostgreSQL/API: submissions, review races, 30-slot publishing, gallery grants, quota and risk deletion',async()=>{
 const base=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
 const bootstrap=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await bootstrap.connect();
 const db='aholo_t08_'+randomUUID().replaceAll('-','');await bootstrap.query(`CREATE DATABASE ${db} OWNER aholo_app`);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t08-'));const u=new URL(base.databaseUrl);u.pathname='/'+db;const pool=createPool(u.href);const store=new LocalFileStore(root);await store.initialize();let app;
 try{
  await migrate(pool);const config={...base,databaseUrl:u.href,dataDir:root,appDataKey:randomBytes(32).toString('hex'),generationEnabled:false};app=await buildApp(config);await app.ready();
  const call=(method,url,payload,headers={})=>app.inject({method,url,...(payload!==undefined?{payload}:{}),headers:{origin:base.publicOrigin,'idempotency-key':randomUUID(),...headers}});
  const password='t08-fixture-password-123';
  async function login(username){const r=await call('POST','/api/v1/auth/login',{username,password});assert.equal(r.statusCode,200,r.body);return {user:r.json().data.user,headers:{cookie:r.headers['set-cookie'].split(';')[0],'x-csrf-token':r.json().data.csrfToken}};}
  async function account(username){const r=await call('POST','/api/v1/auth/register',{username,nickname:username+'昵称',password,confirmPassword:password});assert.equal(r.statusCode,201,r.body);return login(username);}
  const alice=await account('t08_alice'),bob=await account('t08_bob');
  assert.equal((await seedAdmin(pool,{username:'t08_admin',nickname:'管理员',password})).created,true);const admin=await login('t08_admin');assert.equal(admin.user.role,'admin');
  const adminRoom=(await call('GET','/api/v1/rooms/me',undefined,admin.headers)).json().data;
  assert.equal(adminRoom.version,0);assert.deepEqual(adminRoom.placements,[]);
  assert.equal((await seedAdmin(pool,{username:'t08_admin',nickname:'另一昵称',password})).created,false);
  const legacyId=randomUUID(),systemId=randomUUID();
  await pool.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) SELECT $1,'t08_legacy','t08_legacy','旧管理员',password_hash,'admin' FROM users WHERE id=$2",[legacyId,admin.user.id]);
  await pool.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) VALUES($1,'t08_system','t08_system','系统来源','system:no-login','admin')",[systemId]);
  const backfill=await fs.readFile(new URL('../migrations/005_admin_rooms.sql',import.meta.url),'utf8');
  await pool.query(backfill);await pool.query(backfill);
  const legacy=await login('t08_legacy');
  const migratedRoom=(await call('GET','/api/v1/rooms/me',undefined,legacy.headers)).json().data;
  assert.equal(migratedRoom.version,0);assert.deepEqual(migratedRoom.placements,[]);
  assert.equal((await call('GET','/api/v1/rooms/me',undefined,admin.headers)).json().data.id,adminRoom.id);
  assert.equal((await pool.query('SELECT id FROM rooms WHERE owner_id=$1',[systemId])).rowCount,0);
  async function file(ownerId,purpose,bytes){const id=randomUUID(),hash=sha(bytes),staged=await store.putStaged(bytes);await store.commit(staged,id,hash);await pool.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'committed')",[id,ownerId,purpose,hash,bytes.length,purpose==='model'?'model/gltf-binary':'image/png']);return id;}
  // SQL fixtures model already-delivered personal assets; the generation pipeline itself is covered by T06.
  async function personal(ownerId){const id=randomUUID(),task=randomUUID(),model=await file(ownerId,'model',Buffer.from('model-'+id)),original=await file(ownerId,'input_image',Buffer.from('original-'+id));const c=await pool.connect();try{await c.query('BEGIN');await c.query("INSERT INTO generation_tasks(id,user_id,input_file_id,submitted_day,policy_version) VALUES($1,$2,$3,'2026-11-05','t08-fixture')",[task,ownerId,original]);await c.query("INSERT INTO assets(id,owner_id,source_type,generation_task_id,model_file_id,original_image_id,name,normalization,bounds) VALUES($1,$2,'personal',$3,$4,$5,$6,$7,$8)",[id,ownerId,task,model,original,'资产-'+id.slice(0,4),{scale:1,translation:[0,0,0]},{min:[-.4,0,-.4],max:[.4,.8,.4]}]);await c.query("UPDATE generation_tasks SET status='succeeded',result_asset_id=$2 WHERE id=$1",[task,id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}return {id,model,original};}
  const verified=bytes=>({sha256:sha(bytes),byteSize:bytes.length,triangles:12,rendered:true,normalization:{scale:1,translation:[0,0,0]},bounds:{min:[-.5,0,-.5],max:[.5,1,.5]}});
  const worker=new GenerationWorker(pool,store,config,{validate:async bytes=>verified(bytes)});
  async function adminImport(fields,label){const m=multi(fields,Buffer.from('glTF-fixture-'+label+randomUUID()),'m.glb');const r=await app.inject({method:'POST',url:'/api/v1/admin/assets',payload:m.payload,headers:{...admin.headers,origin:base.publicOrigin,'idempotency-key':randomUUID(),'content-type':m.type}});assert.equal(r.statusCode,202,r.body);await worker.tick(r.json().data.id);const s=await call('GET','/api/v1/admin/imports/'+r.json().data.id,undefined,admin.headers);assert.equal(s.json().data.status,'succeeded',s.body);return s.json().data.assetId;}

  // ---- F06 submissions (AC27～AC31) ----
  const a1=await personal(alice.user.id),a2=await personal(alice.user.id),a3=await personal(alice.user.id),b1=await personal(bob.user.id);
  assert.equal((await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields())).statusCode,401);
  const missing=await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields({holderName:' ',era:''}),alice.headers);assert.equal(missing.statusCode,422);assert.deepEqual(missing.json().error.fields.sort(),['era','holderName']);
  assert.equal((await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields({officialUrl:'ftp://x'}),alice.headers)).statusCode,422);
  assert.equal((await call('POST',`/api/v1/assets/${b1.id}/submissions`,publicFields(),alice.headers)).statusCode,404,'cannot submit another user\'s model');
  // Concurrent different-key submissions of one model: exactly one pending (D03 cross-table exclusion).
  const dup=await Promise.all([1,2,3].map(()=>call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields({era:'不详',material:'不详'}),alice.headers)));
  assert.deepEqual(dup.map(r=>r.statusCode).sort(),[201,409,409]);const sub1=dup.find(r=>r.statusCode===201).json().data;assert.equal(sub1.status,'pending');assert.equal(sub1.publicSnapshot.era,'不详');assert.equal(sub1.publicSnapshot.sourceNickname,'t08_alice昵称');
  const sameKey=randomUUID();const replays=await Promise.all([1,2].map(()=>call('POST',`/api/v1/submissions/${sub1.id}/withdraw`,undefined,{...alice.headers,'idempotency-key':sameKey})));
  assert.deepEqual(replays.map(r=>r.statusCode),[200,200]);assert.equal(replays[0].json().data.status,'withdrawn');assert.equal((await call('POST',`/api/v1/submissions/${sub1.id}/withdraw`,undefined,alice.headers)).statusCode,409);
  assert.equal((await call('POST',`/api/v1/submissions/${sub1.id}/withdraw`,undefined,bob.headers)).statusCode,404);
  // Resubmit after withdrawal; a second model later; admin sees earliest first.
  const sub2=(await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields(),alice.headers)).json().data;await new Promise(r=>setTimeout(r,15));
  const sub3=(await call('POST',`/api/v1/assets/${a2.id}/submissions`,publicFields({name:'铜镜'}),alice.headers)).json().data;
  const pendingAsset=await call('GET',`/api/v1/assets/${a2.id}`,undefined,alice.headers);
  assert.equal(pendingAsset.json().data.submissionApproved,false);
  assert.equal((await call('GET','/api/v1/admin/submissions',undefined,alice.headers)).statusCode,403);
  const queue=(await call('GET','/api/v1/admin/submissions',undefined,admin.headers)).json().data.items;assert.deepEqual(queue.map(s=>s.id),[sub2.id,sub3.id]);assert.equal(queue[0].applicant.username,'t08_alice');assert.ok(queue[0].model.modelFileId&&queue[0].originalImageId);
  assert.equal((await call('GET',`/api/v1/files/${queue[0].originalImageId}/content`,undefined,admin.headers)).statusCode,200,'admin can view the submitted original');
  assert.equal((await call('POST',`/api/v1/admin/submissions/${sub2.id}/review`,{decision:'reject'},admin.headers)).statusCode,422,'reject needs reason');
  assert.equal((await call('POST',`/api/v1/admin/submissions/${sub2.id}/review`,{decision:'approve',name:'改写'},admin.headers)).statusCode,422,'review cannot rewrite data');
  assert.equal((await call('POST',`/api/v1/admin/submissions/${sub2.id}/review`,{decision:'approve'},alice.headers)).statusCode,403);
  const rejected=await call('POST',`/api/v1/admin/submissions/${sub2.id}/review`,{decision:'reject',reason:'非古玩文物方向'},admin.headers);assert.equal(rejected.statusCode,200,rejected.body);
  const mine=(await call('GET',`/api/v1/submissions?assetId=${a1.id}`,undefined,alice.headers)).json().data.items;assert.equal(mine[0].status,'rejected');assert.equal(mine[0].rejectionReason,'非古玩文物方向');
  assert.equal((await call('GET',`/api/v1/assets/${a1.id}`,undefined,alice.headers)).statusCode,200,'rejected model stays in backpack');
  // Approve vs withdraw race on one pending submission: exactly one wins and occupancy stays consistent.
  for(let i=0;i<4;i++){
   const s=(await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields({name:'重提'+i}),alice.headers)).json().data;
   const [rev,wd]=await Promise.all([call('POST',`/api/v1/admin/submissions/${s.id}/review`,{decision:'approve'},admin.headers),call('POST',`/api/v1/submissions/${s.id}/withdraw`,undefined,alice.headers)]);
   assert.deepEqual([rev.statusCode,wd.statusCode].sort(),[200,409]);
   const occ=(await pool.query('SELECT p.*,c.id AS cid FROM active_publications p LEFT JOIN candidates c ON c.asset_id=p.asset_id WHERE p.asset_id=$1',[a1.id])).rows;
   if(rev.statusCode===200){assert.equal(occ.length,1);assert.equal(occ[0].candidate_id,rev.json().data.candidateId);break;}
   assert.equal(occ.length,0);assert.equal((await pool.query('SELECT count(*)::int n FROM candidates WHERE asset_id=$1',[a1.id])).rows[0].n,0);
  }
  if(!(await pool.query('SELECT 1 FROM candidates WHERE asset_id=$1',[a1.id])).rowCount){const s=(await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields(),alice.headers)).json().data;assert.equal((await call('POST',`/api/v1/admin/submissions/${s.id}/review`,{decision:'approve'},admin.headers)).statusCode,200);}
  assert.equal((await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields(),alice.headers)).statusCode,409,'candidate blocks another submission');
  assert.equal((await call('POST',`/api/v1/admin/submissions/${sub3.id}/review`,{decision:'approve'},admin.headers)).statusCode,200);
  // AC33: later nickname/asset edits do not change the frozen public data.
  assert.equal((await call('PATCH','/api/v1/me',{nickname:'改名后'},alice.headers)).statusCode,200);assert.equal((await call('PATCH',`/api/v1/assets/${a1.id}`,{name:'个人新名',description:''},alice.headers)).statusCode,200);
  let candidates=(await call('GET','/api/v1/admin/candidates',undefined,admin.headers)).json().data.items;const c1=candidates.find(c=>c.assetId===a1.id),c3=candidates.find(c=>c.assetId===a2.id);
  assert.equal(c1.publicSnapshot.sourceNickname,'t08_alice昵称');assert.notEqual(c1.publicSnapshot.name,'个人新名');assert.equal(c1.slotNo,null,'approval does not auto-exhibit');
  const collection=(await call('GET','/api/v1/assets',undefined,alice.headers)).json().data.items;
  assert.deepEqual(Object.fromEntries(collection.map(a=>[a.id,a.submissionApproved])),{[a1.id]:true,[a2.id]:true,[a3.id]:false});

  // ---- F11 imports: official candidate vs furniture (AC43～AC46) ----
  const missingOfficial=multi({sourceType:'official_candidate',name:'玉璧',description:'x',era:'',material:'玉',ownershipType:'museum',holderName:'馆',location:'京'},Buffer.from('glb'),'m.glb');
  assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/assets',payload:missingOfficial.payload,headers:{...admin.headers,origin:base.publicOrigin,'idempotency-key':randomUUID(),'content-type':missingOfficial.type}})).statusCode,422);
  const official=await adminImport({sourceType:'official_candidate',name:'谷纹玉璧',description:'战国玉璧',era:'战国',material:'玉',ownershipType:'museum',holderName:'某省博物院',location:'湖北武汉',officialUrl:'https://museum.example'},'official');
  const furniture=await adminImport({sourceType:'furniture',name:'条案',description:''},'furniture');
  candidates=(await call('GET','/api/v1/admin/candidates',undefined,admin.headers)).json().data.items;const cOfficial=candidates.find(c=>c.assetId===official);assert.equal(cOfficial.source,'official');assert.equal(cOfficial.publicSnapshot.sourceNickname,'官方馆藏');
  const furnitureList=(await call('GET','/api/v1/furniture',undefined,bob.headers)).json().data.items.map(a=>a.id);assert.ok(furnitureList.includes(furniture));assert.ok(!furnitureList.includes(official),'official candidate is not furniture');
  assert.equal((await call('PATCH',`/api/v1/admin/assets/${a1.id}`,{name:'代改',description:''},admin.headers)).statusCode,403,'admin cannot edit user asset text');
  // AC34: more than 30 candidates are allowed.
  for(let i=0;i<30;i++){const id=randomUUID(),imp=randomUUID(),f=await file(admin.user.id,'model',Buffer.from('bulk-'+id)),cand=randomUUID();const c=await pool.connect();try{await c.query('BEGIN');await c.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,'official_candidate','{}','t08-fixture')",[imp,admin.user.id,f]);await c.query("INSERT INTO assets(id,source_type,import_id,model_file_id,name,normalization,bounds) VALUES($1,'official_candidate',$2,$3,$4,$5,$6)",[id,imp,f,'批量'+i,{scale:1,translation:[0,0,0]},{min:[-.5,0,-.5],max:[.5,1,.5]}]);await c.query("UPDATE asset_imports SET state='succeeded',result_asset_id=$2 WHERE id=$1",[imp,id]);await c.query("INSERT INTO candidates(id,asset_id,source,public_snapshot) VALUES($1,$2,'official',$3)",[cand,id,{...publicFields({name:'批量'+i}),sourceNickname:'官方馆藏'}]);await c.query('INSERT INTO active_publications(asset_id,candidate_id) VALUES($1,$2)',[id,cand]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  candidates=(await call('GET','/api/v1/admin/candidates',undefined,admin.headers)).json().data.items;assert.ok(candidates.length>30);

  // ---- F08 30-slot publishing (AC34～AC36) ----
  let gallery=(await call('GET','/api/v1/admin/gallery',undefined,admin.headers)).json().data;assert.equal(gallery.version,0);assert.equal(gallery.slots.length,30);
  const empty=Array.from({length:30},(_,i)=>({slotNo:i+1,candidateId:null}));const arrange=(pairs)=>empty.map(s=>({...s,candidateId:pairs[s.slotNo]??null}));
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:empty.slice(1)},admin.headers)).statusCode,422);
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:arrange({1:c1.id,2:c1.id})},admin.headers)).statusCode,422,'one candidate cannot fill two slots');
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:[...empty.slice(0,29),{slotNo:1,candidateId:null}]},admin.headers)).statusCode,422);
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:arrange({1:randomUUID()})},admin.headers)).statusCode,422);
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:empty},alice.headers)).statusCode,403);
  const racing=await Promise.all([call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:arrange({1:c1.id,5:cOfficial.id})},admin.headers),call('PUT','/api/v1/admin/gallery',{baseVersion:0,slots:arrange({2:c3.id})},admin.headers)]);
  assert.deepEqual(racing.map(r=>r.statusCode).sort(),[200,409]);const lost=racing.find(r=>r.statusCode===409).json();assert.equal(lost.error.currentVersion,1);
  const published=await call('PUT','/api/v1/admin/gallery',{baseVersion:1,slots:arrange({1:c1.id,5:cOfficial.id,12:c3.id,30:candidates.find(c=>c.publicSnapshot.name==='批量0').id})},admin.headers);assert.equal(published.statusCode,200,published.body);assert.equal(published.json().data.publishedVersion,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM exhibit_slots')).rows[0].n,30);

  // ---- F09 public gallery and grants (AC37/AC38/AC42) ----
  const view=(await call('GET','/api/v1/gallery')).json().data;assert.equal(view.version,2);assert.equal(view.slots.length,30);assert.equal(view.slots.filter(s=>s.exhibit).length,4);
  const g=view.grant,gh={authorization:'Bearer '+g.token,'x-snapshot-grant':g.id};const slot1=view.slots[0].exhibit;assert.equal(slot1.candidateId,c1.id);
  const detail=await call('GET',`/api/v1/snapshots/${g.id}/details/${c1.id}`,undefined,{authorization:'Bearer '+g.token});assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().data.sourceNickname,'t08_alice昵称');assert.equal(detail.json().data.holderName,'某市博物馆');assert.equal(detail.json().data.slotNo,1);
  assert.equal((await call('GET',`/api/v1/snapshots/${g.id}/details/${c1.id}`,undefined,{authorization:'Bearer '+'0'.repeat(64)})).statusCode,404,'token must match');
  assert.equal((await call('GET',`/api/v1/snapshots/${g.id}/details/${candidates.find(c=>c.publicSnapshot.name==='批量1').id}`,undefined,{authorization:'Bearer '+g.token})).statusCode,404,'unexhibited candidate has no public detail');
  assert.equal((await call('GET',`/api/v1/files/${slot1.model.modelFileId}/content`,undefined,gh)).statusCode,200);
  assert.equal((await call('GET',`/api/v1/files/${a1.original}/content`,undefined,gh)).statusCode,404,'gallery grant never exposes originals');
  assert.equal((await call('GET',`/api/v1/files/${a3.model}/content`,undefined,gh)).statusCode,404);
  assert.equal((await call('POST',`/api/v1/snapshots/${g.id}/renew`,undefined,gh)).statusCode,200);
  // T13: a collection grants only model access and room placement. Its metadata is live.
  const collectionPath=id=>`/api/v1/gallery/exhibits/${id}/collection`;
  const collectionList=async actor=>(await call('GET','/api/v1/collections',undefined,actor.headers)).json().data.items;
  const bobCollect={...bob.headers,...gh};
  const collectKey=randomUUID();
  assert.equal((await call('POST',collectionPath(c1.id),undefined,gh)).statusCode,401);
  assert.equal((await call('POST',collectionPath(c1.id),undefined,bob.headers)).statusCode,403);
  assert.equal((await call('POST',collectionPath(randomUUID()),undefined,bobCollect)).statusCode,404);
  assert.equal((await call('POST',collectionPath(c1.id),undefined,{...alice.headers,...gh})).json().data.status,'owned');
  const adds=await Promise.all([collectKey,collectKey,randomUUID()].map(key=>call('POST',collectionPath(c1.id),undefined,{...bobCollect,'idempotency-key':key})));
  for(const add of adds) assert.equal(add.json().data?.status,'collected',add.body);
  const [collected]=(await collectionList(bob));
  assert.deepEqual([collected.id,collected.name,collected.authorNickname],[a1.id,detail.json().data.name,'改名后']);
  assert.equal('originalImageId' in collected,false);
  assert.equal((await collectionList(bob)).length,1);
  assert.deepEqual(await collectionList(alice),[]);
  assert.equal((await call('POST',collectionPath(cOfficial.id),undefined,bobCollect)).json().data.status,'collected');
  assert.equal((await collectionList(bob)).find(item=>item.id===official).authorNickname,'官方馆藏');
  assert.equal((await call('GET',`/api/v1/files/${a1.model}/content`,undefined,bob.headers)).statusCode,200);
  assert.equal((await call('GET',`/api/v1/files/${a1.original}/content`,undefined,bob.headers)).statusCode,404);
  assert.equal((await call('PATCH',`/api/v1/assets/${a1.id}`,{name:'越权修改'},bob.headers)).statusCode,404);
  assert.equal((await call('POST',`/api/v1/assets/${a1.id}/submissions`,publicFields(),bob.headers)).statusCode,404);
  assert.equal((await call('PATCH',`/api/v1/assets/${a1.id}`,{name:'个人背包改名'},alice.headers)).statusCode,200);
  assert.equal((await call('PATCH','/api/v1/me',{nickname:'作者新昵称'},alice.headers)).statusCode,200);
  await pool.query("UPDATE candidates SET public_snapshot=jsonb_set(public_snapshot,'{name}',to_jsonb($2::text)) WHERE id=$1",[c1.id,'获审公开名称修订']);
  const updated=(await collectionList(bob)).find(item=>item.id===a1.id);
  assert.deepEqual([updated.name,updated.authorNickname],['获审公开名称修订','作者新昵称']);
  // AC36: removing an exhibit (ordinary unpublish) keeps the model and private placements.
  let room=(await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data;
  let save=await call('PUT','/api/v1/rooms/me/layout',{baseVersion:room.version,editSequence:1,name:'藏品小屋',placements:[placement(a1.id,'x1',[-1,0,0]),placement(a1.id,'x2',[1,0,0]),placement(a3.id,'y1',[0,0,1]),placement(furniture,'f1',[0,0,-2])]},alice.headers);assert.equal(save.statusCode,200,save.body);
  const unpublish=await call('PUT','/api/v1/admin/gallery',{baseVersion:2,slots:arrange({5:cOfficial.id,12:c3.id})},admin.headers);assert.equal(unpublish.json().data.publishedVersion,3);
  const unpublishedAsset=await call('GET',`/api/v1/assets/${a1.id}`,undefined,alice.headers);
  assert.equal(unpublishedAsset.statusCode,200);assert.equal(unpublishedAsset.json().data.submissionApproved,true);
  assert.equal((await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data.placements.length,4);
  assert.equal((await call('GET',`/api/v1/snapshots/${g.id}/details/${c1.id}`,undefined,{authorization:'Bearer '+g.token})).statusCode,200,'old grant keeps its own version');
  const carol=await account('t13_carol');
  assert.equal((await call('GET',`/api/v1/files/${a1.model}/content`,undefined,carol.headers)).statusCode,404);
  assert.equal((await call('POST',collectionPath(c1.id),undefined,{...carol.headers,...gh})).statusCode,409,'old gallery grant cannot add a withdrawn exhibit');
  assert.equal((await collectionList(bob)).find(item=>item.id===a1.id).name,'获审公开名称修订');
  const collectedLayout={baseVersion:0,editSequence:1,name:'收藏小屋',placements:[placement(a1.id,'col1'),placement(a1.id,'col2'),placement(b1.id,'own')]};
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',collectedLayout,bob.headers)).statusCode,200,'saved after ordinary withdrawal');
  const bobShare=(await call('PUT','/api/v1/rooms/me/share',{enabled:true},bob.headers)).json().data.shareUrl.split('/').at(-1);
  const oldBobShare=(await call('GET',`/api/v1/shared-rooms/${bobShare}`)).json().data;
  const oldBobGrant={authorization:'Bearer '+oldBobShare.grant.token,'x-snapshot-grant':oldBobShare.grant.id};
  const assetFile=`/api/v1/files/${a1.model}/content`;
  assert.equal((await call('GET',assetFile,undefined,oldBobGrant)).statusCode,200);
  const removePath=`/api/v1/collections/${collected.collectionId}`,removeKey=randomUUID();
  assert.equal((await call('DELETE',removePath,undefined,carol.headers)).statusCode,404);
  const removed=await call('DELETE',removePath,undefined,{...bob.headers,'idempotency-key':removeKey});
  assert.deepEqual(removed.json().data,{previousVersion:1,roomVersion:2,placementsRemoved:2});
  assert.deepEqual((await call('GET',`/api/v1/shared-rooms/${bobShare}`)).json().data.placements.map(p=>p.id),['own']);
  assert.equal((await call('GET',assetFile,undefined,bob.headers)).statusCode,404);
  assert.equal((await call('GET',assetFile,undefined,oldBobGrant)).statusCode,404);
  assert.equal((await call('GET',`/api/v1/files/${b1.model}/content`,undefined,oldBobGrant)).statusCode,200);
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',{...collectedLayout,baseVersion:1},bob.headers)).statusCode,409);
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',{...collectedLayout,baseVersion:2},bob.headers)).statusCode,422);
  // Official text edit while exhibited: new gallery version, old grant still reads old text.
  assert.equal((await call('PATCH',`/api/v1/admin/assets/${official}`,{...publicFields(),modelFileId:randomUUID()},admin.headers)).statusCode,422);
  const edit=await call('PATCH',`/api/v1/admin/assets/${official}`,{...publicFields({name:'谷纹玉璧（修订）'}),officialUrl:'https://museum.example/b'},admin.headers);assert.equal(edit.statusCode,200,edit.body);assert.equal(edit.json().data.galleryVersion,4);
  assert.equal((await call('GET',`/api/v1/snapshots/${g.id}/details/${cOfficial.id}`,undefined,{authorization:'Bearer '+g.token})).json().data.name,'谷纹玉璧');
  const editedExhibit=(await call('GET','/api/v1/gallery')).json().data.slots[4].exhibit;
  assert.equal(editedExhibit.name,'谷纹玉璧（修订）');
  assert.equal(editedExhibit.model.modelFileId,view.slots[4].exhibit.model.modelFileId);
  assert.equal((await collectionList(bob)).find(item=>item.id===official).name,editedExhibit.name);
  await call('PUT','/api/v1/admin/gallery',{baseVersion:4,slots:arrange({1:c1.id,5:cOfficial.id,12:c3.id})},admin.headers);
  assert.equal((await call('POST',collectionPath(c1.id),undefined,{...bobCollect,'idempotency-key':collectKey})).json().data.status,'available','replaying the original add cannot undo removal');
  assert.equal((await call('POST',collectionPath(c1.id),undefined,bobCollect)).json().data.status,'collected');
  assert.deepEqual((await call('DELETE',removePath,undefined,{...bob.headers,'idempotency-key':removeKey})).json().data,removed.json().data);
  assert.notEqual((await collectionList(bob)).find(item=>item.id===a1.id).collectionId,collected.collectionId);
  assert.equal((await call('GET',assetFile,undefined,oldBobGrant)).statusCode,404,'recollecting does not revive the old share grant');
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',{...collectedLayout,baseVersion:2},bob.headers)).statusCode,200);

  // ---- F12 users and today's quota (AC47～AC50) ----
  assert.equal((await call('GET','/api/v1/admin/users',undefined,bob.headers)).statusCode,403);
  const users=(await call('GET','/api/v1/admin/users',undefined,admin.headers)).json().data.items;assert.ok(users.some(x=>x.username==='t08_alice'));assert.ok(users.every(x=>!('password_hash' in x)));
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await pool.query('INSERT INTO quota_days(user_id,quota_day,used_net) VALUES($1,$2,2)',[bob.user.id,day]);
  const beforeOverride=(await call('GET',`/api/v1/admin/users/${bob.user.id}`,undefined,admin.headers)).json().data.quota;
  assert.deepEqual([beforeOverride.total,beforeOverride.used,beforeOverride.available,beforeOverride.adjusted],[10,2,8,false]);
  const activeTask=randomUUID();
  await pool.query("INSERT INTO generation_tasks(id,user_id,input_file_id,submitted_day,policy_version) VALUES($1,$2,$3,$4,'t09-quota-fixture')",[activeTask,bob.user.id,b1.original,day]);
  assert.equal((await call('PUT',`/api/v1/admin/users/${bob.user.id}/quota`,{total:5},alice.headers)).statusCode,403,'users cannot adjust quota');
  assert.equal((await call('PUT',`/api/v1/admin/users/${bob.user.id}/quota`,{total:-1},admin.headers)).statusCode,422);
  let q=(await call('PUT',`/api/v1/admin/users/${bob.user.id}/quota`,{total:5},admin.headers)).json().data;assert.deepEqual([q.total,q.used,q.available],[5,2,3]);
  q=(await call('PUT',`/api/v1/admin/users/${bob.user.id}/quota`,{total:1},admin.headers)).json().data;assert.deepEqual([q.total,q.used,q.available],[1,2,0]);
  const adjusted=(await call('GET','/api/v1/me',undefined,bob.headers)).json().data;
  assert.equal(adjusted.quota.available,0);
  assert.equal(adjusted.activeTask.id,activeTask);
  assert.equal(adjusted.activeTask.status,'processing');
  await pool.query('DELETE FROM generation_tasks WHERE id=$1',[activeTask]);
  const detailUser=(await call('GET',`/api/v1/admin/users/${alice.user.id}`,undefined,admin.headers)).json().data;assert.equal(detailUser.counts.assets,3);assert.ok(!('password_hash' in detailUser.user));
  assert.equal((await pool.query("SELECT override_total FROM quota_days WHERE user_id=$1 AND quota_day<>$2",[bob.user.id,day])).rowCount,0,'only today is adjusted');

  // ---- F13 risk deletion and its race with stale saves/shares (AC51) ----
  const share=await call('PUT','/api/v1/rooms/me/share',{enabled:true},alice.headers);const token=share.json().data.shareUrl.split('/').at(-1);
  const visitor=(await call('GET','/api/v1/shared-rooms/'+token)).json().data;const vh={authorization:'Bearer '+visitor.grant.token,'x-snapshot-grant':visitor.grant.id};
  const galleryBefore=(await call('GET','/api/v1/gallery')).json().data;const ogh={authorization:'Bearer '+galleryBefore.grant.token,'x-snapshot-grant':galleryBefore.grant.id};
  room=(await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data;const staleBase=room.version,staleKey=randomUUID(),staleBody={baseVersion:staleBase,editSequence:9,name:'藏品小屋',placements:[...room.placements,placement(a1.id,'x3',[2,0,2])]};
  assert.equal((await call('DELETE',`/api/v1/admin/assets/${a1.id}`,undefined,alice.headers)).statusCode,403);
  const delKey=randomUUID(),del=await call('DELETE',`/api/v1/admin/assets/${a1.id}`,undefined,{...admin.headers,'idempotency-key':delKey});assert.equal(del.statusCode,200,del.body);
  assert.deepEqual((await call('DELETE',`/api/v1/admin/assets/${a1.id}`,undefined,{...admin.headers,'idempotency-key':delKey})).json().data,del.json().data,'a lost-response retry replays the receipt');
  assert.deepEqual({...del.json().data,galleryVersion:undefined},{deleted:true,roomsUpdated:2,placementsRemoved:4,submissionsClosed:1,candidateRemoved:true,slotNo:1,galleryVersion:undefined});
  assert.equal((await collectionList(bob)).some(item=>item.id===a1.id),false);
  assert.deepEqual((await call('GET',`/api/v1/shared-rooms/${bobShare}`)).json().data.placements.map(p=>p.id),['own']);
  const conflict=await call('PUT','/api/v1/rooms/me/layout',staleBody,{...alice.headers,'idempotency-key':staleKey});assert.equal(conflict.statusCode,409,conflict.body);assert.equal(conflict.json().error.currentVersion,staleBase+1,'stale draft with the deleted model reports a version conflict');
  room=(await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data;assert.deepEqual(room.placements.map(p=>p.id).sort(),['f1','y1'],'other placements are kept');
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',{...staleBody,baseVersion:room.version},alice.headers)).statusCode,422,'current-version save cannot re-add a deleted model');
  assert.equal((await call('GET',`/api/v1/assets/${a1.id}`,undefined,alice.headers)).statusCode,404);
  for(const f of [a1.model,a1.original]){assert.equal((await call('GET',`/api/v1/files/${f}/content`,undefined,alice.headers)).statusCode,404);assert.equal((await call('GET',`/api/v1/files/${f}/content`,undefined,admin.headers)).statusCode,404);}
  assert.equal((await call('GET',`/api/v1/files/${a1.model}/content`,undefined,vh)).statusCode,404,'old share grant cannot fetch the deleted model');
  assert.equal((await call('POST',`/api/v1/snapshots/${visitor.grant.id}/renew`,undefined,vh)).statusCode,404,'old share grant is not renewed');
  assert.equal((await call('GET',`/api/v1/files/${a1.model}/content`,undefined,ogh)).statusCode,404,'old gallery grant cannot fetch it');
  assert.equal((await call('GET',`/api/v1/snapshots/${galleryBefore.grant.id}/details/${c1.id}`,undefined,{authorization:'Bearer '+galleryBefore.grant.token})).statusCode,404);
  assert.equal((await call('GET',`/api/v1/snapshots/${galleryBefore.grant.id}/details/${c3.id}`,undefined,{authorization:'Bearer '+galleryBefore.grant.token})).statusCode,200,'other exhibits of a loaded page stay readable');
  const refreshed=(await call('GET','/api/v1/shared-rooms/'+token)).json().data;assert.deepEqual(refreshed.placements.map(p=>p.id).sort(),['f1','y1']);
  const galleryAfter=(await call('GET','/api/v1/gallery')).json().data;assert.equal(galleryAfter.slots[0].exhibit,null);assert.ok(galleryAfter.slots[11].exhibit);
  assert.equal((await pool.query('SELECT count(*)::int n FROM candidates WHERE asset_id=$1',[a1.id])).rows[0].n,0);
  assert.ok((await pool.query("SELECT status FROM submissions WHERE asset_id=$1",[a1.id])).rows.every(r=>['deleted','rejected','withdrawn'].includes(r.status)));
  const tomb=(await pool.query('SELECT * FROM assets WHERE id=$1',[a1.id])).rows[0];assert.equal(tomb.state,'deleted');assert.equal(tomb.name,null);assert.equal(tomb.bounds,null);
  assert.equal((await call('DELETE',`/api/v1/admin/assets/${a1.id}`,undefined,admin.headers)).statusCode,404,'no restore/second delete');
  assert.ok(!(await call('GET','/api/v1/admin/assets',undefined,admin.headers)).json().data.items.some(a=>a.id===a1.id));
  // Cleanup job reclaims bytes only after the business transaction.
  assert.equal(await cleanupTick(pool,{delete:async()=>{throw new Error('fixture disk failure');}}),true);
  const delayed=(await pool.query("SELECT file_id FROM cleanup_jobs WHERE asset_id=$1 AND state='failed' AND run_at>now()",[a1.id])).rows[0];
  assert.ok(delayed);
  await store.openRead(delayed.file_id).then(stream=>stream.destroy());
  assert.equal((await call('GET',`/api/v1/files/${delayed.file_id}/content`,undefined,admin.headers)).statusCode,404);
  await pool.query("UPDATE cleanup_jobs SET run_at=now()-interval '1 second' WHERE asset_id=$1",[a1.id]);
  while(await cleanupTick(pool,store));await assert.rejects(store.openRead(a1.model));const jobs=(await pool.query('SELECT state FROM cleanup_jobs WHERE asset_id=$1',[a1.id])).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.state==='succeeded'));
  await store.openRead(a3.model).then(s=>s.destroy());
  // Furniture deletion touches every room that uses it.
  const bobRoom=(await call('GET','/api/v1/rooms/me',undefined,bob.headers)).json().data;assert.equal((await call('PUT','/api/v1/rooms/me/layout',{baseVersion:bobRoom.version,editSequence:1,name:'Bob',placements:[placement(furniture,'bf',[1,0,1]),placement(b1.id,'bb')]},bob.headers)).statusCode,200);
  const delF=await call('DELETE',`/api/v1/admin/assets/${furniture}`,undefined,admin.headers);assert.equal(delF.json().data.roomsUpdated,2);
  assert.deepEqual((await call('GET','/api/v1/rooms/me',undefined,bob.headers)).json().data.placements.map(p=>p.id),['bb']);
  // Concurrent save-adding vs delete: the confirmed layout never keeps the deleted model, and nothing deadlocks.
  for(let i=0;i<6;i++){
   const victim=await personal(alice.user.id);const cur=(await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data;
   const [s1,d1]=await Promise.all([call('PUT','/api/v1/rooms/me/layout',{baseVersion:cur.version,editSequence:20+i,name:'竞争',placements:[...cur.placements,placement(victim.id,'v'+i,[-2,0,-2])]},alice.headers),call('DELETE',`/api/v1/admin/assets/${victim.id}`,undefined,admin.headers)]);
   assert.equal(d1.statusCode,200,d1.body);assert.ok([200,409,422].includes(s1.statusCode),s1.body);
   const after=(await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data;assert.ok(!after.placements.some(p=>p.assetId===victim.id));
  }
  // Mixed review/withdraw/publish/delete on one asset complete without 500s or orphaned occupancy.
  for(let i=0;i<12;i++){
   const v=await personal(alice.user.id);const s=(await call('POST',`/api/v1/assets/${v.id}/submissions`,publicFields(),alice.headers)).json().data;const ver=(await call('GET','/api/v1/admin/gallery',undefined,admin.headers)).json().data.version;
   const rs=await Promise.all([call('POST',`/api/v1/admin/submissions/${s.id}/review`,{decision:'approve'},admin.headers),call('POST',`/api/v1/submissions/${s.id}/withdraw`,undefined,alice.headers),call('DELETE',`/api/v1/admin/assets/${v.id}`,undefined,admin.headers),call('PUT','/api/v1/admin/gallery',{baseVersion:ver,slots:arrange({12:c3.id})},admin.headers)]);
   assert.ok(rs.every(r=>r.statusCode<500),rs.map(r=>r.body).join('\n'));
   assert.equal((await pool.query('SELECT count(*)::int n FROM active_publications WHERE asset_id=$1',[v.id])).rows[0].n,0);assert.equal((await pool.query("SELECT state FROM assets WHERE id=$1",[v.id])).rows[0].state,'deleted');
  }
  // Review fixes. (1) Risk-deleted public text is redacted everywhere it was stored.
  assert.ok((await pool.query('SELECT public_snapshot FROM submissions WHERE asset_id=$1',[a1.id])).rows.every(r=>r.public_snapshot.redacted===true));
  assert.equal((await pool.query('SELECT count(*)::int n FROM gallery_versions WHERE details_json ? $1',[c1.id])).rows[0].n,0);
  assert.ok((await call('GET','/api/v1/admin/submissions?status=all',undefined,admin.headers)).json().data.items.filter(i=>i.assetId===a1.id).every(i=>i.publicSnapshot===null));
  // (2) Keyset cursors keep PostgreSQL microseconds: 55 rows inside one millisecond page without loss or repeats.
  const burst=[];for(let i=0;i<55;i++)burst.push((await personal(bob.user.id)).id);
  await pool.query("INSERT INTO submissions(id,asset_id,user_id,public_snapshot,submitted_at) SELECT gen_random_uuid(),x.id,$1,$2,timestamptz '2020-01-01 00:00:00.123+00'+(x.n||' microseconds')::interval FROM unnest($3::uuid[]) WITH ORDINALITY x(id,n)",[bob.user.id,{...publicFields(),sourceNickname:'b'},burst]);
  async function all(url,headers){const seen=[];let next=null;do{const r=(await call('GET',url+(next?(url.includes('?')?'&':'?')+'cursor='+encodeURIComponent(next):''),undefined,headers)).json().data;seen.push(...r.items.map(i=>i.assetId));next=r.nextCursor;}while(next);return seen;}
  for(const seen of [await all('/api/v1/submissions',bob.headers),(await all('/api/v1/admin/submissions',admin.headers)).filter(id=>burst.includes(id))]){assert.equal(seen.length,new Set(seen).size,'no repeated rows');assert.deepEqual([...new Set(seen)].filter(id=>burst.includes(id)).sort(),[...burst].sort(),'no skipped rows');}
  // (3) Candidate ids are canonicalised: case variants are one candidate, and an upper-case id still resolves.
  const gv=(await call('GET','/api/v1/admin/gallery',undefined,admin.headers)).json().data.version;
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:gv,slots:arrange({7:c3.id.toUpperCase(),8:c3.id})},admin.headers)).statusCode,422);
  assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:gv,slots:arrange({7:c3.id.toUpperCase()})},admin.headers)).statusCode,200);
  assert.equal((await call('GET','/api/v1/gallery')).json().data.slots[6].exhibit.candidateId,c3.id);
  assert.equal((await pool.query("SELECT count(*)::int n FROM exhibit_slots e JOIN candidates c ON c.id=e.candidate_id JOIN assets a ON a.id=c.asset_id WHERE a.state<>'ready'")).rows[0].n,0);
  // ---- T18 owner deletes their own generated asset: same cascade as the administrator delete ----
  {
   const own=await personal(alice.user.id);
   const s=(await call('POST',`/api/v1/assets/${own.id}/submissions`,publicFields({name:'自删瓷碗'}),alice.headers)).json().data;
   assert.equal((await call('POST',`/api/v1/admin/submissions/${s.id}/review`,{decision:'approve'},admin.headers)).statusCode,200);
   const cand=(await call('GET','/api/v1/admin/candidates',undefined,admin.headers)).json().data.items.find(c=>c.assetId===own.id);
   const gv=(await call('GET','/api/v1/admin/gallery',undefined,admin.headers)).json().data.version;
   assert.equal((await call('PUT','/api/v1/admin/gallery',{baseVersion:gv,slots:arrange({7:c3.id,9:cand.id})},admin.headers)).statusCode,200);
   const gl=(await call('GET','/api/v1/gallery')).json().data,glh={authorization:'Bearer '+gl.grant.token,'x-snapshot-grant':gl.grant.id};
   assert.equal(gl.slots[8].exhibit.candidateId,cand.id);
   assert.equal((await call('POST',collectionPath(cand.id),undefined,{...bob.headers,...glh})).json().data.status,'collected');
   for(const [actor,id] of [[alice,'mine'],[bob,'theirs']]){const r=(await call('GET','/api/v1/rooms/me',undefined,actor.headers)).json().data;
    assert.equal((await call('PUT','/api/v1/rooms/me/layout',{baseVersion:r.version,editSequence:90,name:r.name,placements:[...r.placements,placement(own.id,id,[3,0,3])]},actor.headers)).statusCode,200);}
   const aliceBefore=(await call('GET','/api/v1/rooms/me',undefined,alice.headers)).json().data;
   // Only the owner can delete it through the personal route (others, even the administrator, get 404).
   for(const actor of [bob,admin])assert.equal((await call('DELETE',`/api/v1/assets/${own.id}`,undefined,actor.headers)).statusCode,404);
   assert.equal((await call('DELETE',`/api/v1/assets/${own.id}`,undefined,{cookie:alice.headers.cookie})).statusCode,403,'needs the CSRF token');
   const key=randomUUID(),del=await call('DELETE',`/api/v1/assets/${own.id}`,undefined,{...alice.headers,'idempotency-key':key});assert.equal(del.statusCode,200,del.body);
   const d=del.json().data;
   assert.deepEqual({...d,galleryVersion:undefined},{deleted:true,roomsUpdated:2,placementsRemoved:2,submissionsClosed:1,candidateRemoved:true,slotNo:9,galleryVersion:undefined,
    ownRoom:{previousVersion:aliceBefore.version,roomVersion:aliceBefore.version+1,placementsRemoved:1}});
   assert.deepEqual((await call('DELETE',`/api/v1/assets/${own.id}`,undefined,{...alice.headers,'idempotency-key':key})).json().data,d,'same key replays the receipt');
   assert.equal((await call('DELETE',`/api/v1/assets/${own.id}`,undefined,alice.headers)).statusCode,404,'second delete');
   assert.equal((await call('GET',`/api/v1/assets/${own.id}`,undefined,alice.headers)).statusCode,404);
   assert.ok(!(await call('GET','/api/v1/assets',undefined,alice.headers)).json().data.items.some(a=>a.id===own.id));
   const task=(await call('GET','/api/v1/generation-tasks',undefined,alice.headers)).json().data.items.find(t=>t.assetDeleted);
   assert.ok(task&&task.assetId===null,'the generation task no longer links to the deleted asset');
   assert.equal((await collectionList(bob)).some(item=>item.id===own.id),false);
   for(const actor of [alice,bob])assert.ok(!(await call('GET','/api/v1/rooms/me',undefined,actor.headers)).json().data.placements.some(p=>p.assetId===own.id));
   const after=(await call('GET','/api/v1/gallery')).json().data;assert.equal(after.version,d.galleryVersion);assert.equal(after.slots[8].exhibit,null);assert.ok(after.slots[6].exhibit);
   assert.equal((await pool.query('SELECT count(*)::int n FROM candidates WHERE asset_id=$1',[own.id])).rows[0].n,0);
   assert.equal((await call('GET',`/api/v1/files/${own.model}/content`,undefined,glh)).statusCode,404,'an open gallery grant cannot fetch it');
   for(const f of [own.model,own.original])assert.equal((await call('GET',`/api/v1/files/${f}/content`,undefined,alice.headers)).statusCode,404);
   assert.ok(!(await call('GET','/api/v1/admin/assets',undefined,admin.headers)).json().data.items.some(a=>a.id===own.id));
  }
 }finally{await app?.close();await pool.end();await bootstrap.query(`DROP DATABASE ${db} WITH (FORCE)`);await bootstrap.end();await fs.rm(root,{recursive:true,force:true});}
});
