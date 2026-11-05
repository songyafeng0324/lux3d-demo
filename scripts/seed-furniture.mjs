// Idempotent application-owned furniture imports. This source account cannot log
// in: it has no password hash in any accepted credential format.
import fs from 'node:fs/promises';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {loadConfig,createPool,LocalFileStore,transaction,GenerationWorker,sha256} from '@aholo/domain';
const fixedId=name=>{const h=createHash('sha256').update('aholo:builtin-furniture:v1:'+name).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export async function seedFurniture(config=loadConfig()){
 const manifest=JSON.parse(await fs.readFile(new URL('../assets/furniture/manifest.json',import.meta.url),'utf8'));
 const pool=createPool(config.databaseUrl),store=new LocalFileStore(config.dataDir);await store.initialize();
 const systemId=fixedId('system'),ids=[];
 try{
  await transaction(pool,async c=>{
   await c.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) VALUES($1,'_system_furniture','_system_furniture','官方家具来源','system:no-login','admin') ON CONFLICT DO NOTHING",[systemId]);
   const system=(await c.query("SELECT id,role,password_hash FROM users WHERE username_key='_system_furniture'")).rows[0];
   if(system?.id!==systemId||system.role!=='admin'||system.password_hash!=='system:no-login')throw new Error('Furniture system identity conflict; existing account remains unchanged');
   for(const item of manifest.items){
    const bytes=await fs.readFile(new URL('../assets/furniture/'+item.file,import.meta.url));if(sha256(bytes)!==item.sha256)throw new Error('Furniture source checksum mismatch');
    const fileId=fixedId(item.key+':file'),importId=fixedId(item.key+':import');ids.push(importId);
    const existing=(await c.query('SELECT sha256,state FROM files WHERE id=$1',[fileId])).rows[0];if(existing&&existing.sha256!==item.sha256)throw new Error('Existing furniture version differs; preserve source and choose a new version');
    if(!existing){await c.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,'model',$1::text,$3,$4,'model/gltf-binary','staged')",[fileId,systemId,item.sha256,bytes.length]);const staged=await store.putStaged(bytes);await store.commit(staged,fileId,item.sha256);await c.query("UPDATE files SET state='committed' WHERE id=$1",[fileId]);}
    else if(existing.state!=='committed')throw new Error('Furniture file no longer committed; do not restore implicitly');
    await c.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,'furniture',$4,'t06-v1') ON CONFLICT DO NOTHING",[importId,systemId,fileId,{name:item.name,description:'本地制作的基础木质家具，可重复摆放与缩放。'}]);
    await c.query("INSERT INTO jobs(kind,ref_id) VALUES('import',$1) ON CONFLICT DO NOTHING",[importId]);
   }
  });
  const worker=new GenerationWorker(pool,store,config);
  for(const id of ids)await worker.tick(id);
  return (await pool.query('SELECT i.id,i.state,i.result_asset_id,a.name FROM asset_imports i LEFT JOIN assets a ON a.id=i.result_asset_id WHERE i.id=ANY($1::uuid[]) ORDER BY a.name',[ids])).rows;
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await seedFurniture(),null,2));
