import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
const valid=(key:string)=> /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key);
export class LocalFileStore {
  readonly root:string;
  private identity?:{ino:number;dev:number;real:string};
  constructor(root:string) { this.root=path.resolve(root); }
  async initialize() { await fs.mkdir(this.root,{recursive:true,mode:0o700});
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error('Storage root cannot be a symlink');
    const st=await fs.lstat(this.root);if(!this.identity)this.identity={ino:st.ino,dev:st.dev,real:await fs.realpath(this.root)};
    await this.guardRoot();
    for(const name of ['objects','staging','backups']) {const p=path.join(this.root,name);await fs.mkdir(p,{recursive:true,mode:0o700});await this.directory(name);} }
  private async guardRoot(){const st=await fs.lstat(this.root);if(!this.identity||st.isSymbolicLink()||!st.isDirectory()||st.ino!==this.identity.ino||st.dev!==this.identity.dev||await fs.realpath(this.root)!==this.identity.real)throw new Error('Storage root identity changed');}
  private async directory(name:string) {await this.guardRoot();const p=path.join(this.root,name);const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('Invalid storage directory');
    if(await fs.realpath(p)!==path.join(this.identity!.real,name))throw new Error('Storage directory escaped root');return p;}
  private async location(kind:string,key:string) {if(!valid(key))throw new Error('Invalid object key');return path.join(await this.directory(kind),key);}
  async putStaged(data:Uint8Array|Readable):Promise<string> {
    const id=randomUUID();const file=await this.location('staging',id);const h=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {if(data instanceof Uint8Array)await h.writeFile(data);else for await(const chunk of data)await h.writeFile(chunk);await h.sync();}
    catch(e){await h.close();await fs.unlink(file).catch(()=>{});throw e;}await h.close();return id;
  }
  private async metadata(file:string){const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const hash=createHash('sha256');let bytes=0;
    try{if(!(await h.stat()).isFile())throw new Error('Not a regular file');for await(const chunk of h.createReadStream({autoClose:false})){hash.update(chunk);bytes+=chunk.length;}}finally{await h.close();}return {sha256:hash.digest('hex'),byteSize:bytes};}
  async commit(staged:string,key=staged,expectedSha256?:string) {const src=await this.location('staging',staged);const dest=await this.location('objects',key);
    let source;try{source=await this.metadata(src);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(!source&&!expectedSha256)throw new Error('Retry without staging requires expected checksum');
    if(source&&expectedSha256&&source.sha256!==expectedSha256)throw new Error('Staged checksum conflict');
    if(source){try{await fs.link(src,dest);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
    const object=await this.metadata(dest);
    if((source&&(source.sha256!==object.sha256||source.byteSize!==object.byteSize))||(expectedSha256&&object.sha256!==expectedSha256))throw new Error('Object checksum conflict');
    if(source)await fs.unlink(src).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
    const dir=await fs.open(path.dirname(dest),'r');try{await dir.sync();}finally{await dir.close();}
    return {objectKey:key,...object};
  }
  async openRead(key:string) {const p=await this.location('objects',key);const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);if(!(await h.stat()).isFile()){await h.close();throw new Error('Not a regular file');}return h.createReadStream();}
  async stat(key:string) {const p=await this.location('objects',key);const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await h.stat();if(!st.isFile())throw new Error('Not a regular file');return st;}finally{await h.close();}}
  async delete(key:string) {await fs.unlink(await this.location('objects',key)).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});}
  async probe(){await this.directory('backups');const staged=await this.putStaged(Buffer.from('storage probe'));let committed=false;
    try{const object=await this.commit(staged);committed=true;const stream=await this.openRead(object.objectKey);let read='';for await(const b of stream)read+=b.toString();if(read!=='storage probe')throw new Error('Storage probe mismatch');}
    finally{if(committed)await this.delete(staged);else await fs.unlink(await this.location('staging',staged)).catch(()=>{});}}
}
