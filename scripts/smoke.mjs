import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {loadConfig,createPool} from '@aholo/domain';
loadConfig();
const origin='http://127.0.0.1:13001';
const env={...process.env,API_HOST:'127.0.0.1',API_PORT:'13001',PUBLIC_ORIGIN:origin};
const api=spawn(process.execPath,['apps/api/dist/index.js'],{env,stdio:'ignore'});
let worker;let browser;
async function wait(fn){let last;for(let i=0;i<80;i++){try{return await fn();}catch(e){last=e;await delay(150);}}throw last;}
async function stop(p){if(!p||p.exitCode!==null)return;const ended=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await Promise.race([ended,delay(4000).then(()=>{if(p.exitCode===null)p.kill('SIGKILL');})]);}
try{
 await wait(async()=>{const r=await fetch(origin+'/api/v1/health/live');assert.equal(r.status,200);});
 const live=await fetch(origin+'/api/v1/health/live').then(r=>r.json());assert.equal(live.data.status,'ok');
 // No other worker is running during this smoke test: absence must be visible.
 const pool=createPool(loadConfig().databaseUrl);await pool.query('DELETE FROM worker_heartbeats WHERE last_seen < now() - interval \'10 seconds\'');await pool.end();
 const before=await fetch(origin+'/api/v1/health/ready');assert.equal(before.status,503);assert.equal((await before.json()).data.checks.worker,'unavailable');
 worker=spawn(process.execPath,['apps/worker/dist/index.js'],{env,stdio:'ignore'});
 const health=await wait(async()=>{const r=await fetch(origin+'/api/v1/health/ready');const j=await r.json();assert.equal(r.status,200);return j.data;});assert.equal(health.generationReady,false);
 for(const p of ['/api/v1/missing','/api','/api%2Fv1%2Fmissing','/missing.js']){const r=await fetch(origin+p,{headers:{accept:'text/html'}});assert.equal(r.status,404);assert.match(r.headers.get('content-type'),/json/);}
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1360,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/workbench');await page.getByText('基础服务可用',{exact:true}).waitFor({timeout:10000});
 await fs.mkdir('docs/validation/evidence',{recursive:true});await page.screenshot({path:'docs/validation/evidence/T05-local-workbench.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',browser:await browser.version(),live:true,workerAbsence503:true,ready:true,generationReady:false,apiFallback:true,pageErrors:errors.length}));
 await stop(worker);worker=undefined;await wait(async()=>{const r=await fetch(origin+'/api/v1/health/ready');assert.equal(r.status,503);});
}finally{await browser?.close();await stop(worker);await stop(api);}
