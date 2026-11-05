import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
  // Create once outside the repository. All processes use the same HMAC/encryption key.
  const keyFile = path.join(root, 'app-data-key');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(keyFile)) { try { writeFileSync(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  const appDataKey = process.env.APP_DATA_KEY || readFileSync(keyFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(appDataKey)) throw new Error('Invalid APP_DATA_KEY');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
  return { databaseUrl: process.env.DATABASE_URL || '', dataDir: path.resolve(process.env.DATA_DIR || path.join(root,'data')),
    apiHost: process.env.API_HOST || '127.0.0.1', apiPort: port, publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
    appDataKey, generationEnabled: process.env.LUX3D_GENERATION_ENABLED !== '0', lux3dConfigured: Boolean(readLux3dCnKey()), pgBin:process.env.PG_BIN || path.join(homedir(),'Applications/Postgres.app/Contents/Versions/18/bin') };
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

export * from './resources.js';
export * from './generation.js';
export * from './accounts.js';
export * from './requests.js';
export * from './curation.js';
