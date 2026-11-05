import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {registerT04Lab} from '../apps/api/dist/t04.js';
const base='/api/lab/t04';
const placement=(change={})=>({id:'p1',assetId:'vase',position:[0,0,0],rotation:[0,0,0],scale:1,...change});
const save=(change={})=>({baseVersion:0,editSequence:1,name:'我的小屋',placements:[placement()],...change});
async function fixture(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-t04-'));const modelPath=path.join(dir,'fixture.glb');const bytes=Buffer.from('model transport fixture - not a renderable or generated model');await fs.writeFile(modelPath,bytes);
 const options={stateDir:path.join(dir,'state'),modelPath,modelSha256:createHash('sha256').update(bytes).digest('hex')};
 const apps=[];const app=async(extra={})=>{const a=Fastify();await registerT04Lab(a,{...options,...extra});const session=await a.inject({method:'POST',url:base+'/session',remoteAddress:'127.0.0.1',headers:{host:'localhost:5173','x-t04-lab':'1'}});a.testEditor=session.json().data.editorToken;apps.push(a);return a;};
 try{await fn({app,options,dir,bytes});}finally{await Promise.all(apps.map(a=>a.close()));await fs.rm(dir,{recursive:true,force:true});}
}
function inject(a,method,url,payload,headers={}){return a.inject({method,url,remoteAddress:'127.0.0.1',headers:{host:'localhost:5173','x-t04-lab':'1','x-t04-editor':a.testEditor,'idempotency-key':randomUUID(),...headers},payload});}

test('T04 CAS, concurrent idempotency, lost-response replay and restart preserve exact layout',()=>fixture(async({app})=>{
 let a=await app();const id=randomUUID();const url=`${base}/room?roomId=${id}`;const payload=save({placements:Array.from({length:1500},(_,i)=>placement({id:'p'+i}))});const key=randomUUID();
 const results=await Promise.all([inject(a,'PUT',url,payload,{'idempotency-key':key}),inject(a,'PUT',url,payload,{'idempotency-key':key})]);assert(results.every(r=>r.statusCode===200));assert.deepEqual(results[0].json().data,results[1].json().data);assert.equal(results[0].json().data.placements.length,1500);
 const conflict=await inject(a,'PUT',url,save());assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error.currentVersion,1);
 assert.equal((await inject(a,'PUT',url,save(),{'idempotency-key':key})).statusCode,409);
 await a.close();a=await app();const replay=await inject(a,'PUT',url,payload,{'idempotency-key':key});assert.equal(replay.statusCode,200);assert.equal(replay.json().data.version,1);
 const room=(await inject(a,'GET',url)).json().data;assert.equal(room.placements.length,1500);assert.equal(room.version,1);
 const competing=await Promise.all([inject(a,'PUT',url,save({baseVersion:1,editSequence:2,name:'页面A'})),inject(a,'PUT',url,save({baseVersion:1,editSequence:2,name:'页面B'}))]);assert.deepEqual(competing.map(r=>r.statusCode).sort(),[200,409]);
}));
test('T04 storage failure does not acknowledge edits or advance room; retry is safe',()=>fixture(async({app})=>{
 let fail=true;const a=await app({beforeCommit:async()=>{if(fail)throw new Error('controlled disk failure');}});const url=`${base}/room?roomId=${randomUUID()}`;const key=randomUUID();
 const rejected=await inject(a,'PUT',url,save(),{'idempotency-key':key});assert.equal(rejected.statusCode,503);assert.equal((await inject(a,'GET',url)).json().data.version,0);
 fail=false;assert.equal((await inject(a,'PUT',url,save(),{'idempotency-key':key})).json().data.version,1);
}));
test('T04 snapshot remains frozen through ordinary removal but close/delete revoke fresh resources',()=>fixture(async({app,bytes})=>{
 const a=await app();const id=randomUUID();const url=`${base}/room?roomId=${id}`;
 await inject(a,'PUT',url,save({placements:[placement(),placement({id:'table',assetId:'table'})]}));await inject(a,'PUT',`${base}/share`,{roomId:id,enabled:true});
 const grant=(await inject(a,'GET',`${base}/snapshot?roomId=${id}`)).json().data.grant;
 await inject(a,'PUT',url,save({baseVersion:1,editSequence:2,placements:[placement({id:'table',assetId:'table'})]}));
 const frozen=await inject(a,'GET',`${base}/snapshot/${grant}`);assert.equal(frozen.statusCode,200);assert.equal(frozen.json().data.placements.length,2);
 const model=await inject(a,'GET',`${base}/model?grant=${grant}`);assert.equal(model.statusCode,200);assert(model.rawPayload.equals(bytes));
 assert.equal((await inject(a,'GET',`${base}/model?grant=invalid`)).statusCode,403);
 assert.equal((await inject(a,'GET',`${base}/model?grant=${grant}&roomId=${randomUUID()}`)).statusCode,403);
 await inject(a,'PUT',`${base}/share`,{roomId:id,enabled:false});assert.equal((await inject(a,'GET',`${base}/model?grant=${grant}`)).statusCode,403);assert.equal((await inject(a,'GET',`${base}/snapshot?roomId=${id}`)).statusCode,403);
 await inject(a,'PUT',`${base}/share`,{roomId:id,enabled:true});assert.equal((await inject(a,'GET',`${base}/model?grant=${grant}`)).statusCode,403);
 await inject(a,'PUT',url,save({baseVersion:2,editSequence:3,placements:[placement(),placement({id:'table',assetId:'table'})]}));const currentGrant=(await inject(a,'GET',`${base}/snapshot?roomId=${id}`)).json().data.grant;
 await inject(a,'DELETE',`${base}/model`);assert.equal((await inject(a,'GET',`${base}/model`)).statusCode,403);assert.equal((await inject(a,'GET',`${base}/model?grant=${currentGrant}`)).statusCode,403);
 const current=(await inject(a,'GET',url)).json().data;assert.equal(current.placements.length,1);assert.equal(current.placements[0].assetId,'table');assert.equal(current.version,4);
 assert.equal((await inject(a,'PUT',url,save({baseVersion:4,editSequence:4}))).statusCode,422);
}));
test('T04 local gate, invalid geometry and invalid transport never create a saved version',()=>fixture(async({app})=>{
 const a=await app();const url=`${base}/room?roomId=${randomUUID()}`;
 for(const origin of ['https://evil.invalid','null','http://localhost:5173.evil.invalid'])assert.equal((await inject(a,'PUT',url,save(),{origin})).statusCode,403);
 assert.equal((await a.inject({method:'GET',url,remoteAddress:'192.168.1.2',headers:{host:'localhost:5173'}})).statusCode,403);
 assert.equal((await inject(a,'PUT',url,save(),{host:'rebind.invalid'})).statusCode,403);
 assert.equal((await inject(a,'PUT',url,save(),{'x-t04-lab':'0'})).statusCode,403);
 for(const placements of [[placement({position:[6,0,0]})],[placement(),placement()],[placement({scale:-1})]])assert.equal((await inject(a,'PUT',url,save({placements}))).statusCode,422);
 assert.equal((await inject(a,'PUT',`${base}/room?roomId=../secret`,save())).statusCode,422);
 assert.equal((await inject(a,'GET',url)).json().data.version,0);
}));

