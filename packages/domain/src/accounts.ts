import {randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac} from 'node:crypto';
import type {PoolClient} from 'pg';
export class BusinessError extends Error {
  constructor(readonly status:number, readonly code:string, message:string){ super(message); }
}
export function inputObject(value:unknown):Record<string,unknown>{
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new BusinessError(422,'INVALID_INPUT','请检查填写内容');
  return value as Record<string,unknown>;
}
export function exactFields(value:Record<string,unknown>, allowed:string[]){
  if(Object.keys(value).some(key=>!allowed.includes(key))) throw new BusinessError(422,'INVALID_INPUT','包含不支持的字段');
}
export function textField(value:unknown,name:string,min=1,max=80):string{
  if(typeof value!=='string' || value.trim().length<min || value.trim().length>max) throw new BusinessError(422,'INVALID_INPUT',`${name}长度须为${min}～${max}个字符`);
  return value.trim();
}
export function usernameField(value:unknown){
  if(typeof value!=='string') throw new BusinessError(422,'INVALID_INPUT','账号须为3～32位字母、数字或下划线');
  const display=value.normalize('NFKC');
  if(!/^[A-Za-z0-9_]{3,32}$/.test(display)) throw new BusinessError(422,'INVALID_INPUT','账号须为3～32位字母、数字或下划线');
  return {display,key:display.toLowerCase()};
}
export function passwordField(value:unknown):string{
  if(typeof value!=='string' || value.length<12 || value.length>128) throw new BusinessError(422,'INVALID_INPUT','密码长度须为12～128个字符');
  return value;
}
async function derive(password:string,salt:Buffer){
  return new Promise<Buffer>((resolve,reject)=>scryptCb(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024},(e,k)=>e?reject(e):resolve(k)));
}
export async function hashPassword(password:string){const salt=randomBytes(16);const key=await derive(password,salt);return `scrypt$131072$8$1$${salt.toString('hex')}$${key.toString('hex')}`;}
export async function verifyPassword(password:string,stored:string){
  const parts=stored.split('$');
  if(parts.length!==6 || parts.slice(0,4).join('$')!=='scrypt$131072$8$1' || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const candidate=await derive(password,Buffer.from(parts[4],'hex'));return timingSafeEqual(candidate,Buffer.from(parts[5],'hex'));
}
export async function createPersonalRoom(c:PoolClient,ownerId:string){
  await c.query(`WITH created AS (
    INSERT INTO rooms(owner_id,name,scene_version) VALUES($1,'个人小屋','courtyard-v1')
    RETURNING id,name,scene_version
  )
  INSERT INTO room_versions(room_id,version,name,scene_version,placements_json)
  SELECT id,0,name,scene_version,'[]' FROM created`,[ownerId]);
}
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export const csrfFor=(token:string,key:string)=>createHmac('sha256',key).update(`csrf:${token}`).digest('hex');
export function safeEqual(a:unknown,b:string){if(typeof a!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length && timingSafeEqual(left,right);}
export const beijingDay=(at=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
export function userDto(row:Record<string,any>){return {id:row.id,username:row.username_display,nickname:row.nickname,role:row.role};}
export function taskDto(row:Record<string,any>){return {id:row.id,status:row.status==='succeeded'?'succeeded':row.status==='failed'?'failed':'processing',submittedDay:typeof row.submitted_day==='string'?row.submitted_day:beijingDay(row.submitted_day),createdAt:new Date(row.created_at).toISOString(),assetId:row.result_asset_id ?? null,errorCode:row.error_code ?? null};}
export function assetDto(row:Record<string,any>){return {id:row.id,name:row.name,description:row.description,modelFileId:row.model_file_id,originalImageId:row.original_image_id ?? null,createdAt:new Date(row.created_at).toISOString(),normalization:row.normalization,bounds:row.bounds};}
