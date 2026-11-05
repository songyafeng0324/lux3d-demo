import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadConfig, createPool } from '@aholo/domain';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> = Promise.resolve();
let lastHealthy: boolean | undefined;

async function heartbeat() {
  try {
    await pool.query(
      'INSERT INTO worker_heartbeats (worker_id, last_seen) VALUES ($1, now()) ON CONFLICT (worker_id) DO UPDATE SET last_seen = excluded.last_seen',
      [workerId],
    );
    if (lastHealthy !== true) console.log('Worker 已连接数据库，心跳正常；业务任务处理尚未接入。');
    lastHealthy = true;
  } catch {
    if (lastHealthy !== false) console.error('Worker 正等待数据库或迁移就绪。');
    lastHealthy = false;
  }
}
function schedule() {
  if (stopping) return;
  running = heartbeat().finally(() => {
    if (!stopping) timer = setTimeout(schedule, 2000);
  });
}
async function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  await running;
  await pool.query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [workerId]).catch(() => undefined);
  await pool.end();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
schedule();
