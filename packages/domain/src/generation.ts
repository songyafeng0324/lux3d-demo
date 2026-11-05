import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalFileStore} from './storage.js';
import {transaction,type Config} from './index.js';
import {Lux3dCnClient,Lux3dTransportError,type Lux3dTask} from './lux3d.js';
import {readLux3dCnKey} from './credentials.js';
import {sha256,validateImage,validateModel,MODEL_LIMIT} from './resources.js';
export const GENERATION_POLICY='t06-v1';
export const GENERATION_PARAMS={version:'G1-Turbo' as const,faceCount:50000,outputFormat:['glb' as const],enablePbr:true,aiPredictSize:false};
export const generationRequestHash=(inputSha256:string)=>sha256(JSON.stringify({inputSha256,policyVersion:GENERATION_POLICY,...GENERATION_PARAMS}));
type Job={id:string;kind:string;ref_id:string;fence:string};
export interface GenerationProvider {
 quoteImageTask(params:any):Promise<{quoteId:string;credits:number;expiresAt:string}>;
 uploadFile(file:string):Promise<{url:string}>;
 createImageTask(params:any):Promise<string>;
 getTask(id:string):Promise<Lux3dTask>;
 parseMeshOutputs(result:Lux3dTask,profile:any):Array<{url:string;format:string}>;
}
const DISPATCH_LOCK=190341806;
const terminal=(s:string)=>s==='succeeded'||s==='failed';
export class GenerationWorker {
 private provider?:GenerationProvider;
 constructor(readonly pool:pg.Pool,readonly store:LocalFileStore,readonly config:Config,readonly options:{provider?:GenerationProvider;download?:(url:string)=>Promise<Buffer>;validate?:typeof validateModel;now?:()=>number;deliveryWindowMs?:number}={}){this.provider=options.provider;}
 private now(){return this.options.now?.()??Date.now();}
 private async bytes(key:string){const chunks:Buffer[]=[];for await(const c of await this.store.openRead(key))chunks.push(c as Buffer);return Buffer.concat(chunks);}
 async tick(refId?:string){
  const job=await transaction(this.pool,async c=>{
   const r=await c.query(`SELECT * FROM jobs WHERE kind IN ('generation','import') AND ($1::uuid IS NULL OR ref_id=$1) AND ((state='queued' AND run_at<=now()) OR (state='running' AND lease_until<now())) ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[refId??null]);
   if(!r.rowCount)return null;
   return (await c.query(`UPDATE jobs SET state='running',fence=fence+1,attempts=attempts+1,lease_until=now()+interval '120 seconds' WHERE id=$1 RETURNING *`,[r.rows[0].id])).rows[0] as Job;
  });
  if(!job)return false;
  const timer=setInterval(()=>{void this.pool.query("UPDATE jobs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND fence=$2 AND state='running' AND lease_until>now()",[job.id,job.fence]).catch(()=>{});},15000);
  try{if(job.kind==='generation')await this.generate(job);else await this.importModel(job);}
  catch(error){await this.requeue(job,error instanceof Lux3dTransportError?error.code:'processing_error');}
  finally{clearInterval(timer);}return true;
 }
 private async owns(c:pg.PoolClient,job:Job){return (await c.query("SELECT 1 FROM jobs WHERE id=$1 AND fence=$2 AND state='running' AND lease_until>now() FOR UPDATE",[job.id,job.fence])).rowCount===1;}
 private async requeue(job:Job,code:string){await transaction(this.pool,async c=>{if(!await this.owns(c,job))return;await c.query("UPDATE jobs SET state='queued',run_at=now()+interval '5 seconds',lease_until=NULL,last_error=$3 WHERE id=$1 AND fence=$2",[job.id,job.fence,code]);});}
 private async finishJob(c:pg.PoolClient,job:Job,success:boolean){await c.query("UPDATE jobs SET state=$3,lease_until=NULL,last_error=NULL WHERE id=$1 AND fence=$2",[job.id,job.fence,success?'succeeded':'failed']);}
 private async task(job:Job){return (await this.pool.query(`SELECT t.*,t.submitted_day::text,a.dispatch_state,a.dispatch_nonce,a.provider_task_id,a.provider_state,a.request_hash,a.input_sha256,a.request_params,a.delivery_receipt,f.object_key,f.sha256 input_sha,f.mime FROM generation_tasks t JOIN provider_attempts a ON a.id=t.attempt_id JOIN files f ON f.id=t.input_file_id WHERE t.id=$1`,[job.ref_id])).rows[0];}
 private async lockTask(c:pg.PoolClient,t:any,job:Job){await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[t.user_id]);const r=await c.query('SELECT * FROM generation_tasks WHERE id=$1 FOR UPDATE',[t.id]);if(!r.rowCount||!await this.owns(c,job))return null;return r.rows[0];}
 private async fail(job:Job,t:any,code:string){await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(!current)return;
  if(terminal(current.status)){await this.finishJob(c,job,current.status==='succeeded');return;}
  await c.query('SELECT 1 FROM quota_days WHERE user_id=$1 AND quota_day=$2 FOR UPDATE',[t.user_id,t.submitted_day]);
  const event=await c.query("INSERT INTO quota_events(task_id,user_id,kind,quota_day,delta) VALUES($1,$2,'refund',$3,-1) ON CONFLICT(task_id,kind) DO NOTHING RETURNING id",[t.id,t.user_id,t.submitted_day]);
  if(event.rowCount)await c.query('UPDATE quota_days SET used_net=used_net-1,updated_at=now() WHERE user_id=$1 AND quota_day=$2',[t.user_id,t.submitted_day]);
  await c.query("UPDATE generation_tasks SET status='failed',error_code=$2,updated_at=now() WHERE id=$1",[t.id,code]);
  await this.finishJob(c,job,false);
 });}
 private async generate(job:Job){
  let t=await this.task(job);if(!t)throw new Error('TASK_MISSING');
  if(terminal(t.status)){await transaction(this.pool,async c=>{if(await this.owns(c,job))await this.finishJob(c,job,t.status==='succeeded');});return;}
  // A durable, verified receipt wins a cutoff race; a committed terminal never revives.
  if(t.delivery_receipt){await this.publish(job,t);return;}
  const deadline=new Date(t.created_at).getTime()+(this.options.deliveryWindowMs??86400000);
  if(this.now()>=deadline){await this.fail(job,t,'DELIVERY_DEADLINE');return;}
  if(!this.provider){const key=readLux3dCnKey();if(key)this.provider=new Lux3dCnClient({apiKey:key});}
  if(!this.provider){await this.requeue(job,'provider_unavailable');return;}
  if(t.dispatch_state==='rejected'){await this.fail(job,t,'SUBMISSION_REJECTED');return;}
  if(t.dispatch_state==='prepared'){
   if(!this.config.generationEnabled){await this.requeue(job,'generation_disabled');return;}
   if(t.request_hash!==generationRequestHash(t.input_sha)||t.input_sha256!==t.input_sha)throw new Error('REQUEST_PROVENANCE_INVALID');
   const input=await this.bytes(t.object_key);if(sha256(input)!==t.input_sha)throw new Error('INPUT_CHECKSUM');
   const image=await validateImage(input),temp=await mkdtemp(path.join(tmpdir(),'aholo-upload-'));
   let uploaded;try{const file=path.join(temp,`input.${image.extension}`);await writeFile(file,input,{mode:0o600});uploaded=await this.provider.uploadFile(file);}finally{await rm(temp,{recursive:true,force:true});}
   const quote=await this.provider.quoteImageTask({...GENERATION_PARAMS,img:uploaded.url});
   if(typeof quote.quoteId!=='string'||!quote.quoteId||!Number.isSafeInteger(quote.credits)||quote.credits<0||!Number.isFinite(Date.parse(quote.expiresAt))||Date.parse(quote.expiresAt)<=Date.now())throw new Error('QUOTE_INVALID');
   // Persist dispatch_started BEFORE create. A crash from here is unknown, never prepared.
   const dispatch=await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(!current||terminal(current.status))return false;
    await c.query('SELECT pg_advisory_xact_lock($1)',[DISPATCH_LOCK]);
    const attempt=(await c.query('SELECT * FROM provider_attempts WHERE id=$1 FOR UPDATE',[t.attempt_id])).rows[0];
    if(attempt.dispatch_state!=='prepared')return false;
    const occupied=await c.query("SELECT 1 FROM provider_attempts WHERE id<>$1 AND region='cn' AND dispatch_state IN ('dispatch_started','submission_unknown','acknowledged') LIMIT 1",[t.attempt_id]);
    if(occupied.rowCount)return false;
    await c.query("UPDATE provider_attempts SET dispatch_state='dispatch_started',started_at=now(),request_params=$2,quote_id=$3,committed_credits=$4 WHERE id=$1",[t.attempt_id,JSON.stringify({...GENERATION_PARAMS,img:uploaded.url}),quote.quoteId,quote.credits]);
    await c.query("UPDATE generation_tasks SET status='dispatching',updated_at=now() WHERE id=$1",[t.id]);return true;
   });
   if(!dispatch){await this.requeue(job,'provider_capacity');return;}
   const submitted=await transaction(this.pool,async c=>{
    // Keep the maintenance shared lock throughout the external side effect and
    // the exact-ID evidence commit, without nesting another transaction.
    const current=await this.lockTask(c,t,job);
    if(!current||terminal(current.status))return 'lost';
    try{
     const id=await this.provider!.createImageTask({...GENERATION_PARAMS,img:uploaded.url});
     await c.query('INSERT INTO provider_evidence(attempt_id,dispatch_nonce,provider_task_id,evidence_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[t.attempt_id,t.dispatch_nonce,id,sha256(t.dispatch_nonce+':'+id)]);
     return 'acknowledged';
    }catch(error){
     const rejected=error instanceof Lux3dTransportError&&error.code==='submission_rejected';
     await c.query('UPDATE provider_attempts SET dispatch_state=$2 WHERE id=$1',[t.attempt_id,rejected?'rejected':'submission_unknown']);
     return rejected?'rejected':'unknown';
    }
   });
   if(submitted!=='acknowledged'){if(submitted==='rejected')await this.fail(job,t,'SUBMISSION_REJECTED');else await this.requeue(job,'submission_unknown');return;}
   await this.attachEvidence(job,t);t=await this.task(job);
  }
  if(!t.provider_task_id){await this.attachEvidence(job,t);t=await this.task(job);}
  if(!t.provider_task_id){await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(!current||terminal(current.status))return;await c.query("UPDATE generation_tasks SET status='submission_unknown',updated_at=now() WHERE id=$1",[t.id]);await c.query("UPDATE provider_attempts SET dispatch_state='submission_unknown' WHERE id=$1 AND dispatch_state='dispatch_started'",[t.attempt_id]);});await this.requeue(job,'submission_unknown');return;}
  const result=await this.provider.getTask(t.provider_task_id);
  await transaction(this.pool,async c=>{if(!await this.owns(c,job))return;await c.query(`UPDATE provider_attempts SET provider_state=$2,dispatch_state=CASE WHEN $3 THEN 'settled' ELSE dispatch_state END,settled_at=CASE WHEN $3 THEN now() ELSE settled_at END WHERE id=$1`,[t.attempt_id,String(result.status),[3,4,6].includes(result.status)]);});
  if(result.status===4||result.status===6){await this.fail(job,t,'PROVIDER_FAILED');return;}
  if(result.status!==3){await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(current&&!terminal(current.status))await c.query("UPDATE generation_tasks SET status='provider_running',updated_at=now() WHERE id=$1",[t.id]);});await this.requeue(job,'provider_running');return;}
  const output=this.provider.parseMeshOutputs(result,GENERATION_PARAMS);
  if(output.length!==1||output[0].format!=='glb')throw new Error('OUTPUT_INVALID');
  const bytes=await this.download(output[0].url);
  const verified=await (this.options.validate??validateModel)(bytes);
  const file=await this.saveModel(t.attempt_id,t.user_id,bytes,verified.sha256);
  await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(!current||terminal(current.status))return;
   await c.query('UPDATE provider_attempts SET delivery_receipt=$2 WHERE id=$1',[t.attempt_id,JSON.stringify({...verified,fileId:file,attemptId:t.attempt_id,providerTaskId:t.provider_task_id,inputSha256:t.input_sha,requestHash:t.request_hash,outputSlot:0,verifiedAt:new Date().toISOString()})]);
   await c.query("UPDATE generation_tasks SET status='validating',updated_at=now() WHERE id=$1",[t.id]);
  });t=await this.task(job);await this.publish(job,t);
 }
 private async attachEvidence(job:Job,t:any){await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(!current||terminal(current.status))return;
  await c.query('SELECT id FROM provider_attempts WHERE id=$1 FOR UPDATE',[t.attempt_id]);
  const evidence=await c.query('SELECT DISTINCT provider_task_id FROM provider_evidence WHERE attempt_id=$1 AND dispatch_nonce=$2',[t.attempt_id,t.dispatch_nonce]);
  if(evidence.rows.length!==1)return;const id=evidence.rows[0].provider_task_id;
  await c.query("UPDATE provider_attempts SET provider_task_id=$2,dispatch_state='acknowledged' WHERE id=$1 AND (provider_task_id IS NULL OR provider_task_id=$2)",[t.attempt_id,id]);
 });}
 private async saveModel(id:string,owner:string,bytes:Buffer,hash:string){
  if(sha256(bytes)!==hash)throw new Error('MODEL_CHECKSUM');
  await transaction(this.pool,async c=>{
   await c.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,'model',$1::text,$3,$4,'model/gltf-binary','staged') ON CONFLICT(id) DO NOTHING",[id,owner,hash,bytes.length]);
   const f=(await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE',[id])).rows[0];if(f.sha256!==hash||f.owner_id!==owner)throw new Error('MODEL_CONFLICT');
   const staged=await this.store.putStaged(bytes);await this.store.commit(staged,id,hash);
   await c.query("UPDATE files SET state='committed' WHERE id=$1 AND sha256=$2",[id,hash]);
  });return id;
 }
 private async publish(job:Job,t:any){
  const r=t.delivery_receipt;
  if(!r?.rendered||r.providerTaskId!==t.provider_task_id||r.attemptId!==t.attempt_id||r.inputSha256!==t.input_sha||r.requestHash!==t.request_hash)throw new Error('DELIVERY_PROVENANCE_INVALID');
  const f=(await this.pool.query("SELECT * FROM files WHERE id=$1 AND state='committed'",[r.fileId])).rows[0];if(!f||sha256(await this.bytes(f.object_key))!==r.sha256||f.sha256!==r.sha256)throw new Error('DELIVERY_CHECKSUM');
  await transaction(this.pool,async c=>{const current=await this.lockTask(c,t,job);if(!current)return;if(terminal(current.status)){await this.finishJob(c,job,current.status==='succeeded');return;}
   const n=(await c.query("SELECT count(*)::int n FROM assets WHERE owner_id=$1 AND source_type='personal'",[t.user_id])).rows[0].n+1,id=randomUUID();
   await c.query("INSERT INTO assets(id,owner_id,source_type,generation_task_id,model_file_id,original_image_id,name,normalization,bounds) VALUES($1,$2,'personal',$3,$4,$5,$6,$7,$8)",[id,t.user_id,t.id,r.fileId,t.input_file_id,`资产${String(n).padStart(2,'0')}`,r.normalization,r.bounds]);
   await c.query("UPDATE generation_tasks SET status='succeeded',result_asset_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",[t.id,id]);await this.finishJob(c,job,true);
  });
 }
 private async download(url:string){
  if(this.options.download)return this.options.download(url);
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(90000)});if(!response.ok||!response.body)throw new Error('DOWNLOAD_PENDING');
  if(Number(response.headers.get('content-length'))>MODEL_LIMIT)throw new Error('MODEL_SIZE_LIMIT');
  const chunks:Buffer[]=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>MODEL_LIMIT){await response.body.cancel().catch(()=>{});throw new Error('MODEL_SIZE_LIMIT');}chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);
 }
 private async importModel(job:Job){
  const row=(await this.pool.query('SELECT i.*,f.object_key,f.sha256 AS file_sha256,f.state AS file_state FROM asset_imports i JOIN files f ON f.id=i.input_file_id WHERE i.id=$1',[job.ref_id])).rows[0];if(!row)throw new Error('IMPORT_MISSING');
  if(row.state==='succeeded'||row.state==='failed'){await transaction(this.pool,async c=>{if(await this.owns(c,job))await this.finishJob(c,job,row.state==='succeeded');});return;}
  let verified;try{const bytes=await this.bytes(row.object_key);if(row.file_state!=='committed'||sha256(bytes)!==row.file_sha256)throw new Error('IMPORT_CHECKSUM');verified=await (this.options.validate??validateModel)(bytes);if(verified.sha256!==row.file_sha256)throw new Error('IMPORT_VALIDATION_CHECKSUM');}catch{await transaction(this.pool,async c=>{if(!await this.owns(c,job))return;await c.query("UPDATE asset_imports SET state='failed',error_code='MODEL_INVALID',updated_at=now() WHERE id=$1 AND state NOT IN ('succeeded','failed')",[row.id]);await this.finishJob(c,job,false);});return;}
  await transaction(this.pool,async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.admin_id]);const i=(await c.query('SELECT * FROM asset_imports WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(!await this.owns(c,job)||i.state==='failed'||i.state==='succeeded')return;
   const id=randomUUID(),meta=i.metadata_snapshot;
   await c.query('INSERT INTO assets(id,source_type,import_id,model_file_id,name,description,normalization,bounds) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,i.source_type,i.id,i.input_file_id,meta.name,meta.description??'',verified.normalization,verified.bounds]);
   if(i.source_type==='official_candidate'){const candidate=randomUUID(),snapshot={...meta,sourceNickname:'官方馆藏'};await c.query("INSERT INTO candidates(id,asset_id,source,public_snapshot) VALUES($1,$2,'official',$3)",[candidate,id,snapshot]);await c.query('INSERT INTO active_publications(asset_id,candidate_id) VALUES($1,$2)',[id,candidate]);}
   await c.query("UPDATE asset_imports SET state='succeeded',result_asset_id=$2,validation_receipt=$3,updated_at=now() WHERE id=$1",[row.id,id,verified]);await this.finishJob(c,job,true);
  });
 }
}
