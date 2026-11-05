import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Lux3dCnClient,recoveryDecision} from '@aholo/domain';
const params={img:'https://holo-cos.aholo3d.cn/test.png',version:'G1-Turbo',faceCount:50000,outputFormat:['glb'],enablePbr:true,aiPredictSize:false};
const ok=d=>new Response(JSON.stringify({c:'0',m:'',d}),{status:200});
const failure=(code)=>e=>e.code===code&&!JSON.stringify(e).includes('private-key');
test('create transport performs exactly one call on timeout, 5xx or malformed accepted response',async()=>{
 for(const fn of [async()=>{throw new Error('network private-key https://private.invalid/?signature=secret')},async()=>new Response('error',{status:503}),async()=>ok({notAnId:true})]){
  let count=0;const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async(...args)=>{count++;return fn(...args)}});
  await assert.rejects(()=>c.createImageTask(params),failure('submission_unknown'));assert.equal(count,1);
 }
 let count=0;const c=new Lux3dCnClient({apiKey:'private-key',timeoutMs:5,fetchImpl:async()=>{count++;return new Promise(()=>{})}});await assert.rejects(()=>c.createImageTask(params),failure('submission_unknown'));assert.equal(count,1);
});
test('create keeps int64 IDs as exact strings and rejects invalid input before dispatch',async()=>{
 let calls=0;const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async(url,init)=>{calls++;assert.equal(new URL(url).origin,'https://api.aholo3d.cn');assert.equal(init.redirect,'error');return new Response('{"c":"0","d":9007199254740993}') }});
 assert.equal(await c.createImageTask(params),'9007199254740993');
 await assert.rejects(()=>c.createImageTask({...params,imgs:['https://example.invalid/image']}),failure('input_invalid'));
 await assert.rejects(()=>c.createImageTask({...params,img:'http://127.0.0.1/private'}),failure('input_invalid'));
 await assert.rejects(()=>c.createImageTask({...params,faceCount:NaN}),failure('input_invalid'));assert.equal(calls,1);
});
test('query health and task status are distinct; partial outputs never become a usable result',async()=>{
 const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async()=>new Response('{"c":"0","d":{"taskId":9007199254740993,"status":1,"outputs":[{"content":"https://holo-cos.aholo3d.cn/partial.glb"}]}}')});
 const r=await c.getTask('9007199254740993');assert.equal(r.taskId,'9007199254740993');assert.equal(r.status,1);assert.throws(()=>c.parseMeshOutputs(r,params),failure('output_not_ready'));
 const bad=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async()=>new Response('not-json')});await assert.rejects(()=>bad.getTask('123'),failure('query_error'));
});
test('output slots use documented profile, preserve placeholders, and allow observed COS result host only for results',()=>{
 const c=new Lux3dCnClient({apiKey:'private-key'});const url='https://tx-qhsmodel-1258830046.cos.ap-shanghai.myqcloud.com/result.glb?sign=private';
 assert.equal(c.parseMeshOutputs({taskId:'1',status:3,outputs:[{content:url}]},params)[0].format,'glb');
 assert.throws(()=>c.parseMeshOutputs({taskId:'1',status:3,outputs:[{content:'NOT_REQUESTED'}]},params),failure('output_invalid'));
 assert.throws(()=>c.parseMeshOutputs({taskId:'1',status:3,outputs:[{content:'https://evil.myqcloud.com/a.glb'}]},params),failure('output_invalid'));
 assert.throws(()=>c.parseMeshOutputs({taskId:'1',status:3,outputs:[{content:'https://holo-cos.aholo3d.cn/a.glb'}]},{version:'G1',outputFormat:['glb']}),failure('output_invalid'));
});
test('small upload separates Authorization from OUS token and checks final status',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-upload-'));const file=path.join(dir,'test.png');await fs.writeFile(file,'image fixture');let calls=0;
 try{const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async(url,init)=>{calls++;const u=new URL(url);if(u.pathname==='/asset/v1/token'){assert.equal(init.headers.Authorization,'private-key');return new Response(JSON.stringify({ousToken:'ous-only',globalDomain:'https://ous-cos.kujiale.com',blockSize:1024}));}assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers['ous-token-v2'],'ous-only');if(u.pathname.endsWith('/single/upload')){assert.equal(init.body.get('file').name,'test.png');assert.equal(init.body.get('md5').length,32);return ok({taskId:'upload-string-id'});}return ok({status:5,url:'https://holo-cos.aholo3d.cn/test.png'});}});const r=await c.uploadFile(file);assert.equal(r.byteSize,13);assert.equal(calls,3);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('block init uses query parameters and upload parts retain correct bytes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-block-'));const file=path.join(dir,'test.png');await fs.writeFile(file,'abcdef');let parts=[];
 try{const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async(url,init)=>{const u=new URL(url);if(u.pathname==='/asset/v1/token')return new Response(JSON.stringify({ousToken:'ous-only',globalDomain:'https://ous-cos.kujiale.com',blockSize:2}));if(u.pathname.endsWith('/init')){assert.equal(u.searchParams.get('blocks'),'3');assert.equal(init.body,undefined);return ok({taskId:123,lackBlocks:['1-3'],deduplicated:false});}if(u.pathname.endsWith('/part')){parts.push([init.body.get('block'),await init.body.get('file').text()]);return new Response('{"c":"0","m":""}');}return ok({status:5,url:'https://holo-cos.aholo3d.cn/test.png'});}});await c.uploadFile(file);assert.deepEqual(parts,[['1','ab'],['2','cd'],['3','ef']]);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('unknown create responses stay quarantined; only documented rejection can be released',async()=>{
 for(const code of [409,429,502]){const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async()=>new Response('gateway',{status:code})});await assert.rejects(()=>c.createImageTask(params),failure('submission_unknown'));}
 for(const code of ['UNRECOGNIZED_ERROR','UNKNOWN_SERVER_FAILURE']){const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async()=>new Response(JSON.stringify({c:code,d:null}))});await assert.rejects(()=>c.createImageTask(params),failure('submission_unknown'));}
 for(const code of ['-1','GENERATION_CONCURRENCY_LIMIT_EXCEEDED']){const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async()=>new Response(JSON.stringify({c:code,d:null}))});await assert.rejects(()=>c.createImageTask(params),failure('submission_rejected'));}
});
test('live OUS obsTaskId compatibility does not change the gateway authorization boundary',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-ous-'));const file=path.join(dir,'test.png');await fs.writeFile(file,'fixture');
 try{const c=new Lux3dCnClient({apiKey:'private-key',fetchImpl:async(url)=>{const p=new URL(url).pathname;if(p==='/asset/v1/token')return new Response(JSON.stringify({ousToken:'ous',globalDomain:'https://ous-cos.kujiale.com',blockSize:1024}));if(p.endsWith('/single/upload'))return ok({obsTaskId:'live-opaque-id'});return ok({status:5,url:'https://holo-cos.aholo3d.cn/result.png'});}});assert.equal((await c.uploadFile(file)).taskId,'live-opaque-id');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('recovery is bounded, never creates again, and does not resurrect a terminal delivery',()=>{
 const base={localStatus:'submission_unknown',deliveryVerified:false,deadlineAt:100,now:10};
 assert.deepEqual(recoveryDecision(base),{action:'quarantine_and_reconcile',mayCreate:false,retainProviderReservation:true});
 assert.equal(recoveryDecision({...base,now:100}).action,'finalize_failure_once');assert.equal(recoveryDecision({...base,now:100}).retainProviderReservation,true);
 assert.equal(recoveryDecision({...base,providerTaskId:'1',providerStatus:3}).action,'ingest_original');
 assert.equal(recoveryDecision({...base,providerTaskId:'1',providerStatus:3,deliveryVerified:true}).action,'finalize_success_once');
 assert.equal(recoveryDecision({...base,now:100,providerTaskId:'1',providerStatus:3,deliveryVerified:true}).action,'finalize_success_once');
 assert.equal(recoveryDecision({...base,localStatus:'failed',providerTaskId:'1',providerStatus:3,deliveryVerified:true}).action,'preserve_terminal');
 assert.equal(recoveryDecision({...base,providerTaskId:'1',providerStatus:1}).action,'query_original');
});
