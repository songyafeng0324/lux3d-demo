// Uses the formal API and worker. prepare/status are non-billable; submit needs
// a task-local approval ledger created after the user approves the quoted batch.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
import {loadConfig,createPool,LocalFileStore,GenerationWorker,readLux3dCnKey,Lux3dCnClient,GENERATION_PARAMS} from '@aholo/domain';
import {buildApp} from '../apps/api/dist/app.js';
import {migrate} from './migrate.mjs';
const config=loadConfig(),dir=path.join(os.homedir(),'Library/Application Support/aholo-lux3d/t06');await fs.mkdir(dir,{recursive:true,mode:0o700});
const recordPath=path.join(dir,'site-account.json');
const save=async(name,value)=>{const temp=path.join(dir,name+'.tmp');await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,path.join(dir,name));};
let record;try{record=JSON.parse(await fs.readFile(recordPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;record={username:'t06_demo_20261105',nickname:'藏友',password:randomBytes(24).toString('base64url'),registerKey:randomUUID(),uploadKey:randomUUID(),submitKey:randomUUID()};await save('site-account.json',record);}
const command=process.argv[2]||'status',pool=createPool(config.databaseUrl),store=new LocalFileStore(config.dataDir);let app;
try{
 await migrate(pool);await store.initialize();app=await buildApp({...config,generationEnabled:true});await app.ready();
 const headers={origin:config.publicOrigin};
 const call=async(method,url,payload,key)=>{const response=await app.inject({method,url,headers:{...headers,...(key?{'idempotency-key':key}:{})},...(payload===undefined?{}:{payload})});if(response.statusCode>=400)throw new Error(`Site API ${response.statusCode}: ${response.json().error?.code}`);return response;};
 if(command==='prepare'){
  await call('POST','/api/v1/auth/register',{username:record.username,nickname:record.nickname,password:record.password,confirmPassword:record.password},record.registerKey);
 }
 const login=await call('POST','/api/v1/auth/login',{username:record.username,password:record.password});headers.cookie=login.headers['set-cookie'].split(';')[0];headers['x-csrf-token']=login.json().data.csrfToken;
 if(command==='prepare'&&!record.inputFileId){
  const boundary='t06-'+randomUUID(),image=await fs.readFile('tests/fixtures/lux3d-vase.png');const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="vase.png"\r\nContent-Type: image/png\r\n\r\n`),image,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const uploaded=await app.inject({method:'POST',url:'/api/v1/uploads/images',headers:{...headers,'idempotency-key':record.uploadKey,'content-type':`multipart/form-data; boundary=${boundary}`},payload});if(uploaded.statusCode!==201)throw new Error('Image preparation failed');record.inputFileId=uploaded.json().data.inputFileId;await save('site-account.json',record);
 }
 if(command==='submit'){
  const approval=JSON.parse(await fs.readFile(path.join(dir,'approval.json'),'utf8'));
  if(approval.approved!==true||approval.maxCredits!==1||approval.submitKey!==record.submitKey)throw new Error('Approved one-task ledger required');
  // Refresh quote through the same regional implementation before any paid call.
  // The worker records its exact fresh quote and commitment before create.
  const raw=new Lux3dCnClient({apiKey:readLux3dCnKey()}),guarded={
   uploadFile:raw.uploadFile.bind(raw),getTask:raw.getTask.bind(raw),parseMeshOutputs:raw.parseMeshOutputs.bind(raw),
   quoteImageTask:async p=>{const q=await raw.quoteImageTask(p);if(q.credits>approval.maxCredits)throw new Error('Approved budget exceeded');approval.quoteId=q.quoteId;approval.quotedCredits=q.credits;approval.reservedCredits=q.credits;await save('approval.json',approval);return q;},
   createImageTask:async p=>{approval.committedCredits=approval.quotedCredits;approval.reservedCredits=0;approval.state='dispatch_started';await save('approval.json',approval);const id=await raw.createImageTask(p);approval.providerTaskId=id;approval.state='acknowledged';await save('approval.json',approval);return id;},
  };
  await pool.query("INSERT INTO worker_heartbeats(worker_id,last_seen,generation_enabled) VALUES('t06-live',now(),true) ON CONFLICT(worker_id) DO UPDATE SET last_seen=now(),generation_enabled=true");
  if(!record.taskId){const result=await call('POST','/api/v1/generation-tasks',{inputFileId:record.inputFileId},record.submitKey);record.taskId=result.json().data.id;await save('site-account.json',record);}
  const worker=new GenerationWorker(pool,store,{...config,generationEnabled:true},{provider:guarded});
  // Bounded CLI step: rerun resumes the stored task and never creates a new one.
  for(let n=0;n<3;n++){await worker.tick(record.taskId);const task=(await call('GET','/api/v1/generation-tasks/'+record.taskId)).json().data;if(task.status!=='processing')break;}
 }
 const me=(await call('GET','/api/v1/me')).json().data;
 const tasks=(await call('GET','/api/v1/generation-tasks')).json().data.items;
 const assets=(await call('GET','/api/v1/assets')).json().data.items;
 const summary={username:me.user.username,userId:me.user.id,roomId:me.roomId,quota:me.quota,tasks,assets,checkedAt:new Date().toISOString()};
 await save('site-result.json',summary);console.log(JSON.stringify(summary,null,2));
}finally{await pool.query("DELETE FROM worker_heartbeats WHERE worker_id='t06-live'").catch(()=>{});await app?.close();await pool.end();}
