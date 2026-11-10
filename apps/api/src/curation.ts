import {randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {BusinessError,inputObject,exactFields,textField,requestWrite,transaction,tokenHash,beijingDay,publicFieldsInput,PUBLIC_FIELDS} from '@aholo/domain';
import type {Config} from '@aholo/domain';
import {validateGallerySlots,GALLERY_SLOT_COUNT,DEFAULT_DAILY_QUOTA,type GalleryView,type ExhibitDetail,type PublicDetails,type CollectedAsset,type ExhibitCollectionStatus} from '@aholo/contracts';
import {grantCredentials,removeRoomAsset} from './rooms.js';
interface Session {user:Record<string,any>;token:string;hash:string}
interface Context {pool:pg.Pool;config:Config;session:(r:FastifyRequest,write?:boolean)=>Promise<Session>;reauthorize:(c:pg.PoolClient,s:Session,admin?:boolean)=>Promise<void>}
type Db=pg.Pool|pg.PoolClient;
const fail=(status:number,code:string,message:string):never=>{throw new BusinessError(status,code,message);};
const isId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const uuid=(v:unknown)=>isId(v)?v:fail(404,'NOT_FOUND','未找到该资源');
const iso=(v:unknown)=>v?new Date(v as string).toISOString():null;
const QUOTA_MAX=1000;
const modelOf=(r:Record<string,any>)=>({id:r.asset_id??r.id,modelFileId:r.model_file_id,normalization:r.normalization,bounds:r.bounds});
const STATUS_TEXT:Record<string,string>={approved:'该申请已通过审核',rejected:'该申请已被驳回',withdrawn:'该申请已撤回',deleted:'该模型已被删除'};

/** Keyset cursor over (timestamp,id). */
/** Keyset cursor at PostgreSQL microsecond precision; a JS Date (milliseconds) would skip or repeat rows. */
const cursorAt=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
function cursorOf(request:FastifyRequest){const raw=(request.query as Record<string,unknown>).cursor;if(raw===undefined)return null;if(typeof raw!=='string'||raw.length>300)fail(422,'INVALID_CURSOR','分页标识不正确');try{const [at,id]=JSON.parse(Buffer.from(raw as string,'base64url').toString());if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)||!isId(id))throw Error();return {at,id:id as string};}catch{return fail(422,'INVALID_CURSOR','分页标识不正确');}}
function page<T>(rows:Record<string,any>[],limit:number,dto:(r:Record<string,any>)=>T){const items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(dto),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([last.cursor_at,last.id])).toString('base64url'):null};}
function query(request:FastifyRequest,name:string,max=80){const v=(request.query as Record<string,unknown>)[name];if(v===undefined||v==='')return null;if(typeof v!=='string'||v.length>max)fail(422,'INVALID_INPUT','查询条件不正确');return v as string;}

function submissionDto(r:Record<string,any>){return {id:r.id,assetId:r.asset_id,status:r.status as string,submittedAt:iso(r.submitted_at),reviewedAt:iso(r.reviewed_at),rejectionReason:r.rejection_reason??null,publicSnapshot:r.public_snapshot?.redacted?null:r.public_snapshot as PublicDetails,assetName:r.asset_name??null,candidateId:r.candidate_id??null,slotNo:r.slot_no??null};}
async function quotaOf(c:Db,userId:string){const day=beijingDay();const r=(await c.query('SELECT override_total,used_net FROM quota_days WHERE user_id=$1 AND quota_day=$2',[userId,day])).rows[0];const total=r?.override_total??DEFAULT_DAILY_QUOTA,used=r?.used_net??0;return {day,total,used,available:Math.max(0,total-used),adjusted:r?.override_total!=null};}

/**
 * Publishes a whole immutable gallery version from the given 30-slot arrangement.
 * Caller must hold the gallery row lock and the asset locks of every newly referenced candidate.
 */
export async function publishGallery(c:pg.PoolClient,slots:Array<{slotNo:number;candidateId:string|null}>){
 const ids=slots.map(s=>s.candidateId).filter(isId);
 const rows=ids.length?(await c.query("SELECT c.id,c.public_snapshot,a.id AS asset_id,a.model_file_id,a.normalization,a.bounds FROM candidates c JOIN assets a ON a.id=c.asset_id AND a.state='ready' JOIN files f ON f.id=a.model_file_id AND f.state='committed' WHERE c.id=ANY($1::uuid[])",[ids])).rows:[];
 if(rows.length!==ids.length)fail(422,'CANDIDATE_UNAVAILABLE','所选候选已不存在或模型不可用，请刷新后重新安排');
 const details:Record<string,unknown>={};for(const r of rows)details[r.id]={assetId:r.asset_id,model:modelOf(r),snapshot:r.public_snapshot};
 const ordered=[...slots].sort((a,b)=>a.slotNo-b.slotNo);
 await c.query('UPDATE exhibit_slots SET candidate_id=NULL WHERE candidate_id IS NOT NULL');
 for(const s of ordered)if(s.candidateId)await c.query('UPDATE exhibit_slots SET candidate_id=$2 WHERE slot_no=$1',[s.slotNo,s.candidateId]);
 const next=Number((await c.query('SELECT version FROM gallery WHERE singleton_id=1')).rows[0].version)+1;
 await c.query('INSERT INTO gallery_versions(version,slots_json,details_json) VALUES($1,$2,$3)',[next,JSON.stringify(ordered.map(s=>({slotNo:s.slotNo,candidateId:s.candidateId}))),JSON.stringify(details)]);
 await c.query('UPDATE gallery SET version=$1 WHERE singleton_id=1',[next]);
 return next;
}
async function currentSlots(c:Db){return (await c.query('SELECT slot_no,candidate_id FROM exhibit_slots ORDER BY slot_no')).rows.map(r=>({slotNo:Number(r.slot_no),candidateId:r.candidate_id as string|null}));}

