// T03 diagnostics and isolated ingestion. This CLI deliberately has no create
// command: generation submissions require a separately quoted, approved attempt.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {loadConfig,readLux3dCnKey,Lux3dCnClient,LocalFileStore,createPool,transaction} from '@aholo/domain';
import {migrate} from './migrate.mjs';
export const probeDir=path.join(os.homedir(),'Library/Application Support/aholo-lux3d/t03');
const hash=b=>createHash('sha256').update(b).digest('hex');
const readJson=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function save(name,value){await fs.mkdir(probeDir,{recursive:true,mode:0o700});const target=path.join(probeDir,name);const temp=target+'.'+randomUUID()+'.tmp';const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2));await h.sync();}finally{await h.close();}await fs.rename(temp,target);}
export async function downloadOriginal(){
 loadConfig();const key=readLux3dCnKey();if(!key)throw new Error('China credentials unavailable');
 const attempt=await readJson(path.join(probeDir,'attempt.json'));const input=await fs.readFile('tests/fixtures/lux3d-vase.png');const client=new Lux3dCnClient({apiKey:key});
 const task=await client.getTask(attempt.providerTaskId);const outputs=client.parseMeshOutputs(task,attempt.parameters);if(outputs.length!==1||outputs[0].format!=='glb')throw new Error('Expected one GLB');
 const response=await fetch(outputs[0].url,{signal:AbortSignal.timeout(90000),redirect:'error'});if(!response.ok||!response.body)throw new Error('Original artifact download failed');
 const folder=path.join(probeDir,'artifacts');await fs.mkdir(folder,{recursive:true,mode:0o700});const temp=path.join(folder,randomUUID()+'.tmp');const h=await fs.open(temp,'wx',0o600);let count=0;
 try{for await(const chunk of response.body){count+=chunk.byteLength;if(count>256*1024*1024)throw new Error('Probe artifact exceeds local resource budget');await h.writeFile(chunk);}await h.sync();}catch(e){await h.close();await fs.unlink(temp).catch(()=>{});throw e;}await h.close();
 const bytes=await fs.readFile(temp);const info=inspectGlb(bytes);const final=path.join(folder,'vase.glb');try{const old=await fs.readFile(final);if(hash(old)!==info.sha256)throw new Error('Original artifact changed; preserve prior version and investigate');}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.rename(temp,final);await save('task-live.json',task);
 const receipt={providerTaskId:task.taskId,attemptId:attempt.id,quoteId:attempt.quoteId,parameterHash:hash(Buffer.from(JSON.stringify(attempt.parameters))),inputSha256:hash(input),sha256:info.sha256,byteSize:info.byteSize,format:'glb',outputSlot:0,outputHost:new URL(outputs[0].url).hostname,outputUrlHash:hash(Buffer.from(outputs[0].url)),downloadedAt:new Date().toISOString()};await save('download-receipt.json',receipt);return {downloaded:true,bytes:info.byteSize,sha256:info.sha256};
}
export function inspectGlb(bytes){
 if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw new Error('Invalid GLB header');
 const jsonLength=bytes.readUInt32LE(12);if(bytes.readUInt32LE(16)!==0x4e4f534a||20+jsonLength>bytes.length)throw new Error('Invalid GLB JSON chunk');
 const j=JSON.parse(bytes.subarray(20,20+jsonLength).toString('utf8').trim());
 if(j.asset?.version!=='2.0'||!j.meshes?.length||!j.scenes?.length)throw new Error('GLB has no usable scene');
 if((j.buffers||[]).some(b=>b.uri)||(j.images||[]).some(i=>i.uri&&!i.uri.startsWith('data:')))throw new Error('GLB contains external dependencies');
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let triangles=0;
 for(const mesh of j.meshes)for(const p of mesh.primitives){const a=j.accessors?.[p.attributes?.POSITION];if(!a?.min||!a?.max||a.min.length!==3||a.max.length!==3)throw new Error('Position bounds missing');
  for(let i=0;i<3;i++){if(!Number.isFinite(a.min[i])||!Number.isFinite(a.max[i])||a.min[i]>a.max[i])throw new Error('Invalid bounds');min[i]=Math.min(min[i],a.min[i]);max[i]=Math.max(max[i],a.max[i]);}
  if((p.mode??4)===4)triangles+=(p.indices!==undefined?j.accessors[p.indices].count:a.count)/3;
 }
 return {sha256:hash(bytes),byteSize:bytes.length,meshes:j.meshes.length,materials:j.materials?.length||0,triangles,min,max};
}
export async function ingestProbe(){
 const config=loadConfig();const attempt=await readJson(path.join(probeDir,'attempt.json'));const task=await readJson(path.join(probeDir,'task-live.json'));
 if(!attempt.providerTaskId||String(task.taskId)!==attempt.providerTaskId||task.status!==3)throw new Error('Original provider task is not successful');
 const model=await fs.readFile(path.join(probeDir,'artifacts/vase.glb'));const info=inspectGlb(model);const render=await readJson('docs/validation/evidence/T03-render.json');
 if(!render.canvasLoaded||!render.rotationChangesPixels||!render.zoomChangesPixels||render.pageErrors||render.artifactSha256!==info.sha256)throw new Error('Verified rendering evidence missing or mismatched');
 const input=await fs.readFile('tests/fixtures/lux3d-vase.png');const inputHash=hash(input);
 const receipt=await readJson(path.join(probeDir,'download-receipt.json'));const quote=await readJson(path.join(probeDir,'quote.json'));const budget=await readJson(path.join(probeDir,'budget.json'));const upload=await readJson(path.join(probeDir,'upload.json'));
 const requestHash=hash(Buffer.from(JSON.stringify(attempt.parameters)));
 if(receipt.providerTaskId!==attempt.providerTaskId||receipt.attemptId!==attempt.id||receipt.sha256!==info.sha256||receipt.byteSize!==info.byteSize||receipt.inputSha256!==inputHash||receipt.parameterHash!==requestHash||attempt.parameterHash!==requestHash||receipt.quoteId!==attempt.quoteId||quote.quote.quoteId!==attempt.quoteId||budget.attemptId!==attempt.id||budget.committedCredits!==attempt.quotedCredits||quote.quote.estimatedCreditsTotal!==attempt.quotedCredits||attempt.parameters.img!==upload.url||createHash('md5').update(input).digest('hex')!==upload.sourceMd5)throw new Error('Original task/input/quote/download evidence mismatch');
 const idsPath=path.join(probeDir,'probe-ids.json');let ids;
 try{ids=await readJson(idsPath);}catch(e){if(e.code!=='ENOENT')throw e;ids=Object.fromEntries(['user','task','attempt','asset','inputFile','modelFile','inputObject','modelObject'].map(k=>[k,randomUUID()]));await fs.writeFile(idsPath,JSON.stringify(ids),{mode:0o600,flag:'wx'});}
 const storage=new LocalFileStore(path.join(probeDir,'store'));await storage.initialize();
 await storage.commit(await storage.putStaged(input),ids.inputObject,inputHash);await storage.commit(await storage.putStaged(model),ids.modelObject,info.sha256);
 const local=await readJson(path.join(os.homedir(),'Library/Application Support/aholo-lux3d/local-db.json'));
 const admin=new pg.Client({host:'127.0.0.1',port:local.port,user:'aholo_bootstrap',password:local.adminPassword,database:'postgres'});await admin.connect();const db='aholo_lux3d_t03_validation';
 try{const found=await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[db]);
  if(found.rowCount){if(found.rows[0].marker!=='aholo-lux3d isolated T03 validation')throw new Error('Existing validation DB is not owned by this probe');}
  else{await admin.query(`CREATE DATABASE ${db} OWNER aholo_app`);await admin.query(`COMMENT ON DATABASE ${db} IS 'aholo-lux3d isolated T03 validation'`);}
 }finally{await admin.end();}
 // Never derive this target host/port from the application's DATABASE_URL.
 const url=new URL(`postgresql://aholo_app@127.0.0.1:${local.port}/${db}`);url.password=local.appPassword;const pool=createPool(url.href);let replayed=false;
 try{const check=await pool.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port,shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker");const verified=check.rows[0];if(verified.db!==db||verified.host!=='127.0.0.1'||verified.port!==local.port||verified.marker!=='aholo-lux3d isolated T03 validation')throw new Error('Actual validation connection mismatch');
 await migrate(pool);await transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[190341806]);
  const existing=await c.query('SELECT t.status,a.id,f.sha256,p.provider_task_id,i.sha256 AS input_sha FROM generation_tasks t JOIN assets a ON a.id=t.result_asset_id JOIN files f ON f.id=a.model_file_id JOIN provider_attempts p ON p.id=t.attempt_id JOIN files i ON i.id=t.input_file_id WHERE t.id=$1',[ids.task]);
  if(existing.rowCount){if(existing.rows[0].status!=='succeeded'||existing.rows[0].id!==ids.asset||existing.rows[0].sha256!==info.sha256||existing.rows[0].provider_task_id!==attempt.providerTaskId||existing.rows[0].input_sha!==inputHash)throw new Error('Existing result mismatch');replayed=true;return;}
  await c.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash) VALUES($1,'t03_validation','t03_validation','T03 validation',$2)",[ids.user,'probe-only$'+randomUUID()]);
  for(const [id,purpose,key,sha,bytes,mime]of [[ids.inputFile,'input_image',ids.inputObject,inputHash,input.length,'image/png'],[ids.modelFile,'model',ids.modelObject,info.sha256,model.length,'model/gltf-binary']])await c.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1,$2,$3,$4,$5,$6,$7,'committed')",[id,ids.user,purpose,key,sha,bytes,mime]);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(attempt.startedAt));
  await c.query('INSERT INTO quota_days(user_id,quota_day,used_net) VALUES($1,$2,1)',[ids.user,day]);
  await c.query("INSERT INTO generation_tasks(id,user_id,input_file_id,status,submitted_day,attempt_id,policy_version,result_asset_id) VALUES($1,$2,$3,'succeeded',$4,$5,'t03-live-v1',$6)",[ids.task,ids.user,ids.inputFile,day,ids.attempt,ids.asset]);
  await c.query("INSERT INTO provider_attempts(id,task_id,region,request_hash,dispatch_state,provider_task_id,provider_state,started_at,settled_at) VALUES($1,$2,'cn',$3,'settled',$4,'3',$5,now())",[ids.attempt,ids.task,attempt.parameterHash,attempt.providerTaskId,attempt.startedAt]);
  const center=info.min.map((n,i)=>(n+info.max[i])/2);const scale=1/Math.max(...info.max.map((n,i)=>n-info.min[i]));
  await c.query("INSERT INTO assets(id,owner_id,source_type,generation_task_id,model_file_id,original_image_id,name,normalization,bounds,state) VALUES($1,$2,'personal',$3,$4,$5,'T03 chain validation',$6,$7,'ready')",[ids.asset,ids.user,ids.task,ids.modelFile,ids.inputFile,JSON.stringify({center,baseScale:scale,realWorldSizeVerified:false}),JSON.stringify({min:info.min,max:info.max})]);
  await c.query("INSERT INTO quota_events(task_id,user_id,kind,quota_day,delta) VALUES($1,$2,'reserve',$3,1)",[ids.task,ids.user,day]);
 });
 const summary={status:'verified_in_isolated_probe',providerTaskId:attempt.providerTaskId,assetId:ids.asset,database:db,replayed,quotedCredits:quote.quote.estimatedCreditsTotal,committedCredits:budget.committedCredits,recordedAttemptCount:[attempt].filter(a=>typeof a.startedAt==='string').length,geometry:info,rendered:true,mainApplicationBackpackImplemented:false,checkedAt:new Date().toISOString()};
 await save('validation-summary.json',summary);await fs.writeFile('docs/validation/evidence/T03-live.json',JSON.stringify(summary,null,2));
 attempt.localCompletedAt??=new Date().toISOString();attempt.state='delivered';await save('attempt.json',attempt);return summary;
 }finally{await pool.end();}
}
async function main(){loadConfig();const key=readLux3dCnKey();if(!key)throw new Error('China-region credentials unavailable');const client=new Lux3dCnClient({apiKey:key});const command=process.argv[2]||'status';
 if(command==='status'){const a=await readJson(path.join(probeDir,'attempt.json'));console.log(JSON.stringify({state:a.state,taskId:a.providerTaskId,quotedCredits:a.quotedCredits}));}
 else if(command==='query'){const a=await readJson(path.join(probeDir,'attempt.json'));const result=await client.getTask(a.providerTaskId);await save('task-live.json',result);console.log(JSON.stringify({taskId:result.taskId,status:result.status,outputs:result.outputs?.length||0}));}
 else if(command==='upload'){const result=await client.uploadFile(process.argv[3]);await save('node-upload.json',result);console.log(JSON.stringify({uploaded:true,bytes:result.byteSize,urlHost:new URL(result.url).hostname}));}
 else if(command==='ingest')console.log(JSON.stringify(await ingestProbe()));
 else if(command==='download')console.log(JSON.stringify(await downloadOriginal()));
 else throw new Error('Use status/query/upload/download/ingest; there is no create command');
}
if(import.meta.url===new URL(process.argv[1],'file:').href)main().catch(error=>{console.error(JSON.stringify({error:error.code||'probe_error',message:error.code?error.message:'Probe failed; inspect local configuration or evidence.'}));process.exitCode=1;});
