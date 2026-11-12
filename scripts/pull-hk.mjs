// Copy the live data from the Hong Kong server down to this Mac.
//   node scripts/pull-hk.mjs           take a fresh backup on the server, download it, verify it (local data untouched)
//   node scripts/pull-hk.mjs --apply   also replace the local database and object files with it
//                                      (stop `npm run dev` first; the current local data is backed up before it is replaced)
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {loadConfig} from '@aholo/domain';
import {exec,digest,pgArgs,backup} from './backup.mjs';
import {restoreCheck} from './restore-check.mjs';

const HOST=process.env.DEPLOY_HOST||'aholo-hk';
const apply=process.argv.includes('--apply');
const config=loadConfig();
const sh=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim();

if(apply){
  let busy='';try{busy=sh('pgrep',['-fl','scripts/dev.mjs|apps/api/dist/index.js|apps/worker/dist/index.js|scripts/t0'])}catch{}
  if(busy)throw new Error('本机的网站或 worker 还在运行，先在启动终端按 Ctrl+C 停掉 npm run dev 再执行 --apply：\n'+busy);
}

// 1. Fresh backup on the server (same job as the 04:30 timer), then find its directory.
console.log('服务器：正在生成新备份…');
sh('ssh',[HOST,'systemctl start aholo-backup.service']);
const id=sh('ssh',[HOST,'ls -t /var/lib/aholo/data/backups | head -1']);
if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Unexpected server backup name: '+id);

// 2. Download into the local backups folder.
const stamp=new Date().toISOString().slice(0,16).replace(/[-:T]/g,'');
const dir=path.join(config.dataDir,'backups','hk-'+stamp+'-'+id.slice(0,8));
await fs.mkdir(dir,{recursive:true,mode:0o700});
console.log('下载到 '+dir);
execFileSync('rsync',['-az',`${HOST}:/var/lib/aholo/data/backups/${id}/`,dir+'/'],{stdio:'inherit'});

// 3. Verify in an isolated throwaway database (checksums, row counts, every object file).
const check=await restoreCheck(dir,config);
const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
console.log('校验通过：',JSON.stringify(manifest.counts),'对象文件',check.filesVerified,'个');
if(!apply){console.log('本机数据没有改动。要替换本机数据，停掉 npm run dev 后运行：node scripts/pull-hk.mjs --apply');process.exit(0);}

// 4. Replace local data. Encrypted share tokens only open with the same APP_DATA_KEY.
const localKeySha=createHash('sha256').update(config.appDataKey).digest('hex');
if(manifest.keySha256&&manifest.keySha256!==localKeySha)throw new Error('本机 APP_DATA_KEY 与服务器不同，替换后分享链接会失效，已停止。');
console.log('先备份本机现有数据…');
const localBackup=await backup(config);
console.log('本机旧数据已备份到 '+localBackup);

const local=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'),'utf8'));
const dbName=new URL(config.databaseUrl).pathname.slice(1);
if(!/^[a-z_][a-z0-9_]*$/.test(dbName))throw new Error('Unexpected database name');
const admin=new pg.Client({host:'127.0.0.1',port:local.port,user:'aholo_bootstrap',password:local.adminPassword,database:'postgres'});
await admin.connect();
try{
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER aholo_app`);
}finally{await admin.end();}
const {args,env}=pgArgs(config.databaseUrl);
await exec(path.join(config.pgBin,'pg_restore'),[...args,'--no-owner','--no-privileges','--exit-on-error',path.join(dir,'database.dump')],{env});

const objects=path.join(config.dataDir,'objects');
const old=path.join(config.dataDir,'objects-replaced-'+stamp);
await fs.rename(objects,old);
await fs.mkdir(objects,{mode:0o700});
for(const f of manifest.files){
  if(!/^[a-f0-9-]{36}$/.test(f.object_key))throw new Error('Invalid object key');
  const dst=path.join(objects,f.object_key);
  await fs.copyFile(path.join(dir,'objects',f.object_key),dst);await fs.chmod(dst,0o600);
  if(await digest(dst)!==f.sha256)throw new Error('Object checksum mismatch: '+f.object_key);
}
// The pre-replace backup above holds every committed old object, so the renamed folder is not needed.
await fs.rm(old,{recursive:true,force:true});
execFileSync(process.execPath,[fileURLToPath(new URL('./migrate.mjs',import.meta.url))],{stdio:'inherit'});

const c=new pg.Client({connectionString:config.databaseUrl});await c.connect();
const users=(await c.query('SELECT count(*)::int n FROM users')).rows[0].n;await c.end();
console.log(`完成：本机已换成服务器数据（${users} 个账号，${manifest.files.length} 个文件）。现在可以 npm run dev。`);
