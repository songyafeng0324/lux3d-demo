import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPool,loadConfig,LocalFileStore,MAINTENANCE_LOCK} from '@aholo/domain';
export const exec=promisify(execFile);
export function pgArgs(databaseUrl){const u=new URL(databaseUrl);return {args:['-h',u.hostname,'-p',u.port||'5432','-U',decodeURIComponent(u.username),'-d',u.pathname.slice(1)],env:{...process.env,PGPASSWORD:decodeURIComponent(u.password)}};}
export async function digest(file){const h=createHash('sha256');const fd=await fs.open(file,'r');try{for await(const b of fd.createReadStream({autoClose:false}))h.update(b);}finally{await fd.close();}return h.digest('hex');}
export async function backup(config=loadConfig()){
 const pool=createPool(config.databaseUrl);const c=await pool.connect();const store=new LocalFileStore(config.dataDir);await store.initialize();
 const dir=path.join(config.dataDir,'backups',randomUUID());await fs.mkdir(dir,{mode:0o700});
 try{await c.query('SELECT pg_advisory_lock($1)',[MAINTENANCE_LOCK]);
 // Uncertain/outstanding external creates must be resolved before a safe snapshot.
 const outstanding=await c.query("SELECT count(*)::int AS n FROM provider_attempts WHERE dispatch_state IN ('dispatch_started','submission_unknown')");
 if(outstanding.rows[0].n)throw new Error('Backup blocked by unresolved provider dispatch. Reconcile it first.');
 const {args,env}=pgArgs(config.databaseUrl);await exec(path.join(config.pgBin,'pg_dump'),[...args,'-Fc','--no-owner','--no-privileges','-f',path.join(dir,'database.dump')],{env});await fs.chmod(path.join(dir,'database.dump'),0o600);
 const files=(await c.query("SELECT id,object_key,sha256,byte_size::text FROM files WHERE state='committed' ORDER BY id")).rows;
 await fs.mkdir(path.join(dir,'objects'),{mode:0o700});
 for(const f of files){const input=await store.openRead(f.object_key);const out=await fs.open(path.join(dir,'objects',f.object_key),'wx',0o600);try{for await(const b of input)await out.writeFile(b);await out.sync();}finally{await out.close();input.destroy();}
   if(await digest(path.join(dir,'objects',f.object_key))!==f.sha256)throw new Error('Committed object checksum mismatch');}
 const counts={};for(const t of ['users','assets','files','exhibit_slots','schema_migrations'])counts[t]=(await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
 const key=process.env.APP_DATA_KEY;if(key)await fs.writeFile(path.join(dir,'app-data-key'),key,{mode:0o600});
 const manifest={version:1,createdAt:new Date().toISOString(),generationEnabled:false,files,counts,dumpSha256:await digest(path.join(dir,'database.dump')),keySha256:key?createHash('sha256').update(key).digest('hex'):null};
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});return dir;
 }catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
 finally{await c.query('SELECT pg_advisory_unlock($1)',[MAINTENANCE_LOCK]);c.release();await pool.end();}
}
if(import.meta.url===new URL(process.argv[1],'file:').href)console.log('Backup complete: '+await backup());
