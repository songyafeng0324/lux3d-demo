import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {loadConfig,createPool,LocalFileStore} from '@aholo/domain';
import {migrate} from '../scripts/migrate.mjs';
import {buildApp} from '../apps/api/dist/app.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const placement=(assetId,id='p1',position=[0,0,0])=>({id,assetId,position,rotation:[0,0,0],scale:1});

test('T07/T14 real PostgreSQL/API: CAS layouts, scoped shares, ranked discovery and unique likes',async()=>{
 const base=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
 const admin=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await admin.connect();const db='aholo_t07_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${db} OWNER aholo_app`);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t07-'));const u=new URL(base.databaseUrl);u.pathname='/'+db;const pool=createPool(u.href);let app;const store=new LocalFileStore(root);await store.initialize();
 try{
  await migrate(pool);app=await buildApp({...base,databaseUrl:u.href,dataDir:root,appDataKey:randomBytes(32).toString('hex'),generationEnabled:false});await app.ready();
  const call=(method,url,payload,headers={})=>app.inject({method,url,...(payload!==undefined?{payload}:{}),headers:{origin:base.publicOrigin,'idempotency-key':randomUUID(),...headers}});
  async function account(username){const password='t07-fixture-password-123';const r=await call('POST','/api/v1/auth/register',{username,nickname:username,password,confirmPassword:password});assert.equal(r.statusCode,201,r.body);const user=r.json().data.user;const login=await call('POST','/api/v1/auth/login',{username,password});assert.equal(login.statusCode,200,login.body);return {user,headers:{cookie:login.headers['set-cookie'].split(';')[0],'x-csrf-token':login.json().data.csrfToken}};}
  const owner=await account('room_owner'),other=await account('room_other');
  async function file(ownerId,purpose,bytes){const id=randomUUID(),hash=sha(bytes),staged=await store.putStaged(bytes);await store.commit(staged,id,hash);await pool.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'committed')",[id,ownerId,purpose,hash,bytes.length,purpose==='model'?'model/gltf-binary':'image/png']);return id;}
  // SQL fixtures isolate authorization/transactions from the separately tested
  // image/model ingestion pipeline. Byte strings below are not render evidence.
  async function asset(ownerId,source='personal'){
   const id=randomUUID(),modelBytes=Buffer.from('model-'+id),modelFile=await file(ownerId,'model',modelBytes),original=await file(ownerId,'input_image',Buffer.from('private-original-'+id));const task=randomUUID(),importId=randomUUID();const bounds={min:[-.5,0,-.5],max:[.5,1,.5]},normalization={scale:1,translation:[0,0,0]};const c=await pool.connect();try{await c.query('BEGIN');if(source==='personal')await c.query("INSERT INTO generation_tasks(id,user_id,input_file_id,submitted_day,policy_version) VALUES($1,$2,$3,'2026-11-05','t07-fixture')",[task,ownerId,original]);else await c.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,$4,'{}','t07-fixture')",[importId,ownerId,modelFile,source]);await c.query('INSERT INTO assets(id,owner_id,source_type,generation_task_id,import_id,model_file_id,original_image_id,name,description,normalization,bounds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,source==='personal'?ownerId:null,source,source==='personal'?task:null,source==='personal'?null:importId,modelFile,original,'私有名称-'+id,'私有简介',normalization,bounds]);if(source==='personal')await c.query("UPDATE generation_tasks SET status='succeeded',result_asset_id=$2 WHERE id=$1",[task,id]);else await c.query("UPDATE asset_imports SET state='succeeded',result_asset_id=$2 WHERE id=$1",[importId,id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}return {id,modelFile,original,modelBytes};
  }
  const a=await asset(owner.user.id),b=await asset(owner.user.id),foreign=await asset(other.user.id),furniture=await asset(owner.user.id,'furniture'),official=await asset(owner.user.id,'official_candidate');
  let me=await call('GET','/api/v1/rooms/me',undefined,owner.headers);assert.equal(me.statusCode,200,me.body);assert.equal(me.json().data.version,0);assert.deepEqual(me.json().data.placements,[]);assert.equal(me.json().data.shareUrl,null);const roomId=me.json().data.id;
  assert.equal((await call('GET','/api/v1/rooms/me')).statusCode,401);
  const body={baseVersion:0,editSequence:1,name:'听雨小屋',placements:[placement(a.id)]},key=randomUUID();const saves=await Promise.all([call('PUT','/api/v1/rooms/me/layout',body,{...owner.headers,'idempotency-key':key}),call('PUT','/api/v1/rooms/me/layout',body,{...owner.headers,'idempotency-key':key})]);for(const r of saves)assert.equal(r.statusCode,200,r.body);assert.deepEqual(saves[0].json().data,{savedVersion:1,editSequence:1});assert.deepEqual(saves[1].json().data,saves[0].json().data);assert.equal((await pool.query('SELECT count(*)::int n FROM room_versions WHERE room_id=$1',[roomId])).rows[0].n,2);
  const conflict=await call('PUT','/api/v1/rooms/me/layout',body,owner.headers);assert.equal(conflict.statusCode,409,conflict.body);assert.equal(conflict.json().error.currentVersion,1);
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',{...body,name:'换名'},{...owner.headers,'idempotency-key':key})).statusCode,409);
  for(const placements of [[placement(a.id,'out',[19.21,-.4,8.5])],[placement(foreign.id)],[placement(official.id)],[placement(a.id),placement(a.id)],[{...placement(a.id),scale:0}]]){const r=await call('PUT','/api/v1/rooms/me/layout',{...body,baseVersion:1,placements},owner.headers);assert.equal(r.statusCode,422,r.body);}
  assert.equal((await call('PUT','/api/v1/rooms/me/layout',{...body,baseVersion:1},{cookie:owner.headers.cookie})).statusCode,403);
  const many=Array.from({length:12000},(_,i)=>placement(a.id,'object'+i));assert.ok(Buffer.byteLength(JSON.stringify(many))>1024*1024);const large=await call('PUT','/api/v1/rooms/me/layout',{baseVersion:1,editSequence:2,name:'完整大布局',placements:many},owner.headers);assert.equal(large.statusCode,200,large.body);me=await call('GET','/api/v1/rooms/me',undefined,owner.headers);assert.equal(me.json().data.placements.length,12000);assert.equal(me.json().data.placements.at(-1).id,'object11999');assert.equal(me.json().data.version,2);
  const over=await call('PUT','/api/v1/rooms/me/layout',Buffer.alloc(64*1024*1024+1,32),{...owner.headers,'content-type':'application/json'});assert.equal(over.statusCode,413,over.body);assert.equal((await call('GET','/api/v1/rooms/me',undefined,owner.headers)).json().data.version,2);
  const outdoor = [10.5, -.4, 8.5];
  const beforeShare=await call('PUT','/api/v1/rooms/me/layout',{baseVersion:2,editSequence:3,name:'分享前布局',placements:[placement(a.id),placement(furniture.id,'f1',outdoor)]},owner.headers);assert.equal(beforeShare.statusCode,200,beforeShare.body);
  const shareKey=randomUUID();const enables=await Promise.all([call('PUT','/api/v1/rooms/me/share',{enabled:true},{...owner.headers,'idempotency-key':shareKey}),call('PUT','/api/v1/rooms/me/share',{enabled:true},{...owner.headers,'idempotency-key':shareKey})]);for(const r of enables)assert.equal(r.statusCode,200,r.body);assert.deepEqual(enables[0].json().data,enables[1].json().data);const shareUrl=enables[0].json().data.shareUrl,token=shareUrl.split('/').at(-1);assert.match(shareUrl,/\/shared\/[a-f0-9]{64}$/);
  const stored=(await pool.query('SELECT * FROM rooms WHERE id=$1',[roomId])).rows[0];assert.equal(stored.share_epoch,'1');assert.equal(stored.share_token_hash,sha(token));assert.ok(!stored.share_token_ciphertext.includes(token));assert.match(stored.share_token_ciphertext,/^v1\./);
  const receipts=(await pool.query('SELECT response::text FROM write_receipts')).rows;assert.ok(receipts.every(r=>!r.response.includes(token)));
  const entered=await call('GET','/api/v1/shared-rooms/'+token);assert.equal(entered.statusCode,200,entered.body);assert.equal(entered.headers['cache-control'],'private, no-store');const snapshot=entered.json().data;assert.equal(snapshot.version,3);assert.equal(snapshot.ownerNickname,'room_owner');assert.equal(snapshot.placements.length,2);assert.deepEqual(Object.keys(snapshot).sort(),['assets','grant','name','ownerNickname','placements','sceneVersion','version'].sort());assert.deepEqual(Object.keys(snapshot.assets[0]).sort(),['bounds','id','modelFileId','normalization','walkThrough'].sort());assert.ok(!entered.body.includes(a.original));assert.ok(!entered.body.includes('私有名称'));assert.ok(!entered.body.includes('私有简介'));assert.ok(!entered.body.includes(b.modelFile));
  const grantHeaders={authorization:'Bearer '+snapshot.grant.token,'x-snapshot-grant':snapshot.grant.id};const getFile=(id,h=grantHeaders)=>call('GET','/api/v1/files/'+id+'/content',undefined,h);
  const directoryUrl='/api/v1/rooms/discover';
  const likeUrl='/api/v1/snapshots/'+snapshot.grant.id+'/room-like';
  const likeHeaders={...grantHeaders,...other.headers};
  const ranking=async()=>{const r=await call('GET',directoryUrl,undefined,other.headers);assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'private, no-store');return r.json().data.items;};
  assert.equal((await call('GET',directoryUrl)).statusCode,401);
  assert.deepEqual(await ranking(),[{id:roomId,name:'分享前布局',ownerNickname:'room_owner',popularity:0,shareUrl:'/shared/'+token}]);
  const otherShare=(await call('PUT','/api/v1/rooms/me/share',{enabled:true},other.headers)).json().data.shareUrl;
  assert.deepEqual((await ranking()).map(item=>item.ownerNickname),['room_owner','room_other']);
  const otherRoom=(await call('GET','/api/v1/shared-rooms/'+otherShare.split('/').at(-1))).json().data;
  const otherLikeUrl='/api/v1/snapshots/'+otherRoom.grant.id+'/room-like';
  const otherGrantHeaders={authorization:'Bearer '+otherRoom.grant.token,'x-snapshot-grant':otherRoom.grant.id};
  const boosted=await call('PUT',otherLikeUrl,undefined,{...otherGrantHeaders,...owner.headers});
  assert.equal(boosted.statusCode,200,boosted.body);
  assert.deepEqual((await ranking()).map(item=>[item.ownerNickname,item.popularity]),[['room_other',1],['room_owner',0]]);
  assert.deepEqual((await call('GET',likeUrl,undefined,grantHeaders)).json().data,{popularity:0,state:'guest'});
  assert.deepEqual((await call('GET',likeUrl,undefined,likeHeaders)).json().data,{popularity:0,state:'available',csrfToken:other.headers['x-csrf-token']});
  assert.equal((await call('PUT',likeUrl,undefined,grantHeaders)).statusCode,401);
  assert.equal((await call('PUT',likeUrl,undefined,{...grantHeaders,cookie:other.headers.cookie})).statusCode,403);
  assert.equal((await call('PUT',likeUrl,undefined,{...otherGrantHeaders,...other.headers})).statusCode,403);
  assert.equal((await call('PUT',likeUrl,undefined,{...grantHeaders,...owner.headers})).json().error.code,'ROOM_SELF_LIKE');
  const likeKey=randomUUID();
  const likes=await Promise.all([
   call('PUT',likeUrl,undefined,{...likeHeaders,'idempotency-key':likeKey}),
   call('PUT',likeUrl,undefined,{...likeHeaders,'idempotency-key':likeKey}),
   call('PUT',likeUrl,undefined,likeHeaders),
  ]);
  for(const r of likes){assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().data,{popularity:1});}
  assert.deepEqual((await call('GET',likeUrl,undefined,likeHeaders)).json().data,{popularity:1,state:'liked'});
  assert.deepEqual((await ranking()).map(item=>[item.ownerNickname,item.popularity]),[['room_owner',1],['room_other',1]]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM room_likes WHERE room_id=$1',[roomId])).rows[0].n,1);
  assert.deepEqual(snapshot.placements[1].position, outdoor, 'courtyard placement survives server save and shared snapshot');
  const visible=await getFile(a.modelFile);assert.equal(visible.statusCode,200,visible.body);assert.equal(visible.headers['cache-control'],'private, no-cache');assert.deepEqual(visible.rawPayload,a.modelBytes);
  // Browser cache: the ETag is the bytes' SHA-256; a matching If-None-Match gets a bodiless 304 only while the grant still allows the file.
  const etag=visible.headers.etag;assert.equal(etag,`"${sha(a.modelBytes)}"`);
  for(const tag of [etag,'W/'+etag,'"other", '+etag]){const cached=await getFile(a.modelFile,{...grantHeaders,'if-none-match':tag});assert.equal(cached.statusCode,304,tag);assert.equal(cached.rawPayload.length,0);}
  assert.equal((await getFile(a.modelFile,{...grantHeaders,'if-none-match':'"other"'})).statusCode,200);
  assert.equal((await getFile(b.modelFile,{...grantHeaders,'if-none-match':`"${sha(b.modelBytes)}"`})).statusCode,404,'a cached tag never bypasses the grant scope');
  // ?variant=web serves the web copy once the worker built one, through the original's permission check; otherwise the original.
  const webOf=id=>call('GET','/api/v1/files/'+id+'/content?variant=web',undefined,grantHeaders);
  assert.deepEqual((await webOf(a.modelFile)).rawPayload,a.modelBytes,'no copy yet: the original');
  const copyBytes=Buffer.from('web-copy-'+a.id),copyFile=await file(owner.user.id,'derived',copyBytes);await pool.query("INSERT INTO model_web_copies(model_file_id,file_id,policy) VALUES($1,$2,'web-v1')",[a.modelFile,copyFile]);
  const web=await webOf(a.modelFile);assert.equal(web.statusCode,200);assert.deepEqual(web.rawPayload,copyBytes);assert.equal(web.headers.etag,`"${sha(copyBytes)}"`);
  assert.equal((await call('GET','/api/v1/files/'+copyFile+'/content',undefined,grantHeaders)).statusCode,404,'the copy has no access of its own');
  assert.equal((await call('GET','/api/v1/files/'+copyFile+'/content',undefined,owner.headers)).statusCode,404);
  assert.equal((await call('GET','/api/v1/files/'+a.modelFile+'/content?variant=raw',undefined,grantHeaders)).statusCode,404);
  assert.equal((await call('GET','/api/v1/files/'+b.modelFile+'/content?variant=web',undefined,grantHeaders)).statusCode,404);
  for(const id of [a.original,b.modelFile,foreign.modelFile])assert.equal((await getFile(id,{...grantHeaders,...owner.headers})).statusCode,404);
  assert.equal((await getFile(b.modelFile,{...grantHeaders,range:'bytes=0-2'})).statusCode,404);
  assert.equal((await getFile(a.modelFile,{'x-snapshot-grant':snapshot.grant.id,...owner.headers})).statusCode,403);
  assert.equal((await getFile(a.modelFile,{...grantHeaders,'x-snapshot-grant':randomUUID()})).statusCode,404);
  assert.equal((await call('GET','/api/v1/assets',undefined,grantHeaders)).statusCode,401);
  assert.equal((await call('PATCH','/api/v1/me',{nickname:'新主人昵称'},owner.headers)).statusCode,200);assert.equal((await call('GET','/api/v1/shared-rooms/'+token)).json().data.ownerNickname,'新主人昵称');
  const newer=await call('PUT','/api/v1/rooms/me/layout',{baseVersion:3,editSequence:4,name:'新布局',placements:[placement(b.id)]},owner.headers);assert.equal(newer.statusCode,200,newer.body);assert.equal((await getFile(a.modelFile)).statusCode,200);assert.equal((await getFile(b.modelFile)).statusCode,404);
  const newView=(await call('GET','/api/v1/shared-rooms/'+token)).json().data;assert.equal(newView.version,4);assert.equal(newView.placements[0].assetId,b.id);
  await pool.query("UPDATE snapshot_grants SET expires_at=now()+interval '2 minutes' WHERE id=$1",[snapshot.grant.id]);const renewKey=randomUUID(),renewUrl='/api/v1/snapshots/'+snapshot.grant.id+'/renew';const renewed=await Promise.all([call('POST',renewUrl,undefined,{...grantHeaders,'idempotency-key':renewKey}),call('POST',renewUrl,undefined,{...grantHeaders,'idempotency-key':renewKey})]);for(const r of renewed)assert.equal(r.statusCode,200,r.body);assert.deepEqual(renewed[0].json().data,renewed[1].json().data);assert.equal(renewed[0].json().data.grant.id,snapshot.grant.id);assert.equal(renewed[0].json().data.grant.token,snapshot.grant.token);assert.equal((await pool.query('SELECT version FROM snapshot_grants WHERE id=$1',[snapshot.grant.id])).rows[0].version,'3');assert.equal((await getFile(a.modelFile)).statusCode,200);
  assert.equal((await call('POST',renewUrl,undefined,{...grantHeaders,'idempotency-key':''})).statusCode,422);
  const still=await call('PUT','/api/v1/rooms/me/share',{enabled:true},owner.headers);assert.equal(still.json().data.shareUrl,shareUrl);assert.equal((await pool.query('SELECT share_epoch FROM rooms WHERE id=$1',[roomId])).rows[0].share_epoch,'1');assert.equal((await getFile(a.modelFile)).statusCode,200);
  const lateVoter=await account('late_voter');
  const [closed,racingLike]=await Promise.all([
   call('PUT','/api/v1/rooms/me/share',{enabled:false},owner.headers),
   call('PUT',likeUrl,undefined,{...grantHeaders,...lateVoter.headers}),
  ]);
  assert.equal(closed.statusCode,200,closed.body);assert.ok([200,404].includes(racingLike.statusCode),racingLike.body);
  const preservedPopularity=racingLike.statusCode===200?2:1;
  assert.equal((await call('PUT',likeUrl,undefined,{...likeHeaders,'idempotency-key':likeKey})).statusCode,404);
  assert.deepEqual((await ranking()).map(item=>item.ownerNickname),['room_other']);
  assert.equal((await getFile(a.modelFile)).statusCode,404);assert.equal((await call('POST',renewUrl,undefined,{...grantHeaders,'idempotency-key':renewKey})).statusCode,404);assert.equal((await call('GET','/api/v1/shared-rooms/'+token)).statusCode,404);
  assert.equal((await getFile(a.modelFile,{...grantHeaders,range:'bytes=0-2'})).statusCode,404);
  assert.equal((await getFile(a.modelFile,{...grantHeaders,'if-none-match':etag})).statusCode,404,'closing the share stops the cached copy too');
  assert.equal((await call('GET','/api/v1/files/'+a.modelFile+'/content?variant=web',undefined,{...grantHeaders,'if-none-match':`"${sha(copyBytes)}"`})).statusCode,404);
  me=await call('GET','/api/v1/rooms/me',undefined,owner.headers);assert.equal(me.json().data.shareEnabled,false);assert.equal(me.json().data.shareUrl,shareUrl);
  const reopened=await call('PUT','/api/v1/rooms/me/share',{enabled:true},owner.headers);assert.equal(reopened.json().data.shareUrl,shareUrl);assert.equal((await pool.query('SELECT share_epoch FROM rooms WHERE id=$1',[roomId])).rows[0].share_epoch,'3');assert.equal((await getFile(a.modelFile)).statusCode,404);assert.equal((await call('POST',renewUrl,undefined,grantHeaders)).statusCode,404);
  const fresh=(await call('GET','/api/v1/shared-rooms/'+token)).json().data;const freshHeaders={authorization:'Bearer '+fresh.grant.token,'x-snapshot-grant':fresh.grant.id};assert.equal((await getFile(b.modelFile,freshHeaders)).statusCode,200);
  assert.equal((await call('PUT',likeUrl,undefined,likeHeaders)).statusCode,404,'reopening does not revive an old grant');
  assert.deepEqual((await call('GET','/api/v1/snapshots/'+fresh.grant.id+'/room-like',undefined,{...freshHeaders,...other.headers})).json().data,{popularity:preservedPopularity,state:'liked'});
  assert.deepEqual((await ranking()).map(item=>[item.name,item.ownerNickname,item.popularity]),[['新布局','新主人昵称',preservedPopularity],['个人小屋','room_other',1]]);
  await pool.query("UPDATE snapshot_grants SET expires_at=now()-interval '1 second' WHERE id=$1",[fresh.grant.id]);assert.equal((await getFile(b.modelFile,freshHeaders)).statusCode,404);assert.equal((await call('POST','/api/v1/snapshots/'+fresh.grant.id+'/renew',undefined,freshHeaders)).statusCode,404);
  const deletedGrant=(await call('GET','/api/v1/shared-rooms/'+token)).json().data;const deletedHeaders={authorization:'Bearer '+deletedGrant.grant.token,'x-snapshot-grant':deletedGrant.grant.id};await pool.query("UPDATE assets SET state='deleted',deleted_at=now() WHERE id=$1",[b.id]);assert.equal((await getFile(b.modelFile,deletedHeaders)).statusCode,404);assert.equal((await call('POST','/api/v1/snapshots/'+deletedGrant.grant.id+'/renew',undefined,deletedHeaders)).statusCode,404);
  // Current readiness is checked even before replaying a previously successful save.
  const originalSaveReplay=await call('PUT','/api/v1/rooms/me/layout',body,{...owner.headers,'idempotency-key':key});assert.equal(originalSaveReplay.statusCode,200);await pool.query("UPDATE assets SET state='deleted',deleted_at=now() WHERE id=$1",[a.id]);assert.equal((await call('PUT','/api/v1/rooms/me/layout',body,{...owner.headers,'idempotency-key':key})).statusCode,409,'T08: a stale draft that references a removed model reports a version conflict so the editor reloads the confirmed layout');
  const distinctTabs=await Promise.all(['左页','右页'].map(name=>call('PUT','/api/v1/rooms/me/layout',{baseVersion:4,editSequence:5,name,placements:[placement(furniture.id)]},owner.headers)));assert.deepEqual(distinctTabs.map(r=>r.statusCode).sort(),[200,409]);assert.equal((await call('GET','/api/v1/rooms/me',undefined,owner.headers)).json().data.version,5);assert.equal((await pool.query('SELECT jsonb_array_length(placements_json) AS n FROM room_versions WHERE room_id=$1 AND version=3',[roomId])).rows[0].n,2);
  assert.ok((await pool.query('SELECT response::text FROM write_receipts')).rows.every(r=>!r.response.includes(token)&&!r.response.includes(snapshot.grant.token)));
 }finally{await app?.close();await pool.end();await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);await admin.end();await fs.rm(root,{recursive:true,force:true});}
});
