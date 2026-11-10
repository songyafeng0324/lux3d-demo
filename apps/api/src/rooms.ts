import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import type pg from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BusinessError,csrfFor,inputObject,exactFields,requestWrite,transaction,tokenHash} from '@aholo/domain';
import type {Config} from '@aholo/domain';
import {validGalleryGrant,galleryFile} from './curation.js';
import {validateRoomLayout,type Bounds,type RoomPlacement,type RoomModel,type RoomLikeView,type SharedRoomListing} from '@aholo/contracts';
interface Session {user:Record<string,any>;token:string;hash:string}
interface RoomContext {pool:pg.Pool;config:Config;session:(r:FastifyRequest,write?:boolean)=>Promise<Session>;reauthorize:(c:pg.PoolClient,s:Session)=>Promise<void>}
class RetryRoomLock extends Error {}
class RoomConflict extends BusinessError {constructor(readonly currentVersion:number){super(409,'ROOM_VERSION_CONFLICT','房间已在别处保存或有模型被移除，请载入已确认版本后再编辑');}}
const fail=(status:number,code:string,message:string):never=>{throw new BusinessError(status,code,message);};
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const placementIds=(value:unknown)=>Array.isArray(value)?[...new Set(value.map(v=>v?.assetId).filter(validId))].sort():[];
function cipherToken(token:string,roomId:string,key:string){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),nonce);cipher.setAAD(Buffer.from(roomId));const bytes=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return ['v1',nonce.toString('base64url'),cipher.getAuthTag().toString('base64url'),bytes.toString('base64url')].join('.');}
function decipherToken(value:string,roomId:string,key:string){const [version,iv,tag,data]=value.split('.');if(version!=='v1'||!iv||!tag||!data)throw Error('SHARE_CIPHERTEXT_INVALID');const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from(roomId));decipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');}
const modelFields="jsonb_build_object('id',a.id,'modelFileId',a.model_file_id,'normalization',a.normalization,'bounds',a.bounds,'walkThrough',a.walk_through)";
// A collection can authorize only room versions created after that collection.
// Recollecting the same model cannot restore access through an old share grant.
const roomAssetAllowed = `(a.source_type='furniture' OR (a.source_type='personal' AND a.owner_id=r.owner_id)
 OR EXISTS (SELECT 1 FROM asset_collections ac WHERE ac.collector_id=r.owner_id AND ac.asset_id=a.id AND ac.first_room_version<=v.version))`;
// A single statement keeps room version, nickname and model visibility on the
// same PostgreSQL snapshot, without acquiring room locks before asset locks.
async function roomView(c:pg.Pool|pg.PoolClient,id:string,version?:string|number){return (await c.query(`SELECT r.*,v.name AS saved_name,v.scene_version AS saved_scene,v.placements_json,u.nickname AS owner_nickname,coalesce((SELECT jsonb_agg(${modelFields} ORDER BY a.id) FROM assets a JOIN files f ON f.id=a.model_file_id AND f.state='committed' WHERE a.state='ready' AND ${roomAssetAllowed} AND a.id::text IN (SELECT p->>'assetId' FROM jsonb_array_elements(v.placements_json) p)),'[]'::jsonb) AS models FROM rooms r JOIN room_versions v ON v.room_id=r.id AND v.version=coalesce($2::bigint,r.layout_version) JOIN users u ON u.id=r.owner_id WHERE r.id=$1`,[id,version??null])).rows[0];}
function visibleLayout(row:Record<string,any>){const assets=row.models as RoomModel[],allowed=new Set(assets.map(a=>a.id));return {name:row.saved_name,version:Number(row.layout_version),sceneVersion:row.saved_scene,placements:(row.placements_json as RoomPlacement[]).filter(p=>allowed.has(p.assetId)),assets};}

