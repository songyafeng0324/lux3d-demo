import {createPool,loadConfig,seedAdmin} from '@aholo/domain';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
if(!process.stdin.isTTY)throw new Error('Admin seed needs an interactive terminal; password is not accepted as a CLI argument.');
const rl=createInterface({input:process.stdin,output:process.stdout});const username=await rl.question('Admin username: ');const nickname=await rl.question('Display name: ');rl.close();
process.stdout.write('New admin password (hidden): ');
const muted=new Writable({write(_chunk,_encoding,cb){cb();}});
const secretRl=createInterface({input:process.stdin,output:muted,terminal:true});const password=await secretRl.question('');secretRl.close();process.stdout.write('\n');
if(!/^[a-zA-Z0-9_]{3,32}$/.test(username)||!nickname.trim()||password.length<12||password.length>128)throw new Error('Invalid admin input. Username 3-32 ASCII; password 12-128 characters.');
const pool=createPool(loadConfig().databaseUrl);
try{const result=await seedAdmin(pool,{username,nickname,password});console.log(result.created?'Admin created.':'Account already exists; unchanged.');}finally{await pool.end();}
