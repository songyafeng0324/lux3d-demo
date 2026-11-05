import type { Placement } from '@aholo/contracts';
export interface Layout {version:number;sceneVersion:string;name:string;placements:Placement[];shareEnabled?:boolean;shareToken?:string}
export type SaveStatus='loading'|'loadFailed'|'saved'|'dirty'|'saving'|'failed'|'rejected'|'conflict';
export interface SaveState {status:SaveStatus;version:number;sequence:number;message:string}
let editorToken='';
export function editorHeaders(){return {'X-T04-Lab':'1','X-T04-Editor':editorToken};}
export async function initEditor(){const r=await fetch('/api/lab/t04/session',{method:'POST',headers:{'X-T04-Lab':'1'}});if(!r.ok)throw Error('实验编辑会话不可用');const b=await r.json();editorToken=b.data.editorToken;}
export async function editorFetch(url:string,options:RequestInit={}){
 const send=()=>{const headers=new Headers(options.headers);for(const [k,v] of Object.entries(editorHeaders()))headers.set(k,v);return fetch(url,{...options,headers});};
 let response=await send();
 if(response.status===403&&(await response.clone().json().catch(()=>({}))).error?.code==='EDITOR_REQUIRED'){await initEditor();response=await send();}
 return response;
}
export class RoomSave {
 current:Layout={version:0,sceneVersion:'courtyard-v1',name:'听雨小筑',placements:[]};
 state:SaveState={status:'loading',version:0,sequence:0,message:''};
 private timer:ReturnType<typeof setTimeout>|undefined;private pending:{key:string;body:object;sequence:number}|undefined;
 private flight=false;private closed=false;private loaded=false;private abort?:AbortController;
 constructor(readonly roomId:string,private changed:(layout:Layout,state:SaveState)=>void){}
 private emit(status:SaveStatus,message=''){if(this.closed)return;this.state={...this.state,status,message};this.changed(this.current,{...this.state});}
 async load(){
  if(this.flight||this.closed)return;clearTimeout(this.timer);this.emit('loading');
  try{const r=await editorFetch(`/api/lab/t04/room?roomId=${this.roomId}`,{headers:editorHeaders(),cache:'no-store'});if(!r.ok)throw Error();const b=await r.json();if(this.closed)return;this.pending=undefined;this.loaded=true;this.current=b.data;this.state={status:'saved',version:this.current.version,sequence:0,message:''};this.changed(this.current,{...this.state});}
  catch{this.emit('loadFailed','无法读取已保存布置。重试读取成功前不会提交新布局。');}
 }
 edit(name:string,placements:Placement[]){
  if(this.closed||!this.canEdit)return;
  this.current={...this.current,name,placements:structuredClone(placements)};this.state.sequence++;
  if(this.state.status==='conflict'){this.emit('conflict','另一页面已更新房间。本页修改保留，请先处理版本冲突。');return;}
  if(this.state.status==='rejected')this.pending=undefined;
  const paused=this.state.status==='failed';this.emit(paused?'failed':this.flight?'saving':'dirty',paused?'保存失败，本页修改保留。点击重试。':'');
  clearTimeout(this.timer);if(!paused)this.timer=setTimeout(()=>void this.flush(),500);
 }
 async flush(){
  if(this.closed||this.flight||this.state.status==='conflict'||!this.loaded||['loading','loadFailed','saved'].includes(this.state.status))return;
  clearTimeout(this.timer);
  if(!this.pending)this.pending={key:crypto.randomUUID(),sequence:this.state.sequence,body:{baseVersion:this.state.version,editSequence:this.state.sequence,name:this.current.name,placements:structuredClone(this.current.placements)}};
  const request=this.pending;this.flight=true;this.abort=new AbortController();this.emit('saving');const timeout=setTimeout(()=>this.abort?.abort(),5000);
  try{
   const r=await editorFetch(`/api/lab/t04/room?roomId=${this.roomId}`,{method:'PUT',headers:{...editorHeaders(),'Content-Type':'application/json','Idempotency-Key':request.key},body:JSON.stringify(request.body),signal:this.abort.signal});const b=await r.json();if(this.closed)return;
   if(r.status===409){this.emit('conflict','另一页面已更新房间。本页修改保留，重新载入会放弃本页未保存修改。');return;}
   if([400,413,422].includes(r.status)){this.pending=undefined;if(this.state.sequence>request.sequence)this.emit('dirty');else this.emit('rejected',b.error?.message||'布置未通过校验。修改后会重新尝试保存。');return;}
   if(!r.ok)throw Error();
   if(b.data.editSequence!==request.sequence||!Number.isInteger(b.data.version)||b.data.version<this.state.version)throw Error('保存回执无效');
   this.state.version=b.data.version;this.current.version=b.data.version;this.pending=undefined;this.emit(this.state.sequence===request.sequence?'saved':'dirty');
  }catch{this.emit('failed','保存未获确认，本页修改保留。点击重试会恢复同一次请求。');}
  finally{clearTimeout(timeout);this.flight=false;if(!this.closed&&this.state.status==='dirty')this.timer=setTimeout(()=>void this.flush(),100);}
 }
 get canEdit(){return this.loaded&&!['loading','loadFailed'].includes(this.state.status);}
 get unsaved(){return this.loaded&&this.state.status!=='saved';}
 dispose(){this.closed=true;clearTimeout(this.timer);this.abort?.abort();}
}
