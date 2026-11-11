import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {loadConfig,createPool,LocalFileStore,GenerationWorker,generationRequestHash,GENERATION_PARAMS,sha256,ModelRejection,IMPORT_VALIDATOR_ATTEMPTS} from '@aholo/domain';
import {migrate} from '../scripts/migrate.mjs';

// The byte fixture and injected validator exercise transactional lifecycle only.
// These are NOT real-GLB rendering evidence; resource/render validation is tested separately.
const model=Buffer.from('T06 deterministic worker fixture bytes');
const verified=bytes=>({sha256:sha256(bytes),byteSize:bytes.length,triangles:12,rendered:true,normalization:{scale:1,translation:[0,0,0]},bounds:{min:[-.5,0,-.5],max:[.5,1,.5]}});
const clock=Date.parse('2026-11-05T03:00:00Z');
const waitPoint=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('T06 worker: durable delivery, quota/refund, unknown dispatch, nonce evidence, fenced recovery and imports',async()=>{
 const base=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
 const admin=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await admin.connect();
 const db='aholo_t06_worker_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${db} OWNER aholo_app`);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t06-worker-'));const u=new URL(base.databaseUrl);u.pathname='/'+db;const pool=createPool(u.href);const store=new LocalFileStore(root);await store.initialize();
 const config={...base,databaseUrl:u.href,dataDir:root,appDataKey:randomBytes(32).toString('hex'),generationEnabled:true,lux3dConfigured:true};
 const image=await fs.readFile('tests/fixtures/lux3d-vase.png');let creates=0,uploads=0,queries=0;
 let providerStatus=3;
 const provider={
  uploadFile:async()=>{uploads++;return {url:'https://fixture.aholo3d.cn/input.png'};},
  quoteImageTask:async()=>({quoteId:'fixture-quote',credits:1,expiresAt:new Date(Date.now()+3600000).toISOString()}),
  createImageTask:async()=>{creates++;return '9007199254740993';},
  getTask:async id=>{queries++;return {taskId:id,status:providerStatus,outputs:[{content:'https://fixture.aholo3d.cn/model.glb'}]};},
  parseMeshOutputs:()=>[{url:'https://fixture.aholo3d.cn/model.glb',format:'glb'}],
 };
 const worker=(options={})=>new GenerationWorker(pool,store,config,{provider,download:async()=>model,validate:async bytes=>verified(bytes),now:()=>clock,...options});
 async function file(owner,bytes=image,purpose='input_image'){
  const id=randomUUID(),hash=sha256(bytes),staged=await store.putStaged(bytes);await store.commit(staged,id,hash);
  await pool.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'committed')",[id,owner,purpose,hash,bytes.length,purpose==='model'?'model/gltf-binary':'image/png']);return id;
 }
 async function fixture({dispatch='prepared',status='accepted',providerId=null,created='2026-11-05T02:59:00Z',day='2026-11-05'}={}){
  const user=randomUUID();await pool.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash) VALUES($1,$2,$2,'Fixture','not-a-login')",[user,'u_'+user.replaceAll('-','').slice(0,24)]);
  const input=await file(user),task=randomUUID(),attempt=randomUUID(),job=randomUUID();
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO quota_days(user_id,quota_day,used_net) VALUES($1,$2,1)',[user,day]);await client.query("INSERT INTO generation_tasks(id,user_id,input_file_id,status,submitted_day,attempt_id,policy_version,created_at) VALUES($1,$2,$3,$4,$5,$6,'t06-v1',$7)",[task,user,input,status,day,attempt,created]);await client.query('INSERT INTO provider_attempts(id,task_id,request_hash,input_sha256,request_params,dispatch_state,provider_task_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[attempt,task,generationRequestHash(sha256(image)),sha256(image),JSON.stringify({inputSha256:sha256(image),policyVersion:'t06-v1',...GENERATION_PARAMS}),dispatch,providerId]);await client.query("INSERT INTO quota_events(task_id,user_id,kind,quota_day,delta) VALUES($1,$2,'reserve',$3,1)",[task,user,day]);await client.query("INSERT INTO jobs(id,kind,ref_id,run_at) VALUES($1,'generation',$2,now()-interval '1 second')",[job,task]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}return {user,input,task,attempt,job};
 }
 const row=async(table,id)=>(await pool.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
 async function due(job){await pool.query("UPDATE jobs SET state='queued',run_at=now()-interval '1 second',lease_until=NULL WHERE id=$1",[job]);}
 async function park(job){await pool.query("UPDATE jobs SET run_at=now()+interval '1 day' WHERE id=$1",[job]);}
 try{
  await migrate(pool);
  const success=await fixture();assert.equal(await worker().tick(),true);let task=await row('generation_tasks',success.task);assert.equal(task.status,'succeeded');assert.equal(creates,1);assert.equal(uploads,1);assert.equal((await row('provider_attempts',success.attempt)).provider_task_id,'9007199254740993');assert.equal((await row('provider_attempts',success.attempt)).quote_id,'fixture-quote');assert.equal((await row('provider_attempts',success.attempt)).committed_credits,1);
  const asset=await row('assets',task.result_asset_id);assert.equal(asset.name,'资产01');assert.equal(asset.original_image_id,success.input);assert.equal((await row('files',asset.model_file_id)).state,'committed');assert.equal((await pool.query('SELECT used_net FROM quota_days WHERE user_id=$1',[success.user])).rows[0].used_net,1);
  await due(success.job);await worker().tick();assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE generation_task_id=$1',[success.task])).rows[0].n,1);assert.equal(creates,1);assert.equal((await pool.query('SELECT count(*)::int n FROM quota_events WHERE task_id=$1',[success.task])).rows[0].n,1);

  providerStatus=4;const failed=await fixture({dispatch:'acknowledged',status:'provider_running',providerId:'20000001',created:'2026-11-04T15:59:00Z',day:'2026-11-04'});await pool.query("INSERT INTO quota_days(user_id,quota_day,used_net) VALUES($1,'2026-11-05',0)",[failed.user]);await worker().tick();assert.equal((await row('generation_tasks',failed.task)).status,'failed');assert.equal((await row('generation_tasks',failed.task)).error_code,'PROVIDER_FAILED');
  assert.equal((await pool.query("SELECT used_net FROM quota_days WHERE user_id=$1 AND quota_day='2026-11-04'",[failed.user])).rows[0].used_net,0);assert.equal((await pool.query("SELECT used_net FROM quota_days WHERE user_id=$1 AND quota_day='2026-11-05'",[failed.user])).rows[0].used_net,0);
  await due(failed.job);await worker().tick();assert.equal((await pool.query("SELECT count(*)::int n FROM quota_events WHERE task_id=$1 AND kind='refund'",[failed.task])).rows[0].n,1);

  providerStatus=3;
  const unrenderable=await fixture({dispatch:'acknowledged',status:'provider_running',providerId:'20000005'});
  await pool.query('UPDATE quota_days SET override_total=5,used_net=2 WHERE user_id=$1',[unrenderable.user]);
  await worker({validate:async()=>{throw new Error('fixture render failure');}}).tick(unrenderable.task);
  assert.equal((await row('provider_attempts',unrenderable.attempt)).provider_state,'3');
  assert.equal((await row('generation_tasks',unrenderable.task)).status,'provider_running');
  await due(unrenderable.job);
  await worker({now:()=>clock+120000,deliveryWindowMs:60000}).tick(unrenderable.task);
  assert.equal((await row('generation_tasks',unrenderable.task)).status,'failed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE generation_task_id=$1',[unrenderable.task])).rows[0].n,0);
  await due(unrenderable.job);await worker().tick(unrenderable.task);
  assert.equal((await pool.query("SELECT count(*)::int n FROM quota_events WHERE task_id=$1 AND kind='refund'",[unrenderable.task])).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT override_total,used_net,override_total-used_net AS available FROM quota_days WHERE user_id=$1',[unrenderable.user])).rows[0],{override_total:5,used_net:1,available:4});

  providerStatus=3;const unknown=await fixture({dispatch:'dispatch_started',status:'dispatching'});const createBefore=creates;await worker().tick();assert.equal(creates,createBefore);assert.equal((await row('generation_tasks',unknown.task)).status,'submission_unknown');assert.equal((await row('provider_attempts',unknown.attempt)).dispatch_state,'submission_unknown');await park(unknown.job);
  const attempt=await row('provider_attempts',unknown.attempt);await assert.rejects(()=>pool.query('INSERT INTO provider_evidence(attempt_id,dispatch_nonce,provider_task_id,evidence_hash) VALUES($1,$2,$3,$4)',[unknown.attempt,randomUUID(),'20000002',sha256('wrong nonce')]),e=>e.code==='23503');
  await pool.query('INSERT INTO provider_evidence(attempt_id,dispatch_nonce,provider_task_id,evidence_hash) VALUES($1,$2,$3,$4)',[unknown.attempt,attempt.dispatch_nonce,'9007199254740995',sha256('exact invocation evidence')]);await due(unknown.job);await worker().tick();assert.equal((await row('generation_tasks',unknown.task)).status,'succeeded');assert.equal((await row('provider_attempts',unknown.attempt)).provider_task_id,'9007199254740995');assert.equal(creates,createBefore);

  const stale=await fixture({dispatch:'acknowledged',status:'provider_running',providerId:'20000003'});const waiting=waitPoint(),resume=waitPoint();const oldWorker=worker({validate:async bytes=>{waiting.resolve();await resume.promise;return verified(bytes);}});const oldTick=oldWorker.tick();await waiting.promise;const oldFence=(await row('jobs',stale.job)).fence;
  await pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[stale.job]);
  const newWaiting=waitPoint(),newResume=waitPoint();const newWorker=worker({validate:async bytes=>{newWaiting.resolve();await newResume.promise;return verified(bytes);}});const newTick=newWorker.tick();await newWaiting.promise;
  assert.ok(BigInt((await row('jobs',stale.job)).fence)>BigInt(oldFence));resume.resolve();await oldTick;
  assert.notEqual((await row('generation_tasks',stale.task)).status,'succeeded');assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE generation_task_id=$1',[stale.task])).rows[0].n,0);
  newResume.resolve();await newTick;assert.equal((await row('generation_tasks',stale.task)).status,'succeeded');assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE generation_task_id=$1',[stale.task])).rows[0].n,1);

  const timed=await fixture({dispatch:'submission_unknown',status:'submission_unknown',created:'2026-11-03T00:00:00Z',day:'2026-11-03'});await worker().tick();assert.equal((await row('generation_tasks',timed.task)).error_code,'DELIVERY_DEADLINE');assert.equal((await row('provider_attempts',timed.attempt)).dispatch_state,'submission_unknown');assert.equal(creates,createBefore);await due(timed.job);await worker().tick();assert.equal((await pool.query("SELECT count(*)::int n FROM quota_events WHERE task_id=$1 AND kind='refund'",[timed.task])).rows[0].n,1);
  // Even a late exact ID after a committed failure cannot resurrect the local task.
  const timedAttempt=await row('provider_attempts',timed.attempt);await pool.query('INSERT INTO provider_evidence(attempt_id,dispatch_nonce,provider_task_id,evidence_hash) VALUES($1,$2,$3,$4)',[timed.attempt,timedAttempt.dispatch_nonce,'20000004',sha256('late after failure')]);await due(timed.job);await worker().tick();assert.equal((await row('generation_tasks',timed.task)).status,'failed');assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE generation_task_id=$1',[timed.task])).rows[0].n,0);

  const adminId=randomUUID();await pool.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) VALUES($1,'import_admin','import_admin','Admin','fixture','admin')",[adminId]);
  async function importFixture(source,bytes=model){const input=await file(adminId,bytes,'model'),id=randomUUID(),job=randomUUID();const meta={name:source==='furniture'?'桌子':'官方器物',description:'测试导入',era:'不详',material:'不详',ownershipType:'museum',holderName:'测试馆',location:'测试位置',sourceNickname:'官方馆藏'};await pool.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,$4,$5,'t06-v1')",[id,adminId,input,source,meta]);await pool.query("INSERT INTO jobs(id,kind,ref_id,run_at) VALUES($1,'import',$2,now()-interval '1 second')",[job,id]);return {id,job,input};}
  for(const source of ['furniture','official_candidate']){const imported=await importFixture(source);await worker().tick();const i=await row('asset_imports',imported.id);assert.equal(i.state,'succeeded');assert.equal((await row('assets',i.result_asset_id)).source_type,source);assert.equal(i.validation_receipt.rendered,true);await due(imported.job);await worker().tick();assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE import_id=$1',[imported.id])).rows[0].n,1);if(source==='official_candidate'){assert.equal((await pool.query('SELECT count(*)::int n FROM candidates WHERE asset_id=$1',[i.result_asset_id])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM active_publications WHERE asset_id=$1',[i.result_asset_id])).rows[0].n,1);}}
  const invalid=await importFixture('furniture',Buffer.from('bad'));await worker({validate:async()=>{throw new ModelRejection('MODEL_TRIANGLE_LIMIT','三角面 360,000 个，超过上限 350,000 个，请减面后再上传',{actual:360000,limit:350000});}}).tick(invalid.id);{const i=await row('asset_imports',invalid.id);assert.equal(i.state,'failed');assert.equal(i.error_code,'MODEL_INVALID');assert.deepEqual(i.error_detail,{reason:'MODEL_TRIANGLE_LIMIT',message:'三角面 360,000 个，超过上限 350,000 个，请减面后再上传',actual:360000,limit:350000});}
  // T20: a validator environment fault (Chrome/storage) is not blamed on the model: it retries, then closes as VALIDATOR_ERROR.
  const flaky=await importFixture('furniture',Buffer.from('flaky'));const broken=worker({validate:async()=>{throw new Error('chrome unavailable');}});
  for(let n=1;n<IMPORT_VALIDATOR_ATTEMPTS;n++){await broken.tick(flaky.id);assert.equal((await row('asset_imports',flaky.id)).state,'accepted');assert.equal((await row('jobs',flaky.job)).state,'queued');await due(flaky.job);}
  await broken.tick(flaky.id);{const i=await row('asset_imports',flaky.id);assert.equal(i.state,'failed');assert.equal(i.error_code,'VALIDATOR_ERROR');assert.equal(i.error_detail.reason,'VALIDATOR_ERROR');assert.match(i.error_detail.message,/不是模型本身的问题/);}
  // A render timeout may be a busy machine: it retries like an environment fault, and only then blames the model.
  const slow=await importFixture('furniture',Buffer.from('slow'));const timing=worker({validate:async()=>{const e=new ModelRejection('MODEL_RENDER_TIMEOUT','超时');e.retryable=true;throw e;}});
  for(let n=1;n<IMPORT_VALIDATOR_ATTEMPTS;n++){await timing.tick(slow.id);assert.equal((await row('asset_imports',slow.id)).state,'accepted');await due(slow.job);}
  await timing.tick(slow.id);{const i=await row('asset_imports',slow.id);assert.equal(i.state,'failed');assert.equal(i.error_code,'MODEL_INVALID');assert.equal(i.error_detail.reason,'MODEL_RENDER_TIMEOUT');}
  assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE import_id=$1',[invalid.id])).rows[0].n,0);assert.equal((await row('jobs',invalid.job)).state,'failed');
  const corrupt=await importFixture('furniture');await store.delete(corrupt.input);const tampered=Buffer.from('different decodable model fixture');const temp=await store.putStaged(tampered);await store.commit(temp,corrupt.input,sha256(tampered));await worker().tick();assert.equal((await row('asset_imports',corrupt.id)).state,'failed');assert.equal((await row('asset_imports',corrupt.id)).error_detail.reason,'IMPORT_CHECKSUM');assert.equal((await pool.query('SELECT count(*)::int n FROM assets WHERE import_id=$1',[corrupt.id])).rows[0].n,0);
  assert.ok(queries>=4);
 }finally{await pool.end();await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);await admin.end();await fs.rm(root,{recursive:true,force:true});}
});