/** Gallery grant check used by details, files and renewal: unexpired and still eligible (no exhibit of that version deleted). */
/** Renewal requires every exhibit of that version still eligible; a detail read only needs its own exhibit. */
export async function validGalleryGrant(c:Db,id:string,token:string,requireAll=true){
 const g=(await c.query(`SELECT g.*,v.slots_json,v.details_json FROM snapshot_grants g JOIN gallery_versions v ON v.version=g.gallery_version WHERE g.id=$1 AND g.token_hash=$2 AND g.kind='gallery' AND g.expires_at>now()
  AND (NOT $3::boolean OR NOT EXISTS(SELECT 1 FROM jsonb_each(v.details_json) d LEFT JOIN assets a ON a.id::text=d.value->>'assetId' WHERE a.id IS NULL OR a.state<>'ready'))`,[id,tokenHash(token),requireAll])).rows[0];
 if(!g)fail(404,'SNAPSHOT_UNAVAILABLE','参观凭证已过期或展陈已更新，请刷新后重新进入');return g;
}
export async function galleryFile(pool:pg.Pool,id:string,token:string,fileId:string){
 return (await pool.query(`SELECT f.* FROM snapshot_grants g JOIN gallery_versions v ON v.version=g.gallery_version JOIN LATERAL jsonb_each(v.details_json) d ON true JOIN assets a ON a.id::text=d.value->>'assetId' AND a.state='ready' JOIN files f ON f.id=a.model_file_id AND f.state='committed'
  WHERE g.id=$1 AND g.token_hash=$2 AND g.kind='gallery' AND g.expires_at>now() AND f.id=$3 LIMIT 1`,[id,tokenHash(token),fileId])).rows[0];
}

async function exhibitCollectionStatus(c:Db, candidateId:string, userId:string):Promise<ExhibitCollectionStatus> {
 const row=(await c.query(`SELECT (a.source_type='personal' AND a.owner_id=$2) AS owned,
   ac.id IS NOT NULL AS collected,e.slot_no IS NOT NULL AS on_display
   FROM candidates c JOIN assets a ON a.id=c.asset_id AND a.state='ready'
   JOIN files f ON f.id=a.model_file_id AND f.state='committed'
   LEFT JOIN asset_collections ac ON ac.asset_id=a.id AND ac.collector_id=$2
   LEFT JOIN exhibit_slots e ON e.candidate_id=c.id WHERE c.id=$1`,[candidateId,userId])).rows[0];
 if (row?.owned) return 'owned';
 if (row?.collected) return 'collected';
 return row?.on_display ? 'available' : 'unavailable';
}