test('T04 stable share entry refreshes confirmed version and strictly separates editor from visitor',()=>fixture(async({app})=>{
 let a=await app();const id=randomUUID();const url=`${base}/room?roomId=${id}`;
 const visit=(method,url,payload,headers={})=>a.inject({method,url,remoteAddress:'127.0.0.1',headers:{host:'localhost:5173',...headers},payload});
 await inject(a,'PUT',url,save());
 const shared=await inject(a,'PUT',base+'/share',{roomId:id,enabled:true});const token=shared.json().data.shareToken;assert.match(token,/^[0-9a-f-]{36}$/);
 assert.equal((await inject(a,'GET',url)).json().data.shareToken,token);
 const entry=await visit('GET',base+'/entry/'+token);assert.equal(entry.statusCode,200);const grant=entry.json().data.grant;assert.equal(entry.json().data.version,1);assert.equal(entry.json().data.editorToken,undefined);assert.equal(entry.json().data.shareToken,undefined);
 for(const resource of [url,base+'/catalog',base+'/model',base+'/snapshot?roomId='+id])assert.equal((await visit('GET',resource)).statusCode,403);
 assert.equal((await visit('GET',base+'/model?grant='+grant)).statusCode,200);
 assert.equal((await visit('GET',base+'/model?grant='+grant+'&roomId='+randomUUID())).statusCode,403);
 for(const invalid of ['', 'bad-token'])assert.equal((await visit('GET',base+'/model?grant='+invalid)).statusCode,403);
 assert.equal((await visit('GET',base+'/model',undefined,{'x-t04-editor':'invalid'})).statusCode,403);
 assert.equal((await visit('PUT',url,save({baseVersion:1}),{'x-t04-lab':'1','idempotency-key':randomUUID()})).statusCode,403);
 await inject(a,'PUT',url,save({baseVersion:1,editSequence:2,name:'已确认新版',placements:[]}));
 assert.equal((await visit('GET',base+'/snapshot/'+grant)).json().data.version,1);
 const refreshed=await visit('GET',base+'/entry/'+token);assert.equal(refreshed.json().data.version,2);assert.equal(refreshed.json().data.name,'已确认新版');const newGrant=refreshed.json().data.grant;
 assert.equal((await visit('GET',base+'/model?grant='+newGrant)).statusCode,403);
 await inject(a,'PUT',base+'/share',{roomId:id,enabled:false});assert.equal((await visit('GET',base+'/entry/'+token)).statusCode,403);assert.equal((await visit('GET',base+'/model?grant='+grant)).statusCode,403);
 const reopened=await inject(a,'PUT',base+'/share',{roomId:id,enabled:true});assert.equal(reopened.json().data.shareToken,token);assert.equal((await visit('GET',base+'/entry/'+token)).json().data.version,2);assert.equal((await visit('GET',base+'/model?grant='+grant)).statusCode,403);
 const oldEditor=a.testEditor;await a.close();a=await app();assert.equal((await inject(a,'GET',url)).json().data.shareToken,token);assert.equal((await visit('GET',base+'/entry/'+token)).json().data.version,2);
 assert.equal((await visit('GET',url,undefined,{'x-t04-editor':oldEditor})).statusCode,403);
}));

test('T04 test-server Host and Origin match actual socket port, never arbitrary caller ports',()=>fixture(async({app})=>{
 const a=await app();await a.listen({host:'127.0.0.1',port:0});const address=a.server.address();assert.equal(typeof address,'object');const port=address.port;
 const bootstrap=await a.inject({method:'POST',url:base+'/session',remoteAddress:'127.0.0.1',headers:{host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`,'x-t04-lab':'1'}});assert.equal(bootstrap.statusCode,200);
 const wrongPort=port===13004?13005:13004;
 for(const headers of [{host:`127.0.0.1:${wrongPort}`},{host:'127.0.0.1:3001'},{host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${wrongPort}`}]){
  const refused=await a.inject({method:'POST',url:base+'/session',remoteAddress:'127.0.0.1',headers:{'x-t04-lab':'1',...headers}});assert.equal(refused.statusCode,403);
 }
}));
