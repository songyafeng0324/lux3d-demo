import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPool,loadConfig,MAINTENANCE_LOCK} from '@aholo/domain';
export async function migrate(pool,directory='migrations'){
 const c=await pool.connect();
 try{await c.query('SELECT pg_advisory_lock($1)',[MAINTENANCE_LOCK]);
 await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of (await fs.readdir(directory)).filter(f=>f.endsWith('.sql')).sort()){
   const sql=await fs.readFile(directory+'/'+name,'utf8');const hash=createHash('sha256').update(sql).digest('hex');
   const old=await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
   if(old.rowCount){if(old.rows[0].sha256!==hash)throw new Error('Applied migration checksum changed: '+name);continue;}
   await c.query('BEGIN');try{await c.query(sql);await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);await c.query('COMMIT');}
   catch(e){await c.query('ROLLBACK');throw e;}
   console.log('Applied '+name);
 }
 }finally{await c.query('SELECT pg_advisory_unlock($1)',[MAINTENANCE_LOCK]);c.release();}
}
if(import.meta.url===new URL(process.argv[1], 'file:').href){const pool=createPool(loadConfig().databaseUrl);try{await migrate(pool);}finally{await pool.end();}}