export async function registerCurationRoutes(app:FastifyInstance,{pool,config,session,reauthorize}:Context){
 const ok=(request:FastifyRequest,data:unknown)=>({data,requestId:request.id});
 const send=(reply:FastifyReply,request:FastifyRequest,result:{status:number;data:unknown})=>{reply.code(result.status);return result.status===204?reply.send():ok(request,result.data);};
 const path=(request:FastifyRequest)=>request.url.split('?')[0];
 async function admin(request:FastifyRequest,write=false){const s=await session(request,write);if(s.user.role!=='admin')fail(403,'FORBIDDEN','没有管理权限');return s;}
 const lockAsset=async(c:pg.PoolClient,id:string)=>(await c.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[id])).rows[0] as Record<string,any>|undefined;

 // ---- User submissions (F06) ----
 app.post('/api/v1/assets/:id/submissions',async(request,reply)=>{
  const s=await session(request,true),id=uuid((request.params as {id:string}).id),b=inputObject(request.body);exactFields(b,[...PUBLIC_FIELDS]);const fields=publicFieldsInput(b);
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'POST',path:path(request),key:request.headers['idempotency-key'],body:b,secret:config.appDataKey,authorize:async c=>{
   await reauthorize(c,s);const a=await lockAsset(c,id);if(!a||a.state!=='ready'||a.source_type!=='personal'||a.owner_id!==s.user.id)fail(404,'NOT_FOUND','未找到该藏品');
  }},async c=>{
   if((await c.query('SELECT 1 FROM active_publications WHERE asset_id=$1',[id])).rowCount)fail(409,'SUBMISSION_ACTIVE','该模型已有待审核申请或已是候选藏品，不能重复申请');
   const nickname=(await c.query('SELECT nickname FROM users WHERE id=$1',[s.user.id])).rows[0].nickname as string;
   const row=(await c.query("INSERT INTO submissions(id,asset_id,user_id,public_snapshot) VALUES($1,$2,$3,$4) RETURNING *",[randomUUID(),id,s.user.id,JSON.stringify({...fields,sourceNickname:nickname})])).rows[0];
   await c.query('INSERT INTO active_publications(asset_id,submission_id) VALUES($1,$2)',[id,row.id]);
   return {status:201,data:submissionDto(row)};
  }));
 });
 app.get('/api/v1/submissions',async request=>{
  const s=await session(request),assetId=query(request,'assetId'),cursor=cursorOf(request);if(assetId)uuid(assetId);
  const args:unknown[]=[s.user.id,assetId];let where='s.user_id=$1 AND ($2::uuid IS NULL OR s.asset_id=$2)';if(cursor){args.push(cursor.at,cursor.id);where+=' AND (s.submitted_at,s.id)<($3::timestamptz,$4::uuid)';}
  const rows=(await pool.query(`SELECT s.*,${cursorAt('s.submitted_at')},a.name AS asset_name,c.id AS candidate_id,e.slot_no FROM submissions s JOIN assets a ON a.id=s.asset_id LEFT JOIN candidates c ON c.submission_id=s.id LEFT JOIN exhibit_slots e ON e.candidate_id=c.id WHERE ${where} ORDER BY s.submitted_at DESC,s.id DESC LIMIT 51`,args)).rows;
  return ok(request,page(rows,50,submissionDto));
 });
 app.post('/api/v1/submissions/:id/withdraw',async(request,reply)=>{
  const s=await session(request,true),id=uuid((request.params as {id:string}).id);if(request.body!==undefined&&request.body!==null)exactFields(inputObject(request.body),[]);
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'POST',path:path(request),key:request.headers['idempotency-key'],body:{},secret:config.appDataKey,authorize:async c=>{
   await reauthorize(c,s);const sub=(await c.query('SELECT asset_id FROM submissions WHERE id=$1 AND user_id=$2',[id,s.user.id])).rows[0];if(!sub)fail(404,'NOT_FOUND','未找到该申请');
   await lockAsset(c,sub.asset_id);
  }},async c=>{
   const sub=(await c.query('SELECT * FROM submissions WHERE id=$1 FOR UPDATE',[id])).rows[0];if(sub.status!=='pending')fail(409,'SUBMISSION_NOT_PENDING',STATUS_TEXT[sub.status]??'该申请已处理');
   await c.query('DELETE FROM active_publications WHERE submission_id=$1',[id]);
   const row=(await c.query("UPDATE submissions SET status='withdrawn' WHERE id=$1 RETURNING *",[id])).rows[0];
   return {status:200,data:submissionDto(row)};
  }));
 });

 // ---- Review (F07): earliest first, approve or reject only, never edits the submitted data ----
 app.get('/api/v1/admin/submissions',async request=>{
  await admin(request);const status=query(request,'status')??'pending';if(!['pending','approved','rejected','withdrawn','deleted','all'].includes(status))fail(422,'INVALID_INPUT','状态筛选不正确');
  const cursor=cursorOf(request),asc=status==='pending',args:unknown[]=[status];let where="($1='all' OR s.status=$1)";
  if(cursor){args.push(cursor.at,cursor.id);where+=` AND (s.submitted_at,s.id)${asc?'>':'<'}($2::timestamptz,$3::uuid)`;}
  const rows=(await pool.query(`SELECT s.*,${cursorAt('s.submitted_at')},a.name AS asset_name,a.model_file_id,a.original_image_id,a.normalization,a.bounds,a.state AS asset_state,u.username_display,u.nickname AS current_nickname FROM submissions s JOIN assets a ON a.id=s.asset_id JOIN users u ON u.id=s.user_id WHERE ${where} ORDER BY s.submitted_at ${asc?'ASC':'DESC'},s.id ${asc?'ASC':'DESC'} LIMIT 51`,args)).rows;
  return ok(request,page(rows,50,r=>({...submissionDto(r),applicant:{id:r.user_id,username:r.username_display,currentNickname:r.current_nickname},model:r.asset_state==='ready'?{id:r.asset_id,modelFileId:r.model_file_id,normalization:r.normalization,bounds:r.bounds}:null,originalImageId:r.asset_state==='ready'?r.original_image_id:null})));
 });
 app.post('/api/v1/admin/submissions/:id/review',async(request,reply)=>{
  const s=await admin(request,true),id=uuid((request.params as {id:string}).id),b=inputObject(request.body);exactFields(b,['decision','reason']);
  if(b.decision!=='approve'&&b.decision!=='reject')fail(422,'INVALID_INPUT','只能通过或驳回');
  const reason=b.decision==='reject'?textField(b.reason,'驳回原因',1,500):null;if(b.decision==='approve'&&b.reason!==undefined&&b.reason!==null&&b.reason!=='')fail(422,'INVALID_INPUT','通过时不填写驳回原因');
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'POST',path:path(request),key:request.headers['idempotency-key'],body:b,secret:config.appDataKey,authorize:async c=>{
   await reauthorize(c,s,true);const sub=(await c.query('SELECT asset_id FROM submissions WHERE id=$1',[id])).rows[0];if(!sub)fail(404,'NOT_FOUND','未找到该申请');await lockAsset(c,sub.asset_id);
  }},async c=>{
   const sub=(await c.query('SELECT s.*,a.state AS asset_state FROM submissions s JOIN assets a ON a.id=s.asset_id WHERE s.id=$1 FOR UPDATE OF s',[id])).rows[0];
   if(sub.status!=='pending')fail(409,'SUBMISSION_NOT_PENDING',STATUS_TEXT[sub.status]??'该申请已处理');if(sub.asset_state!=='ready')fail(409,'SUBMISSION_NOT_PENDING','该模型已被删除');
   let candidateId:string|null=null;
   if(b.decision==='approve'){
    candidateId=randomUUID();
    await c.query("INSERT INTO candidates(id,asset_id,submission_id,source,public_snapshot) VALUES($1,$2,$3,'user',$4)",[candidateId,sub.asset_id,id,JSON.stringify(sub.public_snapshot)]);
    // One statement moves the occupancy from the submission to its candidate (CHECK: exactly one).
    const moved=await c.query('UPDATE active_publications SET submission_id=NULL,candidate_id=$2 WHERE submission_id=$1',[id,candidateId]);if(moved.rowCount!==1)throw new Error('PUBLICATION_OCCUPANCY_MISSING');
   } else await c.query('DELETE FROM active_publications WHERE submission_id=$1',[id]);
   const row=(await c.query('UPDATE submissions SET status=$2,rejection_reason=$3,reviewed_at=now(),reviewed_by=$4 WHERE id=$1 RETURNING *',[id,b.decision==='approve'?'approved':'rejected',reason,s.user.id])).rows[0];
   return {status:200,data:{...submissionDto(row),candidateId}};
  }));
 });

 // ---- Candidates and the fixed 30 slots (F08) ----
 app.get('/api/v1/admin/candidates',async request=>{
  await admin(request);
  const rows=(await pool.query("SELECT c.*,a.model_file_id,a.normalization,a.bounds,e.slot_no,u.username_display FROM candidates c JOIN assets a ON a.id=c.asset_id AND a.state='ready' LEFT JOIN exhibit_slots e ON e.candidate_id=c.id LEFT JOIN submissions s ON s.id=c.submission_id LEFT JOIN users u ON u.id=s.user_id ORDER BY c.created_at DESC,c.id DESC")).rows;
  return ok(request,{items:rows.map(r=>({id:r.id,assetId:r.asset_id,source:r.source,publicSnapshot:r.public_snapshot,slotNo:r.slot_no??null,applicantUsername:r.username_display??null,createdAt:iso(r.created_at),model:modelOf(r)})),nextCursor:null});
 });
 app.get('/api/v1/admin/gallery',async request=>{await admin(request);return ok(request,await transaction(pool,async c=>({version:Number((await c.query('SELECT version FROM gallery WHERE singleton_id=1 FOR SHARE')).rows[0].version),slots:await currentSlots(c)})));});
 app.put('/api/v1/admin/gallery',async(request,reply)=>{
  const s=await admin(request,true),b=inputObject(request.body);exactFields(b,['baseVersion','slots']);
  if(!Number.isSafeInteger(b.baseVersion)||(b.baseVersion as number)<0)fail(422,'INVALID_INPUT','展陈版本无效');const error=validateGallerySlots(b.slots);if(error)fail(422,'INVALID_GALLERY',error);
  const slots=(b.slots as Array<{slotNo:number;candidateId:string|null}>).map(x=>({slotNo:x.slotNo,candidateId:x.candidateId?x.candidateId.toLowerCase():null}));const ids=slots.map(x=>x.candidateId).filter(isId);
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'PUT',path:path(request),key:request.headers['idempotency-key'],body:b,secret:config.appDataKey,authorize:async c=>{
   await reauthorize(c,s,true);
   // Lock order: assets (sorted) → gallery. A risk delete holds the asset lock before it touches candidates/slots.
   const assets=ids.length?(await c.query('SELECT asset_id FROM candidates WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.asset_id as string).sort():[];
   if(assets.length!==ids.length)fail(422,'CANDIDATE_UNAVAILABLE','所选候选已不存在，请刷新后重新安排');
   if(assets.length)await c.query('SELECT id FROM assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[assets]);
   await c.query('SELECT version FROM gallery WHERE singleton_id=1 FOR UPDATE');
  }},async c=>{
   const current=Number((await c.query('SELECT version FROM gallery WHERE singleton_id=1')).rows[0].version);
   if(current!==b.baseVersion)throw Object.assign(new BusinessError(409,'GALLERY_VERSION_CONFLICT','展陈已被其他操作更新，请载入最新安排后再保存'),{currentVersion:current});
   return {status:200,data:{publishedVersion:await publishGallery(c,slots)}};
  }));
 });

 // ---- Public gallery snapshot (F09) ----
 app.get('/api/v1/gallery',async(request,reply)=>{
  const data:GalleryView=await transaction(pool,async c=>{
   const g=(await c.query('SELECT g.version,v.slots_json,v.details_json FROM gallery g JOIN gallery_versions v ON v.version=g.version WHERE g.singleton_id=1 FOR SHARE OF g')).rows[0];
   const ready=new Set((await c.query("SELECT a.id::text FROM assets a JOIN files f ON f.id=a.model_file_id AND f.state='committed' WHERE a.state='ready' AND a.id::text IN (SELECT d.value->>'assetId' FROM jsonb_each($1::jsonb) d)",[JSON.stringify(g.details_json)])).rows.map(r=>r.id));
   const token=randomBytes(32).toString('hex'),id=randomUUID(),version=Number(g.version);
   const grant=(await c.query("INSERT INTO snapshot_grants(id,token_hash,kind,version,gallery_version,expires_at) VALUES($1,$2,'gallery',$3,$3,now()+interval '24 hours') RETURNING expires_at",[id,tokenHash(token),version])).rows[0];
   const slots=(g.slots_json as Array<{slotNo:number;candidateId:string|null}>).map(x=>{const d=x.candidateId?g.details_json[x.candidateId]:null;return {slotNo:x.slotNo,exhibit:d&&ready.has(d.assetId)?{candidateId:x.candidateId!,name:d.snapshot.name,model:d.model}:null};});
   return {version,slots,grant:{id,token,expiresAt:new Date(grant.expires_at).toISOString()}};
  });reply.header('Cache-Control','private, no-store');return ok(request,data);
 });
 app.get('/api/v1/snapshots/:grant/details/:candidateId',async(request,reply)=>{
  const params=request.params as {grant:string;candidateId:string};const credentials=grantCredentials(request,params.grant);const candidateId=uuid(params.candidateId);
  const g=await validGalleryGrant(pool,credentials.id,credentials.token,false);const d=g.details_json[candidateId];const slot=(g.slots_json as Array<{slotNo:number;candidateId:string|null}>).find(x=>x.candidateId===candidateId);
  if(!d||!slot)fail(404,'NOT_FOUND','该展位没有此藏品');
  const asset=(await pool.query("SELECT a.source_type FROM assets a JOIN files f ON f.id=a.model_file_id AND f.state='committed' WHERE a.id=$1 AND a.state='ready'",[d.assetId])).rows[0];
  if(!asset)fail(404,'NOT_FOUND','该藏品已不可查看');
  const detail:ExhibitDetail={...(d.snapshot as PublicDetails),candidateId,slotNo:slot!.slotNo,model:d.model,source:asset.source_type==='official_candidate'?'official':'user'};reply.header('Cache-Control','private, no-store');return ok(request,detail);
 });

 app.get('/api/v1/collections',async(request,reply)=>{
  const s=await session(request),cursor=cursorOf(request);
  const rows=(await pool.query(`SELECT ac.id,${cursorAt('ac.created_at')},a.id AS asset_id,a.model_file_id,a.normalization,a.bounds,
    c.public_snapshot->>'name' AS name,CASE WHEN c.source='official' THEN '官方馆藏' ELSE u.nickname END AS author_nickname
    FROM asset_collections ac JOIN assets a ON a.id=ac.asset_id AND a.state='ready'
    JOIN files f ON f.id=a.model_file_id AND f.state='committed'
    JOIN candidates c ON c.asset_id=a.id LEFT JOIN users u ON u.id=a.owner_id
    WHERE ac.collector_id=$1 ${cursor?'AND (ac.created_at,ac.id)<($2::timestamptz,$3::uuid)':''}
    ORDER BY ac.created_at DESC,ac.id DESC LIMIT 51`,cursor?[s.user.id,cursor.at,cursor.id]:[s.user.id])).rows;
  reply.header('Cache-Control','private, no-store');
  return ok(request,page<CollectedAsset>(rows,50,r=>({...modelOf(r),collectionId:r.id,name:r.name,authorNickname:r.author_nickname})));
 });

 app.get('/api/v1/gallery/exhibits/:id/collection',async(request,reply)=>{
  const s=await session(request),id=uuid((request.params as {id:string}).id);
  reply.header('Cache-Control','private, no-store');
  return ok(request,{status:await exhibitCollectionStatus(pool,id,s.user.id)});
 });

 app.post('/api/v1/gallery/exhibits/:id/collection',async(request,reply)=>{
  const s=await session(request,true),id=uuid((request.params as {id:string}).id),credentials=grantCredentials(request);
  if(request.body!==undefined)exactFields(inputObject(request.body),[]);
  await requestWrite(pool,{actor:s.user.id,method:'POST',path:path(request),key:request.headers['idempotency-key'],body:{},secret:config.appDataKey,authorize:c=>reauthorize(c,s)},async c=>{
   const grant=await validGalleryGrant(c,credentials.id,credentials.token,false);
   const exhibit=grant.details_json[id];
   if (!exhibit) return fail(404,'NOT_FOUND','该展品不在当前参观凭证中');
   const asset=await lockAsset(c,exhibit.assetId);
   if (asset?.state!=='ready') return fail(404,'NOT_FOUND','该藏品已不可收藏');
   const room=(await c.query('SELECT layout_version FROM rooms WHERE owner_id=$1 FOR UPDATE',[s.user.id])).rows[0];
   if (!room) return fail(404,'NOT_FOUND','未找到个人小屋');
   // A gallery publish can remove this slot without locking the outgoing asset.
   await c.query('SELECT version FROM gallery WHERE singleton_id=1 FOR SHARE');
   const status=await exhibitCollectionStatus(c,id,s.user.id);
   if (status==='unavailable') return fail(409,'EXHIBIT_UNAVAILABLE','展品已撤下或不可用，请刷新藏宝阁');
   if (status==='available') {
    await c.query('INSERT INTO asset_collections(collector_id,asset_id,first_room_version) VALUES($1,$2,$3::bigint+1)',[s.user.id,asset.id,room.layout_version]);
   }
   return {status:200,data:null};
  });
  reply.header('Cache-Control','private, no-store');
  return ok(request,{status:await exhibitCollectionStatus(pool,id,s.user.id)});
 });

 app.delete('/api/v1/collections/:id',async(request,reply)=>{
  const s=await session(request,true),id=uuid((request.params as {id:string}).id);
  if(request.body!==undefined)exactFields(inputObject(request.body),[]);
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'DELETE',path:path(request),key:request.headers['idempotency-key'],body:{},secret:config.appDataKey,authorize:c=>reauthorize(c,s)},async c=>{
   const collection=(await c.query('SELECT asset_id FROM asset_collections WHERE id=$1 AND collector_id=$2',[id,s.user.id])).rows[0];
   if (!collection) return fail(404,'NOT_FOUND','该收藏已不存在，请刷新背包');
   await lockAsset(c,collection.asset_id);
   const room=(await c.query('SELECT id,layout_version FROM rooms WHERE owner_id=$1 FOR UPDATE',[s.user.id])).rows[0];
   if (!room) return fail(404,'NOT_FOUND','未找到个人小屋');
   const deleted=await c.query('DELETE FROM asset_collections WHERE id=$1 AND collector_id=$2',[id,s.user.id]);
   if (!deleted.rowCount) return fail(404,'NOT_FOUND','该收藏已不存在，请刷新背包');
   return {status:200,data:await removeRoomAsset(c,room,collection.asset_id)};
  }));
 });

 // ---- Administrator asset maintenance (F11) and risk deletion (F13) ----
 app.get('/api/v1/admin/assets',async request=>{
  await admin(request);const source=query(request,'source'),q=query(request,'q'),cursor=cursorOf(request);if(source&&!['personal','furniture','official_candidate'].includes(source))fail(422,'INVALID_INPUT','来源筛选不正确');
  const args:unknown[]=[source,q?`%${q.replace(/[\\%_]/g,m=>'\\'+m)}%`:null];let where="a.state='ready' AND ($1::text IS NULL OR a.source_type=$1) AND ($2::text IS NULL OR a.name ILIKE $2 OR u.username_display ILIKE $2 OR u.nickname ILIKE $2)";
  if(cursor){args.push(cursor.at,cursor.id);where+=' AND (a.created_at,a.id)<($3::timestamptz,$4::uuid)';}
  const rows=(await pool.query(`SELECT a.*,${cursorAt('a.created_at')},u.username_display,u.nickname AS owner_nickname,p.submission_id AS pending_submission,c.id AS candidate_id,e.slot_no,i.metadata_snapshot,c.public_snapshot FROM assets a LEFT JOIN users u ON u.id=a.owner_id LEFT JOIN active_publications p ON p.asset_id=a.id LEFT JOIN candidates c ON c.asset_id=a.id LEFT JOIN exhibit_slots e ON e.candidate_id=c.id LEFT JOIN asset_imports i ON i.id=a.import_id WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT 51`,args)).rows;
  return ok(request,page(rows,50,r=>({id:r.id,sourceType:r.source_type,name:r.name,description:r.description,owner:r.owner_id?{id:r.owner_id,username:r.username_display,nickname:r.owner_nickname}:null,createdAt:iso(r.created_at),modelFileId:r.model_file_id,originalImageId:r.original_image_id??null,normalization:r.normalization,bounds:r.bounds,
   publication:r.pending_submission?{state:'pending'}:r.candidate_id?{state:'candidate',candidateId:r.candidate_id,slotNo:r.slot_no??null}:{state:'none'},publicSnapshot:r.source_type==='official_candidate'?r.public_snapshot:null,editable:r.source_type!=='personal'})));
 });
 app.patch('/api/v1/admin/assets/:id',async(request,reply)=>{
  const s=await admin(request,true),id=uuid((request.params as {id:string}).id),b=inputObject(request.body);
  const pre=(await pool.query("SELECT source_type FROM assets WHERE id=$1 AND state='ready'",[id])).rows[0];if(!pre)fail(404,'NOT_FOUND','未找到该资产');
  if(pre.source_type==='personal')fail(403,'USER_ASSET_READONLY','用户个人资产的文字由本人维护，后台不能代改');
  const official=pre.source_type==='official_candidate';let fields:Record<string,string>;
  if(official){exactFields(b,[...PUBLIC_FIELDS]);fields=publicFieldsInput(b);}else{exactFields(b,['name','description']);fields={name:textField(b.name,'名称',1,80),description:textField(b.description??'','简介',0,2000)};}
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'PATCH',path:path(request),key:request.headers['idempotency-key'],body:b,secret:config.appDataKey,authorize:async c=>{
   await reauthorize(c,s,true);const a=await lockAsset(c,id);if(!a||a.state!=='ready')fail(404,'NOT_FOUND','未找到该资产');
  }},async c=>{
   const row=(await c.query('UPDATE assets SET name=$2,description=$3 WHERE id=$1 RETURNING *',[id,fields.name,fields.description])).rows[0];let galleryVersion:number|null=null;
   if(official){
    const cand=(await c.query("UPDATE candidates SET public_snapshot=$2,version=version+1,updated_at=now() WHERE asset_id=$1 AND source='official' RETURNING id",[id,JSON.stringify({...fields,sourceNickname:'官方馆藏'})])).rows[0];
    // Exhibited text changes become a new gallery version; previously issued grants keep reading their own version.
    if(cand&&(await c.query('SELECT 1 FROM exhibit_slots WHERE candidate_id=$1',[cand.id])).rowCount){await c.query('SELECT version FROM gallery WHERE singleton_id=1 FOR UPDATE');galleryVersion=await publishGallery(c,await currentSlots(c));}
   }
   return {status:200,data:{id:row.id,name:row.name,description:row.description,galleryVersion}};
  }));
 });
 app.delete('/api/v1/admin/assets/:id',async(request,reply)=>{
  const s=await admin(request,true),id=uuid((request.params as {id:string}).id);if(request.body!==undefined&&request.body!==null)exactFields(inputObject(request.body),[]);
  // The asset lock comes after the receipt lookup: a retry of a delete whose response was lost replays its receipt.
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'DELETE',path:path(request),key:request.headers['idempotency-key'],body:{},secret:config.appDataKey,authorize:c=>reauthorize(c,s,true)},async c=>{
   const a=await lockAsset(c,id);if(!a||a.state!=='ready')fail(404,'NOT_FOUND','未找到该资产');
   const {status,data}=await riskDelete(c,id);return {status,data};
  }));
 });

 // ---- Users and today's quota (F12) ----
 app.get('/api/v1/admin/users',async request=>{
  await admin(request);const q=query(request,'q'),cursor=cursorOf(request);const args:unknown[]=[q?`%${q.replace(/[\\%_]/g,m=>'\\'+m)}%`:null];let where="u.password_hash<>'system:no-login' AND ($1::text IS NULL OR u.username_display ILIKE $1 OR u.nickname ILIKE $1)";
  if(cursor){args.push(cursor.at,cursor.id);where+=' AND (u.created_at,u.id)<($2::timestamptz,$3::uuid)';}
  const rows=(await pool.query(`SELECT u.id,u.username_display,u.nickname,u.role,u.created_at,${cursorAt('u.created_at')} FROM users u WHERE ${where} ORDER BY u.created_at DESC,u.id DESC LIMIT 51`,args)).rows;
  return ok(request,page(rows,50,r=>({id:r.id,username:r.username_display,nickname:r.nickname,role:r.role,createdAt:iso(r.created_at)})));
 });
 app.get('/api/v1/admin/users/:id',async request=>{
  await admin(request);const id=uuid((request.params as {id:string}).id);
  const u=(await pool.query("SELECT id,username_display,nickname,role,created_at FROM users WHERE id=$1 AND password_hash<>'system:no-login'",[id])).rows[0];if(!u)fail(404,'NOT_FOUND','未找到该用户');
  const tasks=(await pool.query('SELECT id,status,submitted_day::text,created_at,result_asset_id,error_code FROM generation_tasks WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',[id])).rows;
  const assets=(await pool.query("SELECT id,name,created_at FROM assets WHERE owner_id=$1 AND source_type='personal' AND state='ready' ORDER BY created_at DESC,id DESC LIMIT 50",[id])).rows;
  const counts=(await pool.query("SELECT (SELECT count(*)::int FROM generation_tasks WHERE user_id=$1) AS tasks,(SELECT count(*)::int FROM generation_tasks WHERE user_id=$1 AND status='succeeded') AS succeeded,(SELECT count(*)::int FROM assets WHERE owner_id=$1 AND source_type='personal' AND state='ready') AS assets",[id])).rows[0];
  return ok(request,{user:{id:u.id,username:u.username_display,nickname:u.nickname,role:u.role,createdAt:iso(u.created_at)},quota:await quotaOf(pool,id),counts,
   tasks:tasks.map(t=>({id:t.id,status:t.status==='succeeded'?'succeeded':t.status==='failed'?'failed':'processing',submittedDay:t.submitted_day,createdAt:iso(t.created_at),assetId:t.result_asset_id??null,errorCode:t.error_code??null})),
   assets:assets.map(a=>({id:a.id,name:a.name,createdAt:iso(a.created_at)}))});
 });
 app.put('/api/v1/admin/users/:id/quota',async(request,reply)=>{
  const s=await admin(request,true),id=uuid((request.params as {id:string}).id),b=inputObject(request.body);exactFields(b,['total']);
  if(!Number.isInteger(b.total)||(b.total as number)<0||(b.total as number)>QUOTA_MAX)fail(422,'INVALID_INPUT',`当天总额度须为0～${QUOTA_MAX}的整数`);
  return send(reply,request,await requestWrite(pool,{actor:s.user.id,method:'PUT',path:path(request),key:request.headers['idempotency-key'],body:b,secret:config.appDataKey,authorize:async c=>{
   await reauthorize(c,s,true);if(!(await c.query("SELECT 1 FROM users WHERE id=$1 AND password_hash<>'system:no-login'",[id])).rowCount)fail(404,'NOT_FOUND','未找到该用户');
  }},async c=>{
   // Only today's (Beijing) total changes; used_net and in-flight tasks are untouched. The user row is not
   // locked here so an admin's own row lock never orders against another user's row lock.
   const day=beijingDay();await c.query('INSERT INTO quota_days(user_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,day]);
   await c.query('UPDATE quota_days SET override_total=$3,updated_at=now() WHERE user_id=$1 AND quota_day=$2',[id,day,b.total]);
   return {status:200,data:await quotaOf(c,id)};
  }));
 });
}

