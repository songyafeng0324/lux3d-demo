import {spawn} from 'node:child_process';
import {loadConfig} from '@aholo/domain';
import {stopProcessGroups} from './process-group.mjs';
loadConfig();
const children=['@aholo/api','@aholo/worker','@aholo/web'].map(name=>spawn(process.execPath,[process.env.npm_execpath,'run','dev','-w',name],{stdio:'inherit',env:{...process.env,AHOLO_T04_LAB:"1"},detached:true}));
let stopping=false;
async function stop(code=0){
 if(stopping)return;
 stopping=true;
 try {
   // A detached npm wrapper and its descendants share one process group.
   // Wrapper exit does not establish that its descendants have stopped.
   await stopProcessGroups(children.map(c=>c.pid));
   process.exitCode=code;
 } catch {
   console.error('开发进程组清理未完成，请检查残留进程。');
   process.exitCode=1;
 }
}
for(const c of children){c.on('error',()=>stop(1));c.on('exit',code=>{if(!stopping)stop(code||1);});}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
