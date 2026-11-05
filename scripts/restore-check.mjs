import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {loadConfig} from '@aholo/domain';
import {exec,digest,pgArgs} from './backup.mjs';
export async function restoreCheck(dir,config=loadConfig(),verifyRestored){
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
 if(manifest.version!==1||manifest.generationEnabled!==false)throw new Error('Unsupported restore manifest');
 if(await digest(path.join(dir,'database.dump'))!==manifest.dumpSha256)throw new Error('Backup dump checksum mismatch');
 if(manifest.keySha256&&await digest(path.join(dir,'app-data-key'))!==manifest.keySha256)throw new Error('Backup key checksum mismatch');
 const local=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
 const admin=new pg.Client({host:'127.0.0.1',port:local.port,user:'aholo_bootstrap',password:local.adminPassword,database:'postgres'});await admin.connect();
 const name='aholo_restore_'+randomUUID().replaceAll('-','');const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-restore-'));
 let created=false;let client;
 try{await admin.query(`CREATE DATABASE ${name} OWNER aholo_app`);created=true;
   const url=new URL(config.databaseUrl);url.pathname='/'+name;const {args,env}=pgArgs(url.href);
   await exec(path.join(config.pgBin,'pg_restore'),[...args,'--no-owner','--no-privileges','--exit-on-error',path.join(dir,'database.dump')],{env});
   client=new pg.Client({connectionString:url.href});await client.connect();
   for(const [t,n] of Object.entries(manifest.counts)){if(!['users','assets','files','exhibit_slots','schema_migrations'].includes(t))throw new Error('Invalid count table');const count=(await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;if(count!==n)throw new Error('Restored row count mismatch');}
   const rows=(await client.query("SELECT id,object_key,sha256,byte_size::text FROM files WHERE state='committed' ORDER BY id")).rows;
   if(JSON.stringify(rows)!==JSON.stringify(manifest.files))throw new Error('Restored DB/file manifest mismatch');
   const objects=path.join(temp,'objects');await fs.mkdir(objects,{mode:0o700});
   for(const f of rows){if(!/^[a-f0-9-]{36}$/.test(f.object_key))throw new Error('Invalid object key');const src=path.join(dir,'objects',f.object_key);if(!(await fs.lstat(src)).isFile()||(await fs.lstat(src)).isSymbolicLink())throw new Error('Invalid backup file');const dst=path.join(objects,f.object_key);await fs.copyFile(src,dst);if(await digest(dst)!==f.sha256||(await fs.stat(dst)).size!==Number(f.byte_size))throw new Error('Restored file mismatch');}
   if(verifyRestored){
    const appDataKey=manifest.keySha256?await fs.readFile(path.join(dir,'app-data-key'),'utf8'):config.appDataKey;
    await verifyRestored({...config,databaseUrl:url.href,dataDir:temp,appDataKey,generationEnabled:false});
   }
   return {databaseVerified:true,filesVerified:rows.length,generationEnabled:false,isolatedDatabaseDropped:true};
 }finally{await client?.end();if(created)await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();await fs.rm(temp,{recursive:true,force:true});}
}
if(import.meta.url===new URL(process.argv[1],'file:').href){const dir=process.argv[2];if(!dir)throw new Error('Pass a backup directory to restore:check');console.log(JSON.stringify(await restoreCheck(dir)));}
