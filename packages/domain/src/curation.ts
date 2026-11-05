import {BusinessError,textField} from './accounts.js';
import type pg from 'pg';
import {transaction} from './index.js';
import type {LocalFileStore} from './storage.js';
/** Public exhibit fields shared by user submissions and administrator official imports (PRD 7.5). */
export const PUBLIC_FIELDS=['name','description','era','material','ownershipType','holderName','location','officialUrl'] as const;
export type OwnershipType='personal_collection'|'museum';
export interface PublicSnapshot {name:string;description:string;era:string;material:string;ownershipType:OwnershipType;holderName:string;location:string;officialUrl:string;sourceNickname:string}
const labels:Record<string,string>={name:'名称',description:'简介',era:'年代',material:'材质',holderName:'收藏方名称',location:'地点'};
/** Required text is trimmed and non-empty; era/material accept “不详”; officialUrl may be empty, otherwise http(s). */
export function publicFieldsInput(input:Record<string,unknown>):Omit<PublicSnapshot,'sourceNickname'>{
 const missing=(['name','description','era','material','holderName','location'] as const).filter(k=>typeof input[k]!=='string'||!(input[k] as string).trim());
 if(input.ownershipType!=='personal_collection'&&input.ownershipType!=='museum')missing.push('ownershipType' as never);
 if(missing.length)throw Object.assign(new BusinessError(422,'PUBLIC_FIELDS_REQUIRED',`请补齐：${missing.map(k=>labels[k]??'归属类型').join('、')}`),{fields:missing});
 const officialUrl=input.officialUrl===undefined||input.officialUrl===null?'':input.officialUrl;
 if(typeof officialUrl!=='string'||officialUrl.trim().length>500)throw new BusinessError(422,'INVALID_INPUT','官网链接无效');
 const url=officialUrl.trim();
 if(url){let ok=false;try{ok=['http:','https:'].includes(new URL(url).protocol);}catch{ok=false;}if(!ok)throw new BusinessError(422,'INVALID_INPUT','官网链接须以http或https开头');}
 return {name:textField(input.name,'名称',1,80),description:textField(input.description,'简介',1,2000),era:textField(input.era,'年代',1,80),material:textField(input.material,'材质',1,80),
  ownershipType:input.ownershipType as OwnershipType,holderName:textField(input.holderName,'收藏方名称',1,80),location:textField(input.location,'地点',1,200),officialUrl:url};
}
/**
 * Deletes bytes of risk-deleted assets. The business transaction already made the
 * file unreadable (state=deleted); this retryable job only reclaims storage and never
 * removes a file that a ready asset or an active generation/import still references.
 */
export async function cleanupTick(pool:pg.Pool,store:LocalFileStore){
 return transaction(pool,async c=>{
  const job=(await c.query("SELECT j.*,f.state AS file_state FROM cleanup_jobs j LEFT JOIN files f ON f.id=j.file_id WHERE j.state IN ('queued','failed') AND j.run_at<=now() ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1")).rows[0];
  if(!job)return false;
  const referenced=(await c.query(`SELECT 1 FROM assets a WHERE a.state='ready' AND (a.model_file_id=$1 OR a.original_image_id=$1)
   UNION ALL SELECT 1 FROM generation_tasks t WHERE t.input_file_id=$1 AND t.status NOT IN ('succeeded','failed')
   UNION ALL SELECT 1 FROM asset_imports i WHERE i.input_file_id=$1 AND i.state NOT IN ('succeeded','failed') LIMIT 1`,[job.file_id])).rowCount;
  if(job.file_id&&(job.file_state!=='deleted'||referenced)){await c.query("UPDATE cleanup_jobs SET state='failed',last_error='STILL_REFERENCED',attempts=attempts+1,run_at=now()+interval '1 hour' WHERE id=$1",[job.id]);return true;}
  try{await store.delete(job.object_key);await c.query("UPDATE cleanup_jobs SET state='succeeded',last_error=NULL,attempts=attempts+1 WHERE id=$1",[job.id]);}
  catch(error){await c.query("UPDATE cleanup_jobs SET state='failed',last_error=$2,attempts=attempts+1,run_at=now()+least(attempts+1,60)*interval '1 minute' WHERE id=$1",[job.id,(error as Error).message.slice(0,200)]);}
  return true;
 });
}
/** Expired snapshot grants carry no access; drop them a day after expiry (receipts stay keyed by path). */
export async function expireGrants(pool:pg.Pool){return (await pool.query("DELETE FROM snapshot_grants WHERE expires_at<now()-interval '1 day'")).rowCount??0;}
