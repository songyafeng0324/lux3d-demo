import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {loadEnvFile} from 'node:process';
if(existsSync('.env'))loadEnvFile('.env');
const base=path.join(homedir(),'Library','Application Support','aholo-lux3d');
const bin=process.env.PG_BIN||path.join(homedir(),'Applications/Postgres.app/Contents/Versions/18/bin');
const cluster=path.join(base,'postgres');const configFile=path.join(base,'local-db.json');
const mode=process.argv[2]||'setup';
await fs.mkdir(base,{recursive:true,mode:0o700});
if(!existsSync(path.join(bin,'postgres')))throw new Error('PostgreSQL binaries not found. Install Postgres.app or set PG_BIN.');
let cfg;
if(existsSync(configFile))cfg=JSON.parse(await fs.readFile(configFile,'utf8'));
else {if(mode!=='setup')throw new Error('Run local:setup first');cfg={port:55432,adminPassword:randomBytes(24).toString('hex'),appPassword:randomBytes(24).toString('hex')};await fs.writeFile(configFile,JSON.stringify(cfg),{mode:0o600,flag:'wx'});}
const run=(tool,args,extra={})=>execFileSync(path.join(bin,tool),args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...extra});
const running=()=>{try{run('pg_ctl',['-D',cluster,'status']);return true;}catch{return false;}};
if(mode==='stop'){if(running())run('pg_ctl',['-D',cluster,'stop','-m','fast','-w']);console.log('Project PostgreSQL stopped.');process.exit(0);}
if(!existsSync(path.join(cluster,'PG_VERSION'))){
 if(mode!=='setup')throw new Error('Run local:setup first');
 const pw=path.join(base,'init-password');await fs.writeFile(pw,cfg.adminPassword,{mode:0o600,flag:'wx'});
 try {run('initdb',['-D',cluster,'-U','aholo_bootstrap','-A','scram-sha-256','--pwfile',pw,'--encoding=UTF8','--locale=C']);}
 finally {await fs.unlink(pw);}
 await fs.appendFile(path.join(cluster,'postgresql.conf'),`\nlisten_addresses = '127.0.0.1'\nport = ${cfg.port}\nunix_socket_directories = '/tmp'\n`);
}
if(!running())run('pg_ctl',['-D',cluster,'-l',path.join(base,'postgres.log'),'start','-w']);
if(mode==='start'){console.log('Project PostgreSQL running on loopback.');process.exit(0);}
if(mode!=='setup')throw new Error('Use setup/start/stop');
const admin=new pg.Client({host:'127.0.0.1',port:cfg.port,user:'aholo_bootstrap',password:cfg.adminPassword,database:'postgres'});await admin.connect();
try {
 if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='aholo_app'")).rowCount)
   await admin.query(`CREATE ROLE aholo_app LOGIN PASSWORD '${cfg.appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
 if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='aholo_lux3d'")).rowCount)
   await admin.query('CREATE DATABASE aholo_lux3d OWNER aholo_app');
}finally{await admin.end();}
if(!existsSync('.env')) {
 const text=`DATABASE_URL=postgresql://aholo_app:${cfg.appPassword}@127.0.0.1:${cfg.port}/aholo_lux3d\nDATA_DIR=${JSON.stringify(path.join(base,'data'))}\nPG_BIN=${JSON.stringify(bin)}\nAPI_HOST=127.0.0.1\nAPI_PORT=3001\nPUBLIC_ORIGIN=http://localhost:5173\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nAPP_DATA_KEY=${randomBytes(32).toString('hex')}\nLUX3D_REGION=cn\nLUX3D_CN_API_KEY=\n`;
 await fs.writeFile('.env',text,{mode:0o600,flag:'wx'});
}
console.log('Project PostgreSQL and private local configuration ready (credentials omitted).');
