import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadConfig, createPool, LocalFileStore, GenerationWorker, cleanupTick, expireGrants, enqueueWebCopies } from '@aholo/domain';
const config=loadConfig(),pool=createPool(config.databaseUrl),store=new LocalFileStore(config.dataDir);
await store.initialize();
const worker=new GenerationWorker(pool,store,config),workerId=`${hostname()}:${process.pid}:${randomUUID()}`;
let lastGrantSweep=0,lastCopySweep=0,stopping=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>=Promise.resolve(),lastHealthy:boolean|undefined;
async function step(){
 try{
  await pool.query('INSERT INTO worker_heartbeats(worker_id,last_seen,generation_enabled) VALUES($1,now(),$2) ON CONFLICT(worker_id) DO UPDATE SET last_seen=excluded.last_seen,generation_enabled=excluded.generation_enabled',[workerId,config.generationEnabled&&config.lux3dConfigured]);
  if(lastHealthy!==true)console.log('Worker已连接：持久生成与模型导入队列就绪。');lastHealthy=true;
  // Every ready model gets a web copy (also the ones from before copies existed); jobs run after generations and imports.
  if(Date.now()-lastCopySweep>10000){lastCopySweep=Date.now();await enqueueWebCopies(pool);}
  await worker.tick();
  // Risk-deleted files are already unreadable; this only reclaims their bytes, retrying with backoff.
  await cleanupTick(pool,store);
  if(Date.now()-lastGrantSweep>600000){lastGrantSweep=Date.now();await expireGrants(pool);}
 }catch{if(lastHealthy!==false)console.error('Worker正在等待数据库、迁移或存储恢复。');lastHealthy=false;}
}
// Heartbeats must remain current during upload/download/browser validation.
const heartbeat=setInterval(()=>{if(!stopping)void pool.query('UPDATE worker_heartbeats SET last_seen=now() WHERE worker_id=$1',[workerId]).catch(()=>{});},2000);
function schedule(){if(stopping)return;running=step().finally(()=>{if(!stopping)timer=setTimeout(schedule,1000);});}
async function stop(){if(stopping)return;stopping=true;if(timer)clearTimeout(timer);clearInterval(heartbeat);await running;await pool.query('DELETE FROM worker_heartbeats WHERE worker_id=$1',[workerId]).catch(()=>{});await pool.end();}
process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});schedule();
