/** Local-only T04 experiment. This does not implement production accounts or storage. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ASSET_BOUNDS, SCENE_VERSION, validateLayout, type RoomLayout, type Placement } from '@aholo/contracts';

const SAMPLE_SHA = '15f22bbe7cf83f06b2cdf55e97ab0b87aeff947ddba0b13ea1372d2b253bd639';
const PRIVATE_ROOT = path.join(homedir(), 'Library', 'Application Support', 'aholo-lux3d');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface Room { current: RoomLayout; history: Record<string, RoomLayout>; enabled: boolean; epoch: number; stableShareToken?: string }
interface Grant { roomId: string; version: number; epoch: number }
interface Receipt { hash: string; response: RoomLayout & { editSequence: number } }
interface State { schema: 'aholo.t04/v1'; rooms: Record<string, Room>; grants: Record<string, Grant>; receipts: Record<string, Receipt>; modelDeleted: boolean }
interface LabOptions {
  stateDir?: string;
  modelPath?: string;
  modelSha256?: string;
  /** In-process test fault, never exposed over HTTP. */
  beforeCommit?: () => Promise<void>;
}
class LabError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly extra = {}) { super(message); } }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const emptyState = (): State => ({ schema: 'aholo.t04/v1', rooms: {}, grants: {}, receipts: {}, modelDeleted: false });
const defaultRoom = (): Room => ({ current: {version: 0, name: '我的小屋', sceneVersion: SCENE_VERSION, placements: []}, history: {}, enabled: false, epoch: 0 });
const roomId = (value: unknown): string => { if (typeof value !== 'string' || !UUID.test(value)) throw new LabError(422, 'INVALID_ROOM', '验证房间标识无效'); return value; };
const query = (r: FastifyRequest) => r.query as Record<string, unknown>;

