import type pg from 'pg';
import {randomBytes,randomUUID,scrypt as scryptCb} from 'node:crypto';
import {transaction} from './index.js';
export async function seedAdmin(pool:pg.Pool,input:{username:string;nickname:string;password:string}) {
 const {username,nickname,password}=input;
 if(!/^[a-zA-Z0-9_]{3,32}$/.test(username)||!nickname.trim()||nickname.trim().length>40||password.length<12||password.length>128)throw new Error('Invalid admin input');
 const salt=randomBytes(16);const derived=await new Promise<Buffer>((resolve,reject)=>scryptCb(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024},(error,key)=>error?reject(error):resolve(key)));
 const hash=`scrypt$131072$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
 return transaction(pool,async c=>{const row=await c.query('INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(username_key) DO NOTHING RETURNING id',[randomUUID(),username.toLowerCase(),username,nickname.trim(),hash,'admin']);return {created:row.rowCount===1};});
}
