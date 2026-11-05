import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {transform} from 'esbuild';

const source=await fs.readFile(new URL('../apps/web/src/room/save.ts',import.meta.url),'utf8');
// TypeScript 7's root package has no transpileModule; use the same installed
// esbuild transform already required by tsx/Vite to execute the actual source.
const compiled=(await transform(source,{loader:'ts',target:'es2022',format:'cjs'})).code;
class ApiError extends Error {constructor(status,message='fixture rejection'){super(message);this.status=status;}}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let n=0;n<10;n++)await Promise.resolve();};
const confirmed=(version=0,name='已确认布局')=>({id:randomUUID(),name,version,sceneVersion:'courtyard-v1',placements:[],assets:[],shareEnabled:false,shareUrl:null});
function harness(handler,{prepare=async()=>{}}={}){
 let now=0,nextTimer=0;const timers=new Map(),calls=[],changes=[];
 const api=async(url,options={})=>{const call={url,method:options.method??'GET',headers:{...options.headers},body:options.body,signal:options.signal};calls.push(call);return handler(call,calls);};
 const module={exports:{}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>{assert.equal(name,'../game/backpack-api.js');return {api,ApiError};},AbortController,structuredClone,crypto:{randomUUID},setTimeout:(callback,delay=0)=>{const id=++nextTimer;timers.set(id,{at:now+delay,callback});return id;},clearTimeout:id=>timers.delete(id)},{filename:'apps/web/src/room/save.ts'});
 const saver=new module.exports.PersonalRoomSave(()=> 'fixture-csrf',prepare,(room,state)=>changes.push({room:structuredClone(room),state:structuredClone(state)}));
 async function advance(ms){const until=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].callback();await settle();}now=until;await settle();}
 return {saver,calls,changes,advance,puts:()=>calls.filter(c=>c.method==='PUT')};
}

test('room save never PUTs an empty draft after initial GET or model preparation failure',async()=>{
 let readable=false;const h=harness(async c=>{if(c.method==='GET'){if(!readable)throw new ApiError(401);return confirmed();}throw Error('unexpected PUT');});
 try{await h.saver.load();assert.equal(h.saver.state.status,'loadFailed');assert.equal(h.saver.canEdit,false);h.saver.edit('不得保存',[]);await h.saver.flush();await h.advance(2000);assert.equal(h.puts().length,0);assert.equal(h.saver.current,null);
 readable=true;await h.saver.load();assert.equal(h.saver.canEdit,true);assert.equal(h.saver.state.status,'saved');}finally{h.saver.dispose();}
 const model=harness(async()=>confirmed(),{prepare:async()=>{throw Error('模型读取失败');}});try{await model.saver.load();model.saver.edit('不得保存',[]);await model.saver.flush();await model.advance(1000);assert.equal(model.puts().length,0);assert.equal(model.saver.canEdit,false);}finally{model.saver.dispose();}
});

test('room save debounces 500ms, serializes PUTs, and preserves newer edits during an old ACK',async()=>{
 const first=deferred();const h=harness(async c=>{if(c.method==='GET')return confirmed();const body=JSON.parse(c.body);return h.puts().length===1?first.promise:{savedVersion:2,editSequence:body.editSequence};});
 try{
  await h.saver.load();h.saver.edit('草稿A',[]);await h.advance(499);assert.equal(h.puts().length,0);h.saver.edit('草稿B',[]);await h.advance(499);assert.equal(h.puts().length,0);await h.advance(1);assert.equal(h.puts().length,1);assert.equal(JSON.parse(h.puts()[0].body).name,'草稿B');
  h.saver.edit('草稿C',[]);await h.advance(500);assert.equal(h.puts().length,1);const firstBody=JSON.parse(h.puts()[0].body);const changeStart=h.changes.length;first.resolve({savedVersion:1,editSequence:firstBody.editSequence});await settle();
  assert.equal(h.saver.current.name,'草稿C');assert.equal(h.saver.state.version,1);assert.equal(h.saver.state.status,'dirty');assert.equal(h.saver.unsaved,true);assert.ok(h.changes.slice(changeStart).every(v=>v.state.status!=='saved'));
  await h.advance(99);assert.equal(h.puts().length,1);await h.advance(1);assert.equal(h.puts().length,2);assert.equal(JSON.parse(h.puts()[1].body).name,'草稿C');assert.equal(JSON.parse(h.puts()[1].body).baseVersion,1);assert.equal(h.saver.state.status,'saved');assert.equal(h.saver.unsaved,false);
 }finally{h.saver.dispose();}
});

