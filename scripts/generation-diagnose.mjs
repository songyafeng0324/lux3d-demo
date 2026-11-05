// Operations-only original-attempt reconciliation. Never submits provider create.
// Evidence must come from the original call or an explicit provider confirmation;
// time proximity/history cardinality is not ownership evidence.
import fs from 'node:fs/promises';
import {loadConfig,createPool,transaction,readLux3dCnKey,Lux3dCnClient,sha256} from '@aholo/domain';
const config=loadConfig(),pool=createPool(config.databaseUrl),[command='list',value]=process.argv.slice(2);
try{
 if(command==='list'){
  const rows=await pool.query(`SELECT a.id AS attempt_id,a.task_id,a.dispatch_nonce,a.dispatch_state,a.provider_task_id,a.provider_state,a.quote_id,a.committed_credits,t.status AS local_status FROM provider_attempts a JOIN generation_tasks t ON t.id=a.task_id WHERE a.dispatch_state IN ('dispatch_started','submission_unknown','acknowledged') ORDER BY a.created_at`);console.log(JSON.stringify(rows.rows,null,2));
 }else if(command==='evidence'){
  const raw=await fs.readFile(value,'utf8'),e=JSON.parse(raw);
  if(!['original_response','provider_confirmation'].includes(e.source)||!e.reference||typeof e.providerTaskId!=='string'||!/^\d+$/.test(e.providerTaskId))throw new Error('Exact original-call/provider evidence required');
  await transaction(pool,async c=>{
   const attempt=(await c.query('SELECT * FROM provider_attempts WHERE id=$1 AND dispatch_nonce=$2 FOR UPDATE',[e.attemptId,e.dispatchNonce])).rows[0];if(!attempt||attempt.provider_task_id&&attempt.provider_task_id!==e.providerTaskId)throw new Error('Evidence does not match original attempt');
   const prior=(await c.query('SELECT DISTINCT provider_task_id FROM provider_evidence WHERE attempt_id=$1 AND dispatch_nonce=$2',[attempt.id,attempt.dispatch_nonce])).rows;
   if(prior.some(row=>row.provider_task_id!==e.providerTaskId))throw new Error('Conflicting original-attempt evidence; keep quarantined');
   await c.query('INSERT INTO provider_evidence(attempt_id,dispatch_nonce,provider_task_id,evidence_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[e.attemptId,e.dispatchNonce,e.providerTaskId,sha256(raw)]);
  });console.log('Evidence recorded; run reconcile with the attempt ID.');
 }else if(command==='reconcile'){
  const attempt=(await pool.query('SELECT * FROM provider_attempts WHERE id=$1',[value])).rows[0];if(!attempt)throw new Error('Attempt not found');
  const ids=(await pool.query('SELECT DISTINCT provider_task_id FROM provider_evidence WHERE attempt_id=$1 AND dispatch_nonce=$2',[value,attempt.dispatch_nonce])).rows.map(r=>r.provider_task_id);
  if(attempt.provider_task_id&&!ids.includes(attempt.provider_task_id))ids.push(attempt.provider_task_id);
  if(ids.length!==1)throw new Error('Exactly one reliable provider ID required; no automatic history matching');
  const client=new Lux3dCnClient({apiKey:readLux3dCnKey()}),task=await client.getTask(ids[0]),terminal=[3,4,6].includes(task.status);
  await transaction(pool,async c=>{
   const t=(await c.query('SELECT * FROM generation_tasks WHERE id=$1',[attempt.task_id])).rows[0];await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[t.user_id]);await c.query('SELECT id FROM generation_tasks WHERE id=$1 FOR UPDATE',[t.id]);
   const current=(await c.query('SELECT * FROM provider_attempts WHERE id=$1 FOR UPDATE',[value])).rows[0];
   const latest=(await c.query('SELECT DISTINCT provider_task_id FROM provider_evidence WHERE attempt_id=$1 AND dispatch_nonce=$2',[value,current.dispatch_nonce])).rows.map(r=>r.provider_task_id);
   if(current.provider_task_id&&!latest.includes(current.provider_task_id))latest.push(current.provider_task_id);
   if(current.dispatch_nonce!==attempt.dispatch_nonce||latest.length!==1||latest[0]!==ids[0])throw new Error('Evidence changed during query; preserve quarantine');
   if(current.dispatch_state==='settled'&&!terminal)throw new Error('Refusing to downgrade known provider terminal state');
   await c.query("UPDATE provider_attempts SET provider_task_id=$2,provider_state=$3,dispatch_state=$4,settled_at=CASE WHEN $5 THEN now() ELSE settled_at END WHERE id=$1",[value,ids[0],String(task.status),terminal?'settled':'acknowledged',terminal]);
   // Terminal website results remain immutable, including after a late provider success.
   if(!['succeeded','failed'].includes(t.status))await c.query("UPDATE jobs SET run_at=now() WHERE kind='generation' AND ref_id=$1 AND state='queued'",[t.id]);
  });console.log(JSON.stringify({providerTaskId:ids[0],providerStatus:task.status,reservationRetained:!terminal,createdNewTask:false}));
 }else throw new Error('Use list | evidence <private-evidence.json> | reconcile <attempt-uuid>');
}finally{await pool.end();}
