import {createHmac} from 'node:crypto';
import type pg from 'pg';
import {transaction} from './index.js';
import {BusinessError} from './accounts.js';
function canonical(value:unknown):string{
  if(value===null || typeof value!=='object') return JSON.stringify(value) ?? 'null';
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value as object).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const bodyHash=(value:unknown,key:string)=>createHmac('sha256',key).update(canonical(value)).digest('hex');
export async function requestWrite<T>(pool:pg.Pool, spec:{actor:string;method:string;path:string;key:unknown;body:unknown;secret:string;authorize?:(c:pg.PoolClient)=>Promise<void>},fn:(c:pg.PoolClient)=>Promise<{status:number;data:T}>) {
  if(typeof spec.key!=='string' || !/^[A-Za-z0-9_-]{16,128}$/.test(spec.key)) throw new BusinessError(422,'IDEMPOTENCY_REQUIRED','请提供有效请求标识');
  const key=spec.key;const hash=bodyHash(spec.body,spec.secret);
  return transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([spec.actor,spec.method,spec.path,key])]);
    await spec.authorize?.(c);
    const previous=await c.query('SELECT body_hash,status,response FROM write_receipts WHERE actor_id=$1 AND method=$2 AND path=$3 AND key=$4',[spec.actor,spec.method,spec.path,key]);
    if(previous.rowCount){const row=previous.rows[0];if(row.body_hash!==hash)throw new BusinessError(409,'IDEMPOTENCY_CONFLICT','同一请求标识对应了不同内容');return {status:row.status as number,data:row.response as T};}
    const result=await fn(c);
    await c.query('INSERT INTO write_receipts(actor_id,method,path,key,body_hash,status,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[spec.actor,spec.method,spec.path,key,hash,result.status,JSON.stringify(result.data)]);
    return result;
  });
}
