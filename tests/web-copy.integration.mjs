import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {loadConfig,createPool,LocalFileStore,GenerationWorker,enqueueWebCopies,sha256,WEB_COPY_ATTEMPTS} from '@aholo/domain';
import {migrate} from '../scripts/migrate.mjs';

// The worker builds one web copy per ready model, records it, skips deleted models and gives up on broken ones.
test('web copies: queued for every ready model, built once, never for a deleted model',async()=>{
 const base=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
 const admin=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await admin.connect();
 const db='aholo_webcopy_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${db} OWNER aholo_app`);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-webcopy-'));const u=new URL(base.databaseUrl);u.pathname='/'+db;const pool=createPool(u.href);const store=new LocalFileStore(root);await store.initialize();
 const worker=new GenerationWorker(pool,store,{...base,databaseUrl:u.href,dataDir:root,appDataKey:randomBytes(32).toString('hex'),generationEnabled:false,lux3dConfigured:false});
 const glb=await fs.readFile('assets/furniture/garden-bed.glb');
 const user=randomUUID();
 async function asset(bytes){
  const fileId=randomUUID(),importId=randomUUID(),id=randomUUID();await store.commit(await store.putStaged(bytes),fileId,sha256(bytes));
  await pool.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,'model',$1::text,$3,$4,'model/gltf-binary','committed')",[fileId,user,sha256(bytes),bytes.length]);
  await pool.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,'furniture','{}','t06-v1')",[importId,user,fileId]);
  await pool.query("INSERT INTO assets(id,source_type,import_id,model_file_id,name,normalization,bounds) VALUES($1,'furniture',$2,$3,'花坛','{\"scale\":1,\"translation\":[0,0,0]}','{\"min\":[0,0,0],\"max\":[1,1,1]}')",[id,importId,fileId]);
  return {id,fileId};
 }
 const job=fileId=>pool.query("SELECT * FROM jobs WHERE kind='web_copy' AND ref_id=$1",[fileId]).then(r=>r.rows[0]);
 try{
  await migrate(pool);
  await pool.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash) VALUES($1,'webcopy_fixture','webcopy_fixture','Fixture','not-a-login')",[user]);
  const good=await asset(glb),gone=await asset(glb.subarray(0)),broken=await asset(Buffer.from('not a glb'));
  await pool.query("UPDATE files SET state='deleted' WHERE id=$1",[gone.fileId]);
  assert.equal(await enqueueWebCopies(pool),2,'one job per committed model of a ready asset');
  assert.equal(await enqueueWebCopies(pool),0,'idempotent');
  await pool.query("UPDATE files SET state='committed' WHERE id=$1",[gone.fileId]);assert.equal(await enqueueWebCopies(pool),1);
  // The model is deleted after its job was queued (as riskDelete does): the job ends without a copy.
  await pool.query("UPDATE files SET state='deleted' WHERE id=$1",[gone.fileId]);

  assert.equal(await worker.tick(good.fileId),true);
  const copy=(await pool.query('SELECT w.*,f.* FROM model_web_copies w JOIN files f ON f.id=w.file_id WHERE w.model_file_id=$1',[good.fileId])).rows[0];
  assert.ok(copy,'copy recorded');assert.equal(copy.purpose,'derived');assert.equal(copy.state,'committed');assert.equal(copy.policy,'web-v1');assert.equal(copy.owner_id,user);
  const chunks=[];for await(const c of await store.openRead(copy.object_key))chunks.push(c);const bytes=Buffer.concat(chunks);
  assert.equal(sha256(bytes),copy.sha256);assert.ok(bytes.length<glb.length*.9,'smaller than the original');
  const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  assert.ok(json.extensionsRequired.includes('EXT_meshopt_compression'));
  assert.equal((await job(good.fileId)).state,'succeeded');
  assert.equal(await enqueueWebCopies(pool),0,'a model with a copy is not queued again');

  assert.equal(await worker.tick(gone.fileId),true);
  assert.equal((await job(gone.fileId)).state,'succeeded');
  assert.equal((await pool.query('SELECT count(*)::int n FROM model_web_copies WHERE model_file_id=$1',[gone.fileId])).rows[0].n,0,'a deleted model gets no copy');

  for(let attempt=1;attempt<=WEB_COPY_ATTEMPTS;attempt++){
   await pool.query("UPDATE jobs SET run_at=now()-interval '1 second' WHERE kind='web_copy' AND ref_id=$1",[broken.fileId]);
   assert.equal(await worker.tick(broken.fileId),true);
   assert.equal((await job(broken.fileId)).state,attempt<WEB_COPY_ATTEMPTS?'queued':'failed');
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM files').then(r=>r.rows[0].n)),4,'only the three models and the one copy');
  // A model that killed the worker mid-build (no catch ran) is given up once its claims pass the cap.
  const crashed=await asset(Buffer.concat([glb,Buffer.alloc(0)]));assert.equal(await enqueueWebCopies(pool),1);
  await pool.query("UPDATE jobs SET state='running',attempts=$2,lease_until=now()-interval '1 second' WHERE kind='web_copy' AND ref_id=$1",[crashed.fileId,WEB_COPY_ATTEMPTS]);
  assert.equal(await worker.tick(crashed.fileId),true);assert.equal((await job(crashed.fileId)).state,'failed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM model_web_copies WHERE model_file_id=$1',[crashed.fileId])).rows[0].n,0);
 }finally{await pool.end();await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);await admin.end();await fs.rm(root,{recursive:true,force:true});}
});
