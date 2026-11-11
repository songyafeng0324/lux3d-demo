import multipart from '@fastify/multipart';
import {registerRoomRoutes,hasSnapshotAuthorization,snapshotFile} from './rooms.js';
import {registerCurationRoutes,riskDelete} from './curation.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type pg from 'pg';
import {BusinessError,inputObject,exactFields,textField,usernameField,passwordField,hashPassword,verifyPassword,createPersonalRoom,tokenHash,csrfFor,safeEqual,beijingDay,userDto,taskDto,assetDto,requestWrite,transaction,validateImage,bodyHash,publicFieldsInput} from '@aholo/domain';
import type {Config,LocalFileStore} from '@aholo/domain';
import {DEFAULT_DAILY_QUOTA} from '@aholo/contracts';
type Session={user:Record<string,any>;token:string;hash:string};
const fail=(status:number,code:string,message:string):never=>{throw new BusinessError(status,code,message);};
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)?value:fail(404,'NOT_FOUND','未找到该资源');
const ok=(request:FastifyRequest,data:unknown)=>({data,requestId:request.id});
const personalAssetFields="assets.*, EXISTS (SELECT 1 FROM candidates c WHERE c.asset_id=assets.id AND c.source='user') AS submission_approved";
// A generation task whose asset the owner deleted no longer links to it.
const taskFields="generation_tasks.*, EXISTS (SELECT 1 FROM assets a WHERE a.id=generation_tasks.result_asset_id AND a.state='deleted') AS asset_deleted";
const personalAssetDto=(row:Record<string,any>)=>({...assetDto(row),submissionApproved:row.submission_approved as boolean});
export async function registerBusinessRoutes(app:FastifyInstance,{pool,store,config}:{pool:pg.Pool;store:LocalFileStore;config:Config}){
  await app.register(multipart,{limits:{files:1,fields:16,parts:17,fileSize:100*1024*1024}});
  const uploadedObjects=new AsyncLocalStorage<Set<string>>();
  const allowedOrigins=new Set([new URL(config.publicOrigin).origin,`http://${config.apiHost}:${config.apiPort}`]);
  function origin(request:FastifyRequest){if(typeof request.headers.origin!=='string'||!allowedOrigins.has(request.headers.origin))fail(403,'CSRF_REJECTED','请从本站页面发起操作');}
  async function session(request:FastifyRequest,write=false):Promise<Session>{
    const token=request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('aholo_session='))?.slice(14) ?? '';
    if(!/^[a-f0-9]{64}$/.test(token))return fail(401,'LOGIN_REQUIRED','请先登录');
    const hash=tokenHash(token);const rows=await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.credential_version=u.credential_version',[hash]);
    if(!rows.rowCount)return fail(401,'LOGIN_REQUIRED','登录已过期，请重新登录');
    if(write){origin(request);if(!safeEqual(request.headers['x-csrf-token'],csrfFor(token,config.appDataKey)))fail(403,'CSRF_REJECTED','操作凭证已失效，请刷新页面');}
    return {user:rows.rows[0],token,hash};
  }
  async function reauthorize(c:pg.PoolClient,s:Session,admin=false){
    // Request-key lock is always taken before the user row lock.
    // NO KEY UPDATE still serialises a user's writes and credential changes, but does not block the
    // KEY SHARE that foreign-key checks on rows referencing this user take inside other transactions.
    await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[s.user.id]);
    const q=await c.query('SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.credential_version=u.credential_version',[s.hash]);
    if(!q.rowCount)fail(401,'LOGIN_REQUIRED','登录已过期，请重新登录');
    if(admin&&q.rows[0].role!=='admin')fail(403,'FORBIDDEN','没有管理权限');
  }
  async function write<T>(request:FastifyRequest,s:Session,body:unknown,fn:(c:pg.PoolClient)=>Promise<{status:number;data:T}>,admin=false,authorize?:(c:pg.PoolClient)=>Promise<void>){
    const objects=new Set<string>();
    try{return await uploadedObjects.run(objects,()=>requestWrite(pool,{actor:s.user.id,method:request.method,path:request.url.split('?')[0],key:request.headers['idempotency-key'],body,secret:config.appDataKey,authorize:async c=>{await reauthorize(c,s,admin);await authorize?.(c);}},fn));}
    catch(error){
      // A lost COMMIT response is ambiguous. Delete only after confirming that
      // the durable database has no file row; unavailable DB leaves safe orphans.
      for(const id of objects)await pool.query('SELECT 1 FROM files WHERE id=$1',[id]).then(async rows=>{if(!rows.rowCount)await store.delete(id);}).catch(()=>undefined);
      throw error;
    }
  }
  async function sendWrite(reply:FastifyReply,request:FastifyRequest,result:{status:number;data:unknown}){reply.code(result.status);return result.status===204?reply.send():ok(request,result.data);}
  function cookie(reply:FastifyReply,token:string,maxAge=7*86400){reply.header('Set-Cookie',`aholo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.publicOrigin.startsWith('https:')?'; Secure':''}`);}
  async function rate(request:FastifyRequest,kind:string,limit:number){
    const bucket=bodyHash({kind,ip:request.ip},config.appDataKey);
    const row=await transaction(pool,async c=>(await c.query(`INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES($1,now(),1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE auth_rate_limits.attempts+1 END,window_start=CASE WHEN auth_rate_limits.window_start<now()-interval '15 minutes' THEN now() ELSE auth_rate_limits.window_start END RETURNING attempts`,[bucket])).rows[0]);
    if(row.attempts>limit)fail(429,'RATE_LIMITED','尝试过于频繁，请稍后再试');
  }
  async function quota(userId:string){const day=beijingDay();const row=(await pool.query('SELECT override_total,used_net FROM quota_days WHERE user_id=$1 AND quota_day=$2',[userId,day])).rows[0];const total=row?.override_total??DEFAULT_DAILY_QUOTA,used=row?.used_net??0;return {day,total,used,available:Math.max(0,total-used)};}
  async function upload(c:pg.PoolClient,owner:string,bytes:Buffer,mime:string,purpose:string){
    const id=randomUUID();const sha=createHash('sha256').update(bytes).digest('hex');
    await c.query("INSERT INTO files(id,owner_id,purpose,object_key,sha256,byte_size,mime,state) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,'staged')",[id,owner,purpose,sha,bytes.length,mime]);
    const staged=await store.putStaged(bytes);uploadedObjects.getStore()?.add(id);await store.commit(staged,id,sha);
    await c.query("UPDATE files SET state='committed' WHERE id=$1",[id]);return id;
  }
  async function multipartBody(request:FastifyRequest){const fields:Record<string,string>={};let file:Buffer|undefined;let filename='';for await(const part of request.parts()){if(part.type==='file'){if(file)fail(422,'INVALID_INPUT','只能上传一个文件');filename=part.filename;file=await part.toBuffer();if(part.file.truncated)fail(413,'FILE_TOO_LARGE','文件过大');}else{if(typeof part.value!=='string'||part.fieldname in fields)fail(422,'INVALID_INPUT','上传字段不正确');fields[part.fieldname]=part.value as string;}}if(!file||!file.length)fail(422,'INVALID_INPUT','请选择文件');return {fields,file:file!,filename};}
  app.post('/api/v1/auth/register',async(request,reply)=>{
    origin(request);await rate(request,'register',20);const b=inputObject(request.body);exactFields(b,['username','nickname','password','confirmPassword']);const username=usernameField(b.username);const nickname=textField(b.nickname,'昵称',1,40);const password=passwordField(b.password);if(password!==b.confirmPassword)fail(422,'PASSWORD_CONFIRMATION','两次密码不一致');
    const result=await requestWrite(pool,{actor:`register:${username.key}`,method:'POST',path:'/api/v1/auth/register',key:request.headers['idempotency-key'],body:b,secret:config.appDataKey},async c=>{
      const hash=await hashPassword(password);const id=randomUUID();const rows=await c.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(username_key) DO NOTHING RETURNING *",[id,username.key,username.display,nickname,hash]);if(!rows.rowCount)fail(409,'USERNAME_TAKEN','该账号已被使用');
      await createPersonalRoom(c,id);return {status:201,data:{user:userDto(rows.rows[0])}};
    });return sendWrite(reply,request,result);
  });
  app.post('/api/v1/auth/login',async(request,reply)=>{
    origin(request);await rate(request,'login',50);const b=inputObject(request.body);exactFields(b,['username','password']);const username=usernameField(b.username);const password=passwordField(b.password);const rows=await pool.query('SELECT * FROM users WHERE username_key=$1',[username.key]);const row=rows.rows[0];
    // Use the same expensive hash on missing accounts to avoid a cheap existence oracle.
    const valid=row?await verifyPassword(password,row.password_hash):(await hashPassword(password),false);if(!valid)fail(401,'INVALID_CREDENTIALS','账号或密码错误');
    const token=randomBytes(32).toString('hex');await transaction(pool,async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.id]);const current=(await c.query('SELECT credential_version,password_hash FROM users WHERE id=$1',[row.id])).rows[0];if(current.password_hash!==row.password_hash)fail(401,'INVALID_CREDENTIALS','账号或密码错误');await c.query("INSERT INTO sessions(token_hash,user_id,credential_version,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[tokenHash(token),row.id,current.credential_version]);});cookie(reply,token);return ok(request,{user:userDto(row),csrfToken:csrfFor(token,config.appDataKey)});
  });
  app.post('/api/v1/auth/logout',async(request,reply)=>{origin(request);let s:Session;try{s=await session(request,true);}catch(e){if(e instanceof BusinessError&&e.status===401){cookie(reply,'',0);return reply.code(204).send();}throw e;}await transaction(pool,async c=>{await c.query('DELETE FROM sessions WHERE token_hash=$1',[s.hash]);});cookie(reply,'',0);return reply.code(204).send();});
  app.get('/api/v1/me',async request=>{const s=await session(request);const room=(await pool.query('SELECT id FROM rooms WHERE owner_id=$1',[s.user.id])).rows[0];const task=(await pool.query("SELECT *,submitted_day::text FROM generation_tasks WHERE user_id=$1 AND status NOT IN ('succeeded','failed')",[s.user.id])).rows[0];return ok(request,{user:userDto(s.user),roomId:room?.id??null,quota:await quota(s.user.id),activeTask:task?taskDto(task):null,csrfToken:csrfFor(s.token,config.appDataKey)});});
  app.patch('/api/v1/me',async(request,reply)=>{const s=await session(request,true);const b=inputObject(request.body);exactFields(b,['nickname']);const nickname=textField(b.nickname,'昵称',1,40);return sendWrite(reply,request,await write(request,s,b,async c=>{const row=(await c.query('UPDATE users SET nickname=$2 WHERE id=$1 RETURNING *',[s.user.id,nickname])).rows[0];return {status:200,data:{user:userDto(row)}};}));});
  app.post('/api/v1/me/password',async(request,reply)=>{const s=await session(request,true);const b=inputObject(request.body);exactFields(b,['oldPassword','newPassword','confirmPassword']);const old=passwordField(b.oldPassword);const next=passwordField(b.newPassword);if(next!==b.confirmPassword)fail(422,'PASSWORD_CONFIRMATION','两次新密码不一致');const result=await write(request,s,b,async c=>{const row=(await c.query('SELECT password_hash FROM users WHERE id=$1',[s.user.id])).rows[0];if(!await verifyPassword(old,row.password_hash))fail(422,'WRONG_PASSWORD','原密码不正确');const hash=await hashPassword(next);await c.query('UPDATE users SET password_hash=$2,credential_version=credential_version+1 WHERE id=$1',[s.user.id,hash]);await c.query('DELETE FROM sessions WHERE user_id=$1',[s.user.id]);return {status:204,data:null};});cookie(reply,'',0);return sendWrite(reply,request,result);});
  app.post('/api/v1/uploads/images',async(request,reply)=>{const s=await session(request,true);const {fields,file}=await multipartBody(request);exactFields(fields,[]);const image=await validateImage(file).catch(()=>fail(422,'INVALID_IMAGE','仅支持10MiB以内、最多1600万像素的完整PNG、JPEG或WebP单张图片'));const hash=createHash('sha256').update(file).digest('hex');return sendWrite(reply,request,await write(request,s,{sha256:hash},async c=>({status:201,data:{inputFileId:await upload(c,s.user.id,file,image.mime,'input_image')}})));});
  app.post('/api/v1/generation-tasks',async(request,reply)=>{const s=await session(request,true);const b=inputObject(request.body);exactFields(b,['inputFileId']);const fileId=uuid(b.inputFileId);return sendWrite(reply,request,await write(request,s,b,async c=>{
    if(!config.generationEnabled||!config.lux3dConfigured||!(await c.query("SELECT 1 FROM worker_heartbeats WHERE generation_enabled AND last_seen>now()-interval '10 seconds' LIMIT 1")).rowCount)fail(503,'GENERATION_UNAVAILABLE','生成服务暂未就绪，请稍后重试');
    const file=(await c.query("SELECT * FROM files WHERE id=$1 AND owner_id=$2 AND purpose='input_image' AND state='committed'",[fileId,s.user.id])).rows[0];if(!file)fail(404,'NOT_FOUND','未找到可用图片');
    if((await c.query("SELECT 1 FROM generation_tasks WHERE user_id=$1 AND status NOT IN ('succeeded','failed')",[s.user.id])).rowCount)fail(422,'TASK_IN_PROGRESS','已有生成中的任务，请等待完成');
    const day=beijingDay();await c.query('INSERT INTO quota_days(user_id,quota_day) VALUES($1,$2) ON CONFLICT DO NOTHING',[s.user.id,day]);const q=(await c.query('SELECT override_total,used_net FROM quota_days WHERE user_id=$1 AND quota_day=$2 FOR UPDATE',[s.user.id,day])).rows[0];if(q.used_net>=(q.override_total??DEFAULT_DAILY_QUOTA))fail(422,'QUOTA_EXHAUSTED','今日生成次数已用完');
    const task=randomUUID();const attempt=randomUUID();const params={inputSha256:file.sha256,policyVersion:'t06-v1',version:'G1-Turbo',faceCount:50000,outputFormat:['glb'],enablePbr:true,aiPredictSize:false};const hash=createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const row=(await c.query("INSERT INTO generation_tasks(id,user_id,input_file_id,submitted_day,policy_version,attempt_id) VALUES($1,$2,$3,$4,'t06-v1',$5) RETURNING *,submitted_day::text",[task,s.user.id,fileId,day,attempt])).rows[0];await c.query("INSERT INTO provider_attempts(id,task_id,request_hash,input_sha256,request_params) VALUES($1,$2,$3,$4,$5)",[attempt,task,hash,file.sha256,JSON.stringify(params)]);await c.query("INSERT INTO jobs(kind,ref_id) VALUES('generation',$1)",[task]);await c.query("INSERT INTO quota_events(task_id,user_id,kind,quota_day,delta) VALUES($1,$2,'reserve',$3,1)",[task,s.user.id,day]);await c.query('UPDATE quota_days SET used_net=used_net+1,updated_at=now() WHERE user_id=$1 AND quota_day=$2',[s.user.id,day]);return {status:202,data:taskDto(row)};
  }));});
  function pagination(request:FastifyRequest){const cursor=(request.query as Record<string,unknown>).cursor;if(cursor===undefined)return null;if(typeof cursor!=='string'||cursor.length>300)fail(422,'INVALID_CURSOR','分页标识不正确');try{const [at,id]=JSON.parse(Buffer.from(cursor as string,'base64url').toString());if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at))throw new Error();return {at,id:uuid(id)};}catch{ return fail(422,'INVALID_CURSOR','分页标识不正确');}}
  async function list(request:FastifyRequest,table:'generation_tasks'|'assets',where:string,args:unknown[],dto:(r:Record<string,any>)=>unknown,fields='*'){const cursor=pagination(request);let clause=where;if(cursor){args.push(cursor.at,cursor.id);clause+=` AND (created_at,id)<($${args.length-1}::timestamptz,$${args.length}::uuid)`;}const rows=(await pool.query(`SELECT ${fields},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at${table==='generation_tasks'?',submitted_day::text':''} FROM ${table} WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT 31`,args)).rows;const items=rows.slice(0,30);const last=items.at(-1);return ok(request,{items:items.map(dto),nextCursor:rows.length>30?Buffer.from(JSON.stringify([last!.cursor_at,last!.id])).toString('base64url'):null});}
  app.get('/api/v1/generation-tasks',async request=>{const s=await session(request);return list(request,'generation_tasks','user_id=$1',[s.user.id],taskDto,taskFields);});
  app.get('/api/v1/generation-tasks/:id',async request=>{const s=await session(request);const id=uuid((request.params as {id:string}).id);const row=(await pool.query(`SELECT ${taskFields},submitted_day::text FROM generation_tasks WHERE id=$1 AND user_id=$2`,[id,s.user.id])).rows[0];if(!row)fail(404,'NOT_FOUND','未找到该任务');return ok(request,taskDto(row));});
  app.get('/api/v1/assets',async request=>{const s=await session(request);return list(request,'assets',"owner_id=$1 AND source_type='personal' AND state='ready'",[s.user.id],personalAssetDto,personalAssetFields);});
  app.get('/api/v1/assets/:id',async request=>{const s=await session(request);const row=(await pool.query(`SELECT ${personalAssetFields} FROM assets WHERE id=$1 AND owner_id=$2 AND state='ready'`,[uuid((request.params as {id:string}).id),s.user.id])).rows[0];if(!row)fail(404,'NOT_FOUND','未找到该藏品');return ok(request,personalAssetDto(row));});
  app.patch('/api/v1/assets/:id',async(request,reply)=>{
    const s=await session(request,true),id=uuid((request.params as {id:string}).id),b=inputObject(request.body);
    exactFields(b,['name','description']);
    const name=textField(b.name,'名称',1,80),description=b.description===undefined?null:textField(b.description,'简介',0,2000);
    const check=async(c:pg.PoolClient)=>{
      if(!(await c.query("SELECT id FROM assets WHERE id=$1 AND owner_id=$2 AND source_type='personal' AND state='ready' FOR UPDATE",[id,s.user.id])).rowCount)fail(404,'NOT_FOUND','未找到该藏品');
    };
    return sendWrite(reply,request,await write(request,s,b,async c=>({status:200,data:assetDto((await c.query('UPDATE assets SET name=$2,description=coalesce($3,description) WHERE id=$1 RETURNING *',[id,name,description])).rows[0])}),false,check));
  });
  // The owner deletes their own generated asset: the same cascade as the administrator delete (gallery slot,
  // curated candidate, pending submission, everyone's collections and room placements, files). Lock order:
  // request key → owner's user row → asset → rooms → gallery, as for the administrator.
  app.delete('/api/v1/assets/:id',async(request,reply)=>{
    const s=await session(request,true),id=uuid((request.params as {id:string}).id);if(request.body!==undefined&&request.body!==null)exactFields(inputObject(request.body),[]);
    // The ownership check runs after the receipt lookup, so a retry of a delete whose response was lost replays its receipt.
    return sendWrite(reply,request,await write(request,s,{},async c=>{
      if(!(await c.query("SELECT id FROM assets WHERE id=$1 AND owner_id=$2 AND source_type='personal' AND state='ready' FOR UPDATE",[id,s.user.id])).rowCount)fail(404,'NOT_FOUND','未找到该藏品，可能已删除');
      const {status,data,roomChanges}=await riskDelete(c,id);
      // The owner's open room page rebases its draft on this change (same shape as an uncollect).
      let room=roomChanges.find(r=>r.ownerId===s.user.id);
      if(!room){const v=Number((await c.query('SELECT layout_version FROM rooms WHERE owner_id=$1',[s.user.id])).rows[0]?.layout_version??0);room={ownerId:s.user.id,previousVersion:v,roomVersion:v,placementsRemoved:0};}
      const {ownerId:_,...ownRoom}=room;
      return {status,data:{...data,ownRoom}};
    }));
  });
  app.get('/api/v1/furniture',async request=>{await session(request);return list(request,'assets',"source_type='furniture' AND state='ready'",[],assetDto);});
  app.get('/api/v1/files/:id/content',async(request,reply)=>{
    const id=uuid((request.params as {id:string}).id);
    if(hasSnapshotAuthorization(request)){const row=await snapshotFile(pool,request,id);reply.header('Cache-Control','private, no-store');reply.header('Content-Type',row.mime);reply.header('Content-Length',row.byte_size);reply.header('Content-Disposition','inline');return reply.send(await store.openRead(row.object_key));}
    const s=await session(request);
    const row=(await pool.query(`SELECT f.* FROM files f WHERE f.id=$1 AND f.state='committed' AND (NOT EXISTS(SELECT 1 FROM assets a WHERE a.state='deleted' AND (a.model_file_id=f.id OR a.original_image_id=f.id OR a.generation_task_id IN (SELECT t.id FROM generation_tasks t WHERE t.input_file_id=f.id))) OR EXISTS(SELECT 1 FROM assets r WHERE r.state='ready' AND (r.model_file_id=f.id OR r.original_image_id=f.id))) AND ((f.owner_id=$2 AND (f.purpose='input_image' OR EXISTS(SELECT 1 FROM assets a WHERE a.state='ready' AND a.owner_id=$2 AND (a.model_file_id=f.id OR a.original_image_id=f.id)))) OR EXISTS(SELECT 1 FROM assets a WHERE a.model_file_id=f.id AND a.state='ready' AND a.source_type='furniture')
      OR EXISTS(SELECT 1 FROM asset_collections ac JOIN assets a ON a.id=ac.asset_id AND a.state='ready' WHERE ac.collector_id=$2 AND a.model_file_id=f.id)
      OR ($3='admin' AND (EXISTS(SELECT 1 FROM assets a WHERE a.state='ready' AND (a.model_file_id=f.id OR a.original_image_id=f.id)) OR EXISTS(SELECT 1 FROM asset_imports i WHERE i.input_file_id=f.id AND i.state<>'failed'))))`,[id,s.user.id,s.user.role])).rows[0];
    if(!row)fail(404,'NOT_FOUND','未找到该文件');reply.header('Cache-Control','private, no-store');reply.header('Content-Type',row.mime);reply.header('Content-Length',row.byte_size);reply.header('Content-Disposition','inline');return reply.send(await store.openRead(row.object_key));
  });
  app.post('/api/v1/admin/assets',async(request,reply)=>{
    const s=await session(request,true);if(s.user.role!=='admin')fail(403,'FORBIDDEN','没有管理权限');const {fields,file,filename}=await multipartBody(request);exactFields(fields,['sourceType','source_type','name','description','era','material','ownershipType','holderName','location','officialUrl']);const source=fields.sourceType??fields.source_type;if(!['furniture','official_candidate'].includes(source))fail(422,'INVALID_INPUT','请选择官方物品或官方藏品');if(!/\.glb$/i.test(filename)||file.length>100*1024*1024)fail(422,'INVALID_MODEL','仅支持100MiB以内的GLB模型');
    const metadata:Record<string,string>={name:textField(fields.name,'名称',1,80),description:textField(fields.description??'','简介',source==='official_candidate'?1:0,2000)};
    if(source==='official_candidate')Object.assign(metadata,publicFieldsInput(fields),{sourceNickname:'官方馆藏'});
    const hash=createHash('sha256').update(file).digest('hex');return sendWrite(reply,request,await write(request,s,{sourceType:source,metadata,sha256:hash},async c=>{const input=await upload(c,s.user.id,file,'model/gltf-binary','model');const id=randomUUID();await c.query("INSERT INTO asset_imports(id,admin_id,input_file_id,source_type,metadata_snapshot,policy_version) VALUES($1,$2,$3,$4,$5,'t06-v1')",[id,s.user.id,input,source,JSON.stringify(metadata)]);await c.query("INSERT INTO jobs(kind,ref_id) VALUES('import',$1)",[id]);return {status:202,data:{id,status:'processing',assetId:null}};},true));
  });
  await registerRoomRoutes(app,{pool,config,session,reauthorize});
  await registerCurationRoutes(app,{pool,config,session,reauthorize});
}