export async function registerT04Lab(app: FastifyInstance, options: LabOptions = {}) {
  const stateDir = options.stateDir ?? path.join(PRIVATE_ROOT, 't04');
  const statePath = path.join(stateDir, 'state.json');
  const modelPath = options.modelPath ?? path.join(PRIVATE_ROOT, 't03', 'artifacts', 'vase.glb');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Pin the chosen directory; refuse a symlink rather than redirecting private writes.
  const initialDir = await fs.lstat(stateDir);
  if (!initialDir.isDirectory() || initialDir.isSymbolicLink()) throw new Error('Invalid T04 state directory');
  const expectedDir = await fs.realpath(stateDir);
  let state: State;
  try {
    const st=await fs.lstat(statePath);if(!st.isFile()||st.isSymbolicLink())throw new Error('Invalid T04 state file');
    state = JSON.parse(await fs.readFile(statePath, 'utf8')) as State;
    if (state.schema !== 'aholo.t04/v1' || !state.rooms || !state.grants || !state.receipts || typeof state.modelDeleted !== 'boolean') throw new Error('Invalid T04 state');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; state = emptyState(); }
  let tail: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> { const run=tail.then(fn);tail=run.catch(()=>undefined);return run; }
  async function commit(next: State) {
    const currentDir=await fs.lstat(stateDir);
    if(currentDir.isSymbolicLink()||currentDir.dev!==initialDir.dev||currentDir.ino!==initialDir.ino||await fs.realpath(stateDir)!==expectedDir)throw new Error('T04 directory changed');
    await options.beforeCommit?.();
    const temporary=path.join(stateDir,`.state-${randomUUID()}.tmp`);
    try {
      const handle=await fs.open(temporary,'wx',0o600);
      try {await handle.writeFile(JSON.stringify(next));await handle.sync();}finally{await handle.close();}
      await fs.rename(temporary,statePath);
      // Rename may have committed even if the subsequent directory fsync fails.
      // Preserve the receipt in memory so a retry cannot overwrite that commit.
      state=next;
      const directory=await fs.open(stateDir,'r');try{await directory.sync();}finally{await directory.close();}
    }finally{await fs.rm(temporary,{force:true});}
  }
  const response = (request: FastifyRequest, data: unknown) => ({data,requestId:request.id});
  // Explicit, ephemeral editor capability separates an editor tab from a visitor
  // tab in the same browser. Local session bootstrap is not production login.
  const editorTokens = new Set<string>();
  async function issueSnapshot(id: string) {
    const room=state.rooms[id];if(!room?.enabled)throw new LabError(403,'SHARE_CLOSED','参观链接尚未开启');
    const next=structuredClone(state);const token=randomUUID();next.grants[token]={roomId:id,version:room.current.version,epoch:room.epoch};next.rooms[id]!.history[String(room.current.version)]=room.current;await commit(next);
    return {...room.current,grant:token};
  }
  function checkedGrant(token: unknown): {room:Room;grant:Grant;snapshot:RoomLayout} {
    if(typeof token!=='string'||!UUID.test(token))throw new LabError(403,'INVALID_GRANT','参观凭证无效');
    const grant=state.grants[token];const room=grant&&state.rooms[grant.roomId];
    if(!grant||!room||!room.enabled||room.epoch!==grant.epoch)throw new LabError(403,'SHARE_CLOSED','参观链接已关闭或无效');
    const snapshot=room.history[String(grant.version)] ?? (room.current.version===grant.version?room.current:undefined);
    if(!snapshot)throw new LabError(404,'SNAPSHOT_NOT_FOUND','快照不存在');
    if(state.modelDeleted&&snapshot.placements.some(p=>p.assetId==='vase'))throw new LabError(403,'ASSET_DELETED','快照中的模型已被删除');
    return {room,grant,snapshot};
  }
  let cachedModel: Buffer | undefined;
  async function model() {
    if(!cachedModel){
      try {const st=await fs.lstat(modelPath);if(!st.isFile()||st.isSymbolicLink())throw new Error();const bytes=await fs.readFile(modelPath);if(hash(bytes)!==(options.modelSha256??SAMPLE_SHA))throw new Error();cachedModel=bytes;}
      catch {throw new LabError(503,'SAMPLE_UNAVAILABLE','真实模型样本暂不可用');}
    }
    return cachedModel;
  }

  await app.register(async lab=>{
    lab.addHook('onRequest',async(request,reply)=>{
      const remote=request.ip;
      const origin=request.headers.origin;
      const host=request.headers.host;
      // Derive additional test-server addresses from the actual bound socket,
      // never from Host/Origin supplied by the caller.
      const address=app.server.address();
      const boundPort=address&&typeof address==='object'?address.port:undefined;
      const hosts=new Set(boundPort?['localhost:5173']:['localhost:5173','127.0.0.1:3001','localhost:3001','localhost']);
      const origins=new Set(boundPort?['http://localhost:5173']:['http://localhost:5173','http://127.0.0.1:3001']);
      if(boundPort){for(const hostname of ['localhost','127.0.0.1']){hosts.add(`${hostname}:${boundPort}`);origins.add(`http://${hostname}:${boundPort}`);}}
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||!hosts.has(host??'')||(origin!==undefined&&!origins.has(origin)))return reply.code(403).send({error:{code:'LAB_LOCAL_ONLY',message:'验证服务仅限本机'},requestId:request.id});
      if(!['GET','HEAD'].includes(request.method)&&request.headers['x-t04-lab']!=='1')return reply.code(403).send({error:{code:'LAB_HEADER_REQUIRED',message:'缺少本地验证请求标识'},requestId:request.id});
      const pathname=request.url.split('?')[0];
      const sessionBootstrap=request.method==='POST'&&pathname==='/api/lab/t04/session';
      const publicRead=['GET','HEAD'].includes(request.method)&&(
        /^\/api\/lab\/t04\/entry\/[^/]+$/.test(pathname)||
        /^\/api\/lab\/t04\/snapshot\/[^/]+$/.test(pathname)||
        (pathname==='/api/lab/t04/model'&&Object.hasOwn(query(request),'grant'))
      );
      const token=request.headers['x-t04-editor'];
      if(!sessionBootstrap&&!publicRead&&(typeof token!=='string'||!editorTokens.has(token)))return reply.code(403).send({error:{code:'EDITOR_REQUIRED',message:'需要本地编辑会话；访客只能读取获准快照'},requestId:request.id});
    });
    lab.addHook('onSend',async(_r,reply)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');});
    lab.setErrorHandler((error,request,reply)=>{
      if(error instanceof LabError)return reply.code(error.status).send({error:{code:error.code,message:error.message,...error.extra},requestId:request.id});
      const code=(error as {statusCode?:number}).statusCode;
      return reply.code(code===413?413:code===400?400:503).send({error:{code:code===413?'LAYOUT_TOO_LARGE':code===400?'INVALID_REQUEST':'LAB_STORAGE_UNAVAILABLE',message:code===413?'布局超过本次传输限制，未保存或截断':code===400?'请求格式无效':'验证存储暂不可用，编辑尚未确认保存'},requestId:request.id});
    });
    lab.post('/session',async request=>{const token=randomUUID();editorTokens.add(token);return response(request,{editorToken:token});});
    lab.get('/room',async request=>serialized(async()=>{
      const room=state.rooms[roomId(query(request).roomId)]??defaultRoom();
      return response(request,{...room.current,shareEnabled:room.enabled,shareToken:room.stableShareToken??null});
    }));
    lab.put('/room',{bodyLimit:64*1024*1024},async request=>serialized(async()=>{
      const id=roomId(query(request).roomId);const b=request.body as Record<string,unknown>;
      if(!b||typeof b!=='object')throw new LabError(422,'INVALID_LAYOUT','布局格式无效');
      const error=validateLayout(b.name,b.placements);if(error)throw new LabError(422,'INVALID_LAYOUT',error);
      if(!Number.isSafeInteger(b.baseVersion)||Number(b.baseVersion)<0||!Number.isSafeInteger(b.editSequence)||Number(b.editSequence)<0)throw new LabError(422,'INVALID_SEQUENCE','版本或编辑序号无效');
      const key=request.headers['idempotency-key'];if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(key))throw new LabError(422,'INVALID_KEY','保存请求标识无效');
      const placements=b.placements as Placement[];
      if(state.modelDeleted&&placements.some(p=>p.assetId==='vase'))throw new LabError(422,'ASSET_DELETED','真实模型已在本验证环境删除');
      const bodyHash=hash(JSON.stringify({baseVersion:b.baseVersion,editSequence:b.editSequence,name:b.name,placements}));const receiptKey=`${id}:${key}`;
      const previous=state.receipts[receiptKey];if(previous){if(previous.hash!==bodyHash)throw new LabError(409,'IDEMPOTENCY_CONFLICT','相同保存标识对应不同编辑');return response(request,previous.response);}
      const current=state.rooms[id]??defaultRoom();if(current.current.version!==b.baseVersion)throw new LabError(409,'ROOM_VERSION_CONFLICT','另一个页面已更新，请先核对服务器版本',{currentVersion:current.current.version});
      const next=structuredClone(state);const room=next.rooms[id]??defaultRoom();
      room.history[String(room.current.version)]=room.current;
      const saved={version:room.current.version+1,name:(b.name as string).trim(),sceneVersion:SCENE_VERSION,placements:structuredClone(placements)};
      room.current=saved;room.history[String(saved.version)]=saved;next.rooms[id]=room;
      const result={...saved,editSequence:b.editSequence as number};next.receipts[receiptKey]={hash:bodyHash,response:result};
      await commit(next);return response(request,result);
    }));
    lab.put('/share',async request=>serialized(async()=>{
      const b=request.body as Record<string,unknown>;const id=roomId(b?.roomId);if(typeof b.enabled!=='boolean')throw new LabError(422,'INVALID_SHARE','分享状态无效');
      const next=structuredClone(state);const room=next.rooms[id]??defaultRoom();if(room.enabled&&!b.enabled)room.epoch++;room.enabled=b.enabled;room.stableShareToken??=randomUUID();next.rooms[id]=room;await commit(next);return response(request,{enabled:room.enabled,roomId:id,shareToken:room.stableShareToken});
    }));
    lab.get('/snapshot',async request=>serialized(async()=>{
      return response(request,await issueSnapshot(roomId(query(request).roomId)));
    }));
    lab.get('/entry/:shareToken',async request=>serialized(async()=>{
      const token=(request.params as {shareToken:string}).shareToken;
      if(!UUID.test(token))throw new LabError(403,'SHARE_CLOSED','参观链接尚未开启或无效');
      const entry=Object.entries(state.rooms).find(([,room])=>room.stableShareToken===token);
      if(!entry)throw new LabError(403,'SHARE_CLOSED','参观链接尚未开启或无效');
      return response(request,await issueSnapshot(entry[0]));
    }));
    lab.get('/snapshot/:grant',async request=>serialized(async()=>response(request,checkedGrant((request.params as {grant:string}).grant).snapshot)));
    lab.get('/catalog',async request=>{
      const available=!state.modelDeleted&&await model().then(()=>true,()=>false);
      const names={table:'榆木书案',chair:'圈背木椅',cabinet:'双门藏柜',vase:'T03 真实生成样本'};
      return response(request,{items:Object.entries(ASSET_BOUNDS).map(([id,bounds])=>({id,name:names[id as keyof typeof names],bounds,available:id!=='vase'||available})),modelAvailable:available});
    });
    lab.get('/model',async(request,reply)=>serialized(async()=>{
      const q=query(request);
      if(Object.hasOwn(q,'grant')){
        const {snapshot,grant}=checkedGrant(q.grant);
        if(q.roomId!==undefined&&q.roomId!==grant.roomId)throw new LabError(403,'INVALID_GRANT','快照不属于此房间');
        if(!snapshot.placements.some(p=>p.assetId==='vase'))throw new LabError(403,'MODEL_OUT_OF_SCOPE','该快照没有此模型');
      }
      if(state.modelDeleted)throw new LabError(403,'ASSET_DELETED','模型已在本验证环境删除');
      return reply.type('model/gltf-binary').send(await model());
    }));
    lab.delete('/model',async request=>serialized(async()=>{
      if(state.modelDeleted)return response(request,{deleted:true});
      const next=structuredClone(state);next.modelDeleted=true;
      for(const room of Object.values(next.rooms)){
        if(!room.current.placements.some(p=>p.assetId==='vase'))continue;
        room.history[String(room.current.version)]=room.current;
        room.current={...room.current,version:room.current.version+1,placements:room.current.placements.filter(p=>p.assetId!=='vase')};room.history[String(room.current.version)]=room.current;
      }
      await commit(next);return response(request,{deleted:true});
    }));
  },{prefix:'/api/lab/t04'});
}