/** Called with the asset and room rows locked in that order. */
export async function removeRoomAsset(c:pg.PoolClient, room:{id:string;layout_version:string}, assetId:string) {
 const previousVersion=Number(room.layout_version);
 const version=(await c.query('SELECT * FROM room_versions WHERE room_id=$1 AND version=$2',[room.id,room.layout_version])).rows[0];
 const placements=version.placements_json as RoomPlacement[];
 const kept=placements.filter(p=>p.assetId!==assetId);
 const placementsRemoved=placements.length-kept.length;
 if (!placementsRemoved) return {previousVersion,roomVersion:previousVersion,placementsRemoved};
 const roomVersion=previousVersion+1;
 await c.query('INSERT INTO room_versions(room_id,version,name,scene_version,placements_json) VALUES($1,$2,$3,$4,$5)',[room.id,roomVersion,version.name,version.scene_version,JSON.stringify(kept)]);
 await c.query('UPDATE rooms SET layout_version=$2 WHERE id=$1',[room.id,roomVersion]);
 return {previousVersion,roomVersion,placementsRemoved};
}
export function grantCredentials(request:FastifyRequest,id?:string){
 const authorization=request.headers.authorization;const headerId=request.headers['x-snapshot-grant'];
 if(typeof authorization!=='string'||!/^Bearer [a-f0-9]{64}$/.test(authorization))fail(403,'SNAPSHOT_FORBIDDEN','参观凭证无效，请重新进入分享链接');
 const grantId=id??headerId;if(!validId(grantId)||(headerId!==undefined&&headerId!==grantId))fail(403,'SNAPSHOT_FORBIDDEN','参观凭证无效，请重新进入分享链接');return {id:grantId as string,token:authorization!.slice(7)};
}
async function validGrant(c:pg.Pool|pg.PoolClient,id:string,token:string,lock=false){
 const r=(await c.query(`SELECT g.*,r.owner_id FROM snapshot_grants g JOIN rooms r ON r.id=g.scope_id JOIN room_versions v ON v.room_id=g.scope_id AND v.version=g.version WHERE g.id=$1 AND g.token_hash=$2 AND g.kind='room' AND g.expires_at>now() AND r.share_enabled AND r.share_epoch=g.share_epoch AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.placements_json) p LEFT JOIN assets a ON a.id::text=p->>'assetId' WHERE a.id IS NULL OR a.state<>'ready' OR NOT ${roomAssetAllowed}) ${lock?'FOR SHARE OF r':''}`,[id,tokenHash(token)])).rows[0];
 if(!r)fail(404,'SNAPSHOT_UNAVAILABLE','分享已关闭或参观凭证过期，请重新进入分享链接');return r;
}
export function hasSnapshotAuthorization(request:FastifyRequest){return request.headers.authorization!==undefined||request.headers['x-snapshot-grant']!==undefined;}
export async function snapshotFile(pool:pg.Pool,request:FastifyRequest,fileId:string){
 const credentials=grantCredentials(request);
 if((await pool.query("SELECT 1 FROM snapshot_grants WHERE id=$1 AND kind='gallery'",[credentials.id])).rowCount){const row=await galleryFile(pool,credentials.id,credentials.token,fileId);if(!row)fail(404,'NOT_FOUND','未找到该参观文件');return row;}
 // Even a logged-in owner must stay inside the supplied grant's file scope.
 const row=(await pool.query(`SELECT f.* FROM snapshot_grants g JOIN rooms r ON r.id=g.scope_id JOIN room_versions v ON v.room_id=g.scope_id AND v.version=g.version JOIN LATERAL jsonb_array_elements(v.placements_json) p ON true JOIN assets a ON a.id::text=p->>'assetId' AND a.state='ready' JOIN files f ON f.id=a.model_file_id AND f.state='committed' WHERE g.id=$1 AND g.token_hash=$2 AND g.kind='room' AND g.expires_at>now() AND r.share_enabled AND r.share_epoch=g.share_epoch AND ${roomAssetAllowed} AND f.id=$3 LIMIT 1`,[credentials.id,tokenHash(credentials.token),fileId])).rows[0];if(!row)fail(404,'NOT_FOUND','未找到该参观文件');return row;
}
export async function registerRoomRoutes(app:FastifyInstance,ctx:RoomContext){
 const {pool,config,session,reauthorize}=ctx;
 const envelope=(r:FastifyRequest,data:unknown)=>({data,requestId:r.id});
 const sharePath=(id:string,ciphertext:string)=>'/shared/'+decipherToken(ciphertext,id,config.appDataKey);
 const shareUrl=(r:Record<string,any>)=>r.share_token_ciphertext?new URL(sharePath(r.id,r.share_token_ciphertext),config.publicOrigin).href:null;
 async function ownerRoom(c:pg.Pool|pg.PoolClient,owner:string,lock=false){const r=(await c.query(`SELECT * FROM rooms WHERE owner_id=$1 ${lock?'FOR UPDATE':''}`,[owner])).rows[0];if(!r)fail(404,'NOT_FOUND','未找到个人小屋');return r;}
 app.get('/api/v1/rooms/me',async request=>{const s=await session(request);const room=await ownerRoom(pool,s.user.id);const view=await roomView(pool,room.id);return envelope(request,{id:view.id,...visibleLayout(view),shareEnabled:view.share_enabled,shareUrl:shareUrl(view)});});
 app.get('/api/v1/rooms/discover',async(request,reply)=>{
  await session(request);
  const rows=(await pool.query(`SELECT r.id,r.name,r.share_token_ciphertext,u.nickname,
    (SELECT count(*)::int FROM room_likes l WHERE l.room_id=r.id) AS popularity
    FROM rooms r JOIN users u ON u.id=r.owner_id
    WHERE r.share_enabled ORDER BY popularity DESC,u.created_at,r.id`)).rows;
  const items:SharedRoomListing[]=rows.map(r=>({
    id:r.id,name:r.name,ownerNickname:r.nickname,popularity:r.popularity,shareUrl:sharePath(r.id,r.share_token_ciphertext),
  }));
  reply.header('Cache-Control','private, no-store');
  return envelope(request,{items});
 });
 app.put('/api/v1/rooms/me/layout',{bodyLimit:64*1024*1024},async(request,reply)=>{
  const s=await session(request,true),body=inputObject(request.body);exactFields(body,['baseVersion','editSequence','name','placements']);
  if(!Number.isSafeInteger(body.baseVersion)||(body.baseVersion as number)<0||!Number.isSafeInteger(body.editSequence)||(body.editSequence as number)<0)fail(422,'INVALID_LAYOUT','布局版本或编辑序号无效');
  const newIds=placementIds(body.placements);let lockedRoom:Record<string,any>|undefined;let models=new Map<string,Bounds>();
  for(let retry=0;retry<4;retry++)try{
   const result=await requestWrite(pool,{actor:s.user.id,method:'PUT',path:'/api/v1/rooms/me/layout',key:request.headers['idempotency-key'],body,secret:config.appDataKey,authorize:async c=>{
    await reauthorize(c,s);const discovered=await ownerRoom(c,s.user.id);const old=(await c.query('SELECT placements_json FROM room_versions WHERE room_id=$1 AND version=$2',[discovered.id,discovered.layout_version])).rows[0];const ids=[...new Set([...newIds,...placementIds(old.placements_json)])].sort();
    const rows=(await c.query(`SELECT a.*,f.state AS file_state,ac.id AS collection_id FROM assets a
      LEFT JOIN files f ON f.id=a.model_file_id LEFT JOIN asset_collections ac ON ac.asset_id=a.id AND ac.collector_id=$2
      WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a`,[ids,s.user.id])).rows;
    lockedRoom=await ownerRoom(c,s.user.id,true);const latest=(await c.query('SELECT placements_json FROM room_versions WHERE room_id=$1 AND version=$2',[lockedRoom!.id,lockedRoom!.layout_version])).rows[0];if(placementIds(latest.placements_json).some(id=>!ids.includes(id)))throw new RetryRoomLock();
    models=new Map();for(const id of newIds){const a=rows.find(r=>r.id===id);if(!a||a.state!=='ready'||a.file_state!=='committed'||!(a.collection_id||a.source_type==='furniture'||(a.source_type==='personal'&&a.owner_id===s.user.id))){
     // A collection removal or risk deletion can advance the room version. A stale draft then reports a
     // version conflict, so the editor offers the confirmed (cleaned) layout instead of a dead-end 422.
     if(Number(lockedRoom!.layout_version)!==body.baseVersion)throw new RoomConflict(Number(lockedRoom!.layout_version));
     fail(422,'INVALID_LAYOUT','模型不可用或没有摆放权限');}models.set(id,a.bounds);}
    const error=validateRoomLayout(body.name,body.placements,models);if(error)fail(422,'INVALID_LAYOUT',error);
   }},async c=>{
    const current=lockedRoom!;if(Number(current.layout_version)!==body.baseVersion)throw new RoomConflict(Number(current.layout_version));const next=Number(current.layout_version)+1;const name=(body.name as string).trim();
    await c.query('INSERT INTO room_versions(room_id,version,name,scene_version,placements_json) VALUES($1,$2,$3,$4,$5)',[current.id,next,name,current.scene_version,JSON.stringify(body.placements)]);
    await c.query('UPDATE rooms SET layout_version=$2,name=$3 WHERE id=$1',[current.id,next,name]);return {status:200,data:{savedVersion:next,editSequence:body.editSequence}};
   });reply.code(result.status);return envelope(request,result.data);
  }catch(error){if(error instanceof RetryRoomLock)continue;throw error;}
  return fail(409,'ROOM_BUSY','房间正在更新，请重试当前保存');
 });
 app.put('/api/v1/rooms/me/share',async(request,reply)=>{
  const s=await session(request,true),body=inputObject(request.body);exactFields(body,['enabled']);if(typeof body.enabled!=='boolean')fail(422,'INVALID_INPUT','分享状态无效');
  const result=await requestWrite(pool,{actor:s.user.id,method:'PUT',path:'/api/v1/rooms/me/share',key:request.headers['idempotency-key'],body,secret:config.appDataKey,authorize:async c=>{await reauthorize(c,s);await ownerRoom(c,s.user.id,true);}},async c=>{
   let room=await ownerRoom(c,s.user.id);if(body.enabled&&!room.share_token_hash){const token=randomBytes(32).toString('hex');room=(await c.query('UPDATE rooms SET share_token_hash=$2,share_token_ciphertext=$3 WHERE id=$1 RETURNING *',[room.id,tokenHash(token),cipherToken(token,room.id,config.appDataKey)])).rows[0];}
   if(room.share_enabled!==body.enabled)await c.query('UPDATE rooms SET share_enabled=$2,share_epoch=share_epoch+1 WHERE id=$1',[room.id,body.enabled]);
   // Receipts never store a plaintext share token or URL. The stable encrypted
   // token plus this presence flag reconstruct exactly the original response.
   return {status:200,data:{enabled:body.enabled,hasShareUrl:Boolean(room.share_token_ciphertext)}};
  });const room=await ownerRoom(pool,s.user.id);reply.code(result.status);return envelope(request,{enabled:result.data.enabled,shareUrl:result.data.hasShareUrl?shareUrl(room):null});
 });
 app.get('/api/v1/shared-rooms/:token',async(request,reply)=>{
  const token=(request.params as {token:string}).token;if(!/^[a-f0-9]{64}$/.test(token))fail(404,'SHARE_UNAVAILABLE','分享链接不可用');
  const data=await transaction(pool,async c=>{const r=(await c.query('SELECT id,layout_version,share_epoch FROM rooms WHERE share_token_hash=$1 AND share_enabled FOR SHARE',[tokenHash(token)])).rows[0];if(!r)fail(404,'SHARE_UNAVAILABLE','分享已关闭或链接不存在');const view=await roomView(c,r.id,r.layout_version);const grantToken=randomBytes(32).toString('hex'),grantId=randomUUID();const grant=(await c.query("INSERT INTO snapshot_grants(id,token_hash,kind,scope_id,version,share_epoch,expires_at) VALUES($1,$2,'room',$3,$4,$5,now()+interval '24 hours') RETURNING expires_at",[grantId,tokenHash(grantToken),r.id,r.layout_version,r.share_epoch])).rows[0];return {...visibleLayout(view),version:Number(r.layout_version),ownerNickname:view.owner_nickname,grant:{id:grantId,token:grantToken,expiresAt:new Date(grant.expires_at).toISOString()}};});reply.header('Cache-Control','private, no-store');return envelope(request,data);
 });
 app.get('/api/v1/snapshots/:grant/room-like',async(request,reply)=>{
  const credentials=grantCredentials(request,(request.params as {grant:string}).grant);
  const viewer=await session(request).catch(error=>{
    if(error instanceof BusinessError && error.status===401)return null;
    throw error;
  });
  const grant=await validGrant(pool,credentials.id,credentials.token);
  const {popularity,liked}=(await pool.query(`SELECT count(*)::int AS popularity,
    coalesce(bool_or(voter_id=$2),false) AS liked FROM room_likes WHERE room_id=$1`,
    [grant.scope_id,viewer?.user.id??null])).rows[0];
  const view:RoomLikeView=!viewer?{popularity,state:'guest'}
    :viewer.user.id===grant.owner_id?{popularity,state:'owner'}
    :liked?{popularity,state:'liked'}
    :{popularity,state:'available',csrfToken:csrfFor(viewer.token,config.appDataKey)};
  reply.header('Cache-Control','private, no-store');
  return envelope(request,view);
 });
 app.put('/api/v1/snapshots/:grant/room-like',async(request,reply)=>{
  const voter=await session(request,true);
  const credentials=grantCredentials(request,(request.params as {grant:string}).grant);
  if(request.body!==undefined)exactFields(inputObject(request.body),[]);
  let roomId:string;
  const result=await requestWrite(pool,{
    actor:voter.user.id,method:'PUT',path:`/api/v1/snapshots/${credentials.id}/room-like`,
    key:request.headers['idempotency-key'],body:{},secret:config.appDataKey,
    authorize:async c=>{
      await reauthorize(c,voter);
      // The room lock orders a like against closing or reopening the share.
      const grant=await validGrant(c,credentials.id,credentials.token,true);
      if(grant.owner_id===voter.user.id)fail(403,'ROOM_SELF_LIKE','不能给自己的小屋点赞');
      roomId=grant.scope_id;
    },
  },async c=>{
    await c.query('INSERT INTO room_likes(room_id,voter_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[roomId,voter.user.id]);
    return {status:200,data:{roomId}};
  });
  const {popularity}=(await pool.query('SELECT count(*)::int AS popularity FROM room_likes WHERE room_id=$1',[result.data.roomId])).rows[0];
  reply.header('Cache-Control','private, no-store');
  return envelope(request,{popularity});
 });
 app.post('/api/v1/snapshots/:grant/renew',async(request,reply)=>{
  const credentials=grantCredentials(request,(request.params as {grant:string}).grant);
  if(request.body!==undefined)exactFields(inputObject(request.body),[]);
  const result=await requestWrite(pool,{actor:`grant:${credentials.id}`,method:'POST',path:`/api/v1/snapshots/${credentials.id}/renew`,key:request.headers['idempotency-key'],body:{},secret:config.appDataKey,authorize:async c=>{const kind=(await c.query('SELECT kind FROM snapshot_grants WHERE id=$1',[credentials.id])).rows[0]?.kind;if(kind==='gallery')await validGalleryGrant(c,credentials.id,credentials.token);else await validGrant(c,credentials.id,credentials.token,true);}},async c=>{const row=(await c.query("UPDATE snapshot_grants SET expires_at=now()+interval '24 hours' WHERE id=$1 RETURNING expires_at",[credentials.id])).rows[0];return {status:200,data:{id:credentials.id,expiresAt:new Date(row.expires_at).toISOString()}};});reply.header('Cache-Control','private, no-store');return envelope(request,{grant:{...result.data,token:credentials.token}});
 });
}
