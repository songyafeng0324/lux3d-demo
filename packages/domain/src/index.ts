import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readLux3dCnKey } from './credentials.js';
export { LocalFileStore } from './storage.js';
export { seedAdmin } from './admin.js';
export { Lux3dCnClient, Lux3dTransportError } from './lux3d.js';
export { readLux3dCnKey } from './credentials.js';
export { recoveryDecision, DEFAULT_DELIVERY_WINDOW_MS } from './recovery.js';
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig() {
  const envFile=process.env.ENV_FILE || fileURLToPath(new URL('../../../.env',import.meta.url));
  if (existsSync(envFile)) loadEnvFile(envFile);
  const root = path.join(homedir(), 'Library', 'Application Support', 'aholo-lux3d');
  const port = Number(process.env.API_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
  return { databaseUrl: process.env.DATABASE_URL || '', dataDir: path.resolve(process.env.DATA_DIR || path.join(root,'data')),
    apiHost: process.env.API_HOST || '127.0.0.1', apiPort: port, publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
    lux3dConfigured: Boolean(readLux3dCnKey()), pgBin:process.env.PG_BIN || path.join(homedir(),'Applications/Postgres.app/Contents/Versions/18/bin') };
}
export function createPool(databaseUrl: string) {
  if (!databaseUrl) throw new Error('Database not configured. Run npm run local:setup.');
  const pool=new pg.Pool({connectionString:databaseUrl,max:10,connectionTimeoutMillis:3000,idleTimeoutMillis:5000});
  pool.on('error',()=>console.error('Database idle connection interrupted; next query will reconnect.'));
  return pool;
}
// All future business transactions and provider dispatches must take this shared
// transaction lock; backup takes its exclusive session counterpart.
export const MAINTENANCE_LOCK = 190341805;
export async function transaction<T>(pool: pg.Pool, fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const c=await pool.connect();
  try { await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock_shared($1)',[MAINTENANCE_LOCK]);
    const value=await fn(c); await c.query('COMMIT'); return value;
  } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
}
