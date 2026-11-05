// Live upload-only check. No model creation or pricing endpoint is called.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {loadConfig,readLux3dCnKey,Lux3dCnClient} from '@aholo/domain';
loadConfig();const key=readLux3dCnKey();if(!key)throw new Error('China credentials unavailable');
const response=await fetch('https://api.aholo3d.cn/asset/v1/token',{headers:{Authorization:key},redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('Upload token unavailable');const token=await response.json();
if(!Number.isSafeInteger(token.blockSize)||token.blockSize<32768||token.blockSize>8*1024*1024)throw new Error('Fixture resource budget exceeded');
const png=await fs.readFile('tests/fixtures/lux3d-vase.png');const data=Buffer.alloc(token.blockSize+17-png.length-12,65);Buffer.from('Comment\0T03 upload fixture').copy(data);const type=Buffer.from('tEXt');const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length,0);type.copy(chunk,4);data.copy(chunk,8);chunk.writeUInt32BE(zlib.crc32(Buffer.concat([type,data])),chunk.length-4);
const bytes=Buffer.concat([png.subarray(0,png.length-12),chunk,png.subarray(png.length-12)]);const file=path.join(os.homedir(),'Library/Application Support/aholo-lux3d/t03/block-fixture.png');await fs.writeFile(file,bytes,{mode:0o600,flag:'wx'});let parts=0,init=0;
try{const client=new Lux3dCnClient({apiKey:key,fetchImpl:async(url,options)=>{const p=new URL(url).pathname;if(p.endsWith('/part'))parts++;if(p.endsWith('/init'))init++;return fetch(url,options);}});const result=await client.uploadFile(file);const evidence={status:'passed',format:'png',bytes:result.byteSize,blockSize:token.blockSize,blockInitRequests:init,blockPartRequests:parts,uploadedAboveThreshold:result.byteSize>token.blockSize,urlHost:new URL(result.url).hostname,checkedAt:new Date().toISOString()};await fs.writeFile('docs/validation/evidence/T03-block-upload.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
catch(e){console.error(JSON.stringify({status:'failed',code:e.code||'probe_error',operation:e.operation}));process.exitCode=1;}
finally{await fs.unlink(file);}