/**
 * Risk deletion in one transaction. Caller already holds the asset row lock (taken after the
 * administrator's user lock). Every path that adds a reference (room save, review, gallery publish)
 * locks the asset first, so the reference set discovered here cannot grow until commit.
 * Lock order: asset → affected rooms (by id) → gallery → dependent rows.
 */
export async function riskDelete(c:pg.PoolClient,id:string){
 const asset=(await c.query('SELECT * FROM assets WHERE id=$1',[id])).rows[0];
 const rooms=(await c.query(`SELECT r.id,r.owner_id,r.layout_version FROM rooms r JOIN room_versions v ON v.room_id=r.id AND v.version=r.layout_version
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v.placements_json) p WHERE p->>'assetId'=$1) ORDER BY r.id FOR UPDATE OF r`,[id])).rows;
 let placementsRemoved=0;const roomChanges:{ownerId:string;previousVersion:number;roomVersion:number;placementsRemoved:number}[]=[];
 for(const r of rooms){const change=await removeRoomAsset(c,r,id);placementsRemoved+=change.placementsRemoved;roomChanges.push({ownerId:r.owner_id,...change});}
 await c.query('DELETE FROM asset_collections WHERE asset_id=$1',[id]);
 // Risk content is not kept as readable public text anywhere: submission snapshots, the official import
 // metadata and every gallery version's detail entry are redacted (versions keep only their slot layout).
 // One UPDATE per row: a second update of a row this transaction already changed re-runs its FK check
 // (KEY SHARE on the applicant's users row), which deadlocked with that applicant's own locked request.
 const submissions=(await c.query(`UPDATE submissions s SET status=CASE WHEN s.status IN ('pending','approved') THEN 'deleted' ELSE s.status END,public_snapshot='{"redacted":true}'::jsonb
  FROM submissions o WHERE o.id=s.id AND s.asset_id=$1 RETURNING o.status AS previous`,[id])).rows.filter(r=>r.previous==='pending'||r.previous==='approved').length;
 if(asset.import_id)await c.query(`UPDATE asset_imports SET metadata_snapshot='{"redacted":true}'::jsonb WHERE id=$1`,[asset.import_id]);
 await c.query('DELETE FROM active_publications WHERE asset_id=$1',[id]);
 const candidate=(await c.query('SELECT id FROM candidates WHERE asset_id=$1',[id])).rows[0];let galleryVersion:number|null=null,slotNo:number|null=null;
 if(candidate){
  await c.query('SELECT version FROM gallery WHERE singleton_id=1 FOR UPDATE');
  const slot=(await c.query('SELECT slot_no FROM exhibit_slots WHERE candidate_id=$1',[candidate.id])).rows[0];
  if(slot){slotNo=Number(slot.slot_no);galleryVersion=await publishGallery(c,(await currentSlots(c)).map(x=>x.candidateId===candidate.id?{...x,candidateId:null}:x));}
  await c.query('UPDATE gallery_versions SET details_json=details_json-$1::text WHERE details_json ? $1::text',[candidate.id]);
  await c.query('DELETE FROM candidates WHERE id=$1',[candidate.id]);
 }
 // Minimal tombstone: no name/description/geometry remain; file ids stay only to drive cleanup.
 await c.query("UPDATE assets SET state='deleted',deleted_at=now(),name=NULL,description='',normalization=NULL,bounds=NULL WHERE id=$1",[id]);
 const files=[...new Set([asset.model_file_id,asset.original_image_id].filter(Boolean))];
 for(const f of files){
  // A file still used by another ready asset (e.g. the same input image generated twice) stays readable for it.
  const r=(await c.query("UPDATE files SET state='deleted' WHERE id=$1 AND state<>'deleted' AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.state='ready' AND a.id<>$2 AND (a.model_file_id=$1 OR a.original_image_id=$1)) RETURNING object_key",[f,id])).rows[0];
  if(r)await c.query('INSERT INTO cleanup_jobs(asset_id,file_id,object_key) VALUES($1,$2,$3) ON CONFLICT (object_key) DO NOTHING',[id,f,r.object_key]);
 }
 return {status:200,data:{deleted:true,roomsUpdated:rooms.length,placementsRemoved,submissionsClosed:submissions,candidateRemoved:Boolean(candidate),slotNo,galleryVersion},roomChanges};
}
