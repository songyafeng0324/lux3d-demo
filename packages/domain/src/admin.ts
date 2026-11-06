import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {transaction} from './index.js';
import {createPersonalRoom,hashPassword} from './accounts.js';
export async function seedAdmin(pool:pg.Pool,input:{username:string;nickname:string;password:string}) {
 const {username,nickname,password}=input;
 if(!/^[a-zA-Z0-9_]{3,32}$/.test(username)||!nickname.trim()||nickname.trim().length>40||password.length<12||password.length>128)throw new Error('Invalid admin input');
 const hash=await hashPassword(password);
 return transaction(pool,async c=>{
  const {rows}=await c.query("INSERT INTO users(id,username_key,username_display,nickname,password_hash,role) VALUES($1,$2,$3,$4,$5,'admin') ON CONFLICT(username_key) DO NOTHING RETURNING id",[randomUUID(),username.toLowerCase(),username,nickname.trim(),hash]);
  if(!rows.length)return {created:false};
  await createPersonalRoom(c,rows[0].id);
  return {created:true};
 });
}
