// Idempotent application-owned official items (T17: 官方物品; the DB source type stays 'furniture').
// This source account cannot log in: it has no password hash in any accepted credential format.
// Items no longer in assets/furniture/manifest.json are risk-deleted, which also removes their
// placements from every room (same path as the admin delete; needs `npm run build -w @aholo/api`).
import fs from 'node:fs/promises';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {loadConfig,createPool,LocalFileStore,transaction,GenerationWorker,sha256} from '@aholo/domain';
const fixedId=name=>{const h=createHash('sha256').update('aholo:builtin-furniture:v1:'+name).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export async function seedFurniture(config=loadConfig()){
 const manifest=JSON.parse(await fs.readFile(new URL('../assets/furniture/manifest.json',import.meta.url),'utf8'));
 const pool=createPool(config.databaseUrl),store=new LocalFileStore(config.dataDir);await store.initialize();
 const systemId=fixedId('system'),ids=[];
 try{
  await transaction(pool,async c=>{
   await c.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) VALUES($1,'_system_furniture','_system_furniture','官方物品来源','system:no-login','admin') ON CONFLICT DO NOTHING",[systemId]);
   const system=(await c.query("SELECT id,role,password_hash FROM users WHERE username_key='_system_furniture'")).rows[0];
   if(system?.id!==systemId||system.role!=='admin'||system.password_hash!=='system:no-login')throw new Error('Furniture system identity conflict; existing account remains unchanged');
   await c.query("UPDATE users SET nickname='官方物品来源' WHERE id=$1 AND nickname<>'官方物品来源'",[systemId]);
   for(const item of manifest.items){
    const bytes=await fs.readFile(new URL('../assets/furniture/'+item.file,import.meta.url));if(sha256(bytes)!==item.sha256)throw new Error('Furniture source checksum mismatch');
    const fileId=fixedId(item.key+':file'),importId=fixedId(item.key+':import');ids.push(importId);
    const existing=(await c.query('SELECT sha256,state FROM files WHERE id=$1',[fileId])).rows[0];if(existing&&existing.sha256!==item.sha256)throw new Error('Existing furniture version differs; preserve source and choose a new version');
    if(!existing){await c.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,'model',$1::text,$3,$4,'model/gltf-binary','staged')",[fileId,systemId,item.sha256,bytes.length]);const staged=await store.putStaged(bytes);await store.commit(staged,fileId,item.sha256);await c.query("UPDATE files SET state='committed' WHERE id=$1",[fileId]);}
    else if(existing.state!=='committed')throw new Error('Furniture file no longer committed; do not restore implicitly');
    await c.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,'furniture',$4,'t06-v1') ON CONFLICT DO NOTHING",[importId,systemId,fileId,{name:item.name,description:item.description??''}]);
    await c.query("INSERT INTO jobs(kind,ref_id) VALUES('import',$1) ON CONFLICT DO NOTHING",[importId]);
   }
  });
  const worker=new GenerationWorker(pool,store,config);
  for(const id of ids)await worker.tick(id);
  for(const item of manifest.items)await pool.query('UPDATE assets SET walk_through=$2 WHERE import_id=$1 AND walk_through<>$2',[fixedId(item.key+':import'),Boolean(item.walkThrough)]);
  await retireUnlisted(pool,systemId,ids);
  return (await pool.query('SELECT i.id,i.state,i.result_asset_id,a.name,a.walk_through FROM asset_imports i LEFT JOIN assets a ON a.id=i.result_asset_id WHERE i.id=ANY($1::uuid[]) ORDER BY a.name',[ids])).rows;
 }finally{await pool.end();}
}
/** Official items this script imported earlier but the manifest no longer lists. */
async function retireUnlisted(pool,systemId,keep){
 const stale=(await pool.query("SELECT a.id FROM assets a JOIN asset_imports i ON i.id=a.import_id WHERE i.admin_id=$1 AND a.source_type='furniture' AND a.state='ready' AND NOT (i.id=ANY($2::uuid[])) ORDER BY a.id",[systemId,keep])).rows;
 if(!stale.length)return [];
 const {riskDelete}=await import('../apps/api/dist/curation.js');
 const results=[];
 for(const {id} of stale)results.push(await transaction(pool,async c=>{
  // Same lock order as the admin delete: the acting admin's user row, then the asset, then rooms.
  await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[systemId]);
  const asset=(await c.query("SELECT state FROM assets WHERE id=$1 FOR UPDATE",[id])).rows[0];
  if(asset?.state!=='ready')return {id,skipped:true};
  return {id,...(await riskDelete(c,id)).data};
 }));
 console.error('Retired official items: '+JSON.stringify(results));
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await seedFurniture(),null,2));
