import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {loadConfig,createPool,verifyPassword} from '@aholo/domain';import {migrate} from '../scripts/migrate.mjs';import {seedFurniture} from '../scripts/seed-furniture.mjs';
test('official items use real rendered GLB imports, are idempotent, retire unlisted items and create no usable system login',async()=>{
 const config=loadConfig(),creds=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8')),admin=new pg.Client({host:'127.0.0.1',port:creds.port,user:'aholo_bootstrap',password:creds.adminPassword,database:'postgres'});await admin.connect();const db='aholo_furniture_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${db} OWNER aholo_app`);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-furniture-')),url=new URL(config.databaseUrl);url.pathname='/'+db;const local={...config,databaseUrl:url.href,dataDir:root},pool=createPool(url.href);
 try{await migrate(pool);const first=await seedFurniture(local);assert.equal(first.length,1);assert.ok(first.every(r=>r.state==='succeeded'));assert.equal(first[0].name,'花草丛');assert.equal(first[0].walk_through,true);const second=await seedFurniture(local);assert.deepEqual(second,first);assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM files')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM generation_tasks')).rows[0].n,0);
 const source=(await pool.query("SELECT * FROM users WHERE username_key='_system_furniture'")).rows[0];assert.equal(source.password_hash,'system:no-login');assert.equal(source.nickname,'官方物品来源');assert.equal(await verifyPassword('any-password-123456',source.password_hash),false);const receipts=(await pool.query('SELECT validation_receipt FROM asset_imports')).rows;assert.ok(receipts.every(r=>r.validation_receipt.rendered&&r.validation_receipt.sha256));
 // T17: an official item the manifest no longer lists is risk-deleted and leaves every room layout.
 const bed=(await pool.query('SELECT * FROM assets WHERE import_id=$1',[first[0].id])).rows[0];
 const oldImport=randomUUID(),oldAsset=randomUUID(),owner=randomUUID();
 await pool.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version,state,result_asset_id) VALUES($1,$2,$3,'furniture','{\"name\":\"明式长案\"}','t06-v1','accepted',NULL)",[oldImport,source.id,bed.model_file_id]);
 await pool.query("INSERT INTO assets(id,source_type,import_id,model_file_id,name,normalization,bounds) VALUES($1,'furniture',$2,$3,'明式长案',$4,$5)",[oldAsset,oldImport,bed.model_file_id,bed.normalization,bed.bounds]);
 await pool.query("UPDATE asset_imports SET state='succeeded',result_asset_id=$2 WHERE id=$1",[oldImport,oldAsset]);
 await pool.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash) VALUES($1,$2,$2,'布置者','x')",[owner,'owner_'+owner.slice(0,8)]);
 const placements=[{id:'old',assetId:oldAsset,position:[0,0,0],rotation:[0,0,0],scale:1},{id:'bed',assetId:bed.id,position:[8,-.4,8],rotation:[0,0,0],scale:1}];
 const room=(await pool.query("WITH created AS (INSERT INTO rooms(owner_id,name,scene_version) VALUES($1,'个人小屋','courtyard-v1') RETURNING id) INSERT INTO room_versions(room_id,version,name,scene_version,placements_json) SELECT id,0,'个人小屋','courtyard-v1',$2 FROM created RETURNING room_id",[owner,JSON.stringify(placements)])).rows[0].room_id;
 const third=await seedFurniture(local);assert.deepEqual(third,first);
 assert.equal((await pool.query('SELECT state FROM assets WHERE id=$1',[oldAsset])).rows[0].state,'deleted');
 assert.equal((await pool.query('SELECT state FROM assets WHERE id=$1',[bed.id])).rows[0].state,'ready');
 assert.equal((await pool.query('SELECT state FROM files WHERE id=$1',[bed.model_file_id])).rows[0].state,'committed','the shared file stays for the item still listed');
 const latest=(await pool.query('SELECT v.placements_json FROM rooms r JOIN room_versions v ON v.room_id=r.id AND v.version=r.layout_version WHERE r.id=$1',[room])).rows[0].placements_json;
 assert.deepEqual(latest.map(p=>p.id),['bed']);
 }finally{await pool.end();await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);await admin.end();await fs.rm(root,{recursive:true,force:true});}
});