test('room save retries a lost response with exactly the original key/body before sending newer draft',async()=>{
 const retry=deferred();let puts=0;const h=harness(async c=>{if(c.method==='GET')return confirmed();puts++;if(puts===1)throw Error('server committed but response was lost');if(puts===2)return retry.promise;const b=JSON.parse(c.body);return {savedVersion:2,editSequence:b.editSequence};});
 try{
  await h.saver.load();h.saver.edit('已在服务端提交A',[]);await h.saver.flush();assert.equal(h.saver.state.status,'failed');const original=h.puts()[0];h.saver.edit('更新草稿B',[]);await h.advance(1500);assert.equal(h.puts().length,1);assert.equal(h.saver.current.name,'更新草稿B');
  const flight=h.saver.flush();await settle();assert.equal(h.puts().length,2);assert.equal(h.puts()[1].headers['Idempotency-Key'],original.headers['Idempotency-Key']);assert.equal(h.puts()[1].body,original.body);
  retry.resolve({savedVersion:1,editSequence:JSON.parse(original.body).editSequence});await flight;assert.equal(h.saver.state.status,'dirty');assert.equal(h.saver.current.name,'更新草稿B');await h.advance(100);assert.equal(h.puts().length,3);const next=h.puts()[2];assert.notEqual(next.headers['Idempotency-Key'],original.headers['Idempotency-Key']);assert.equal(JSON.parse(next.body).baseVersion,1);assert.equal(JSON.parse(next.body).name,'更新草稿B');assert.equal(h.saver.state.status,'saved');
 }finally{h.saver.dispose();}
});

for(const status of [422,413])test(`room save clears a definite ${status} rejection and commits a fresh corrected draft`,async()=>{
 const rejected=deferred();let puts=0;const h=harness(async c=>{if(c.method==='GET')return confirmed();puts++;if(puts===1)return rejected.promise;const b=JSON.parse(c.body);return {savedVersion:1,editSequence:b.editSequence};});
 try{
  await h.saver.load();h.saver.edit('被拒绝旧草稿',[]);const old=h.saver.flush();await settle();const original=h.puts()[0];h.saver.edit('已纠正新草稿',[]);rejected.reject(new ApiError(status,'布局被明确拒绝'));await old;assert.equal(h.saver.state.status,'dirty');await h.advance(100);assert.equal(h.puts().length,2);assert.notEqual(h.puts()[1].headers['Idempotency-Key'],original.headers['Idempotency-Key']);assert.equal(JSON.parse(h.puts()[1].body).name,'已纠正新草稿');assert.equal(JSON.parse(h.puts()[1].body).baseVersion,0);assert.equal(h.saver.state.status,'saved');
 }finally{h.saver.dispose();}
 const paused=harness(async c=>{if(c.method==='GET')return confirmed();if(paused.puts().length===1)throw new ApiError(status);const b=JSON.parse(c.body);return {savedVersion:1,editSequence:b.editSequence};});
 try{await paused.saver.load();paused.saver.edit('原草稿',[]);await paused.saver.flush();assert.equal(paused.saver.state.status,'rejected');await paused.advance(1000);assert.equal(paused.puts().length,1);paused.saver.edit('手动修正',[]);await paused.advance(500);assert.equal(paused.puts().length,2);assert.notEqual(paused.puts()[0].headers['Idempotency-Key'],paused.puts()[1].headers['Idempotency-Key']);assert.equal(paused.saver.state.status,'saved');}finally{paused.saver.dispose();}
});

test('room save retains a 409 draft and resumes only after an explicit load of confirmed state',async()=>{
 let getCount=0,putCount=0;const h=harness(async c=>{if(c.method==='GET')return confirmed(getCount++===0?0:7,getCount===1?'旧确认版':'另一页面的确认版');if(++putCount===1)throw new ApiError(409);const b=JSON.parse(c.body);return {savedVersion:8,editSequence:b.editSequence};});
 try{
  await h.saver.load();h.saver.edit('冲突草稿A',[]);await h.saver.flush();assert.equal(h.saver.state.status,'conflict');assert.equal(h.saver.current.name,'冲突草稿A');h.saver.edit('保留草稿B',[]);await h.advance(2000);await h.saver.flush();assert.equal(h.puts().length,1);assert.equal(h.saver.current.name,'保留草稿B');assert.equal(h.saver.unsaved,true);
  await h.saver.load();assert.equal(h.saver.state.status,'saved');assert.equal(h.saver.current.name,'另一页面的确认版');assert.equal(h.saver.current.version,7);h.saver.edit('确认版后的新修改',[]);await h.advance(500);assert.equal(h.puts().length,2);assert.equal(JSON.parse(h.puts()[1].body).baseVersion,7);assert.equal(h.saver.state.status,'saved');
 }finally{h.saver.dispose();}
});
