import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalFileStore} from '@aholo/domain';
import {randomUUID,createHash} from 'node:crypto';
test('private storage survives reopening and refuses overwrite, traversal and symlink reads',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-store-'));
 try{const s=new LocalFileStore(root);await s.initialize();const bytes=Buffer.from('persistent fixture');const staged=await s.putStaged(bytes);const file=await s.commit(staged);
 assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(file.byteSize,bytes.length);
 const reopened=new LocalFileStore(root);await reopened.initialize();const stream=await reopened.openRead(file.objectKey);const chunks=[];for await(const b of stream)chunks.push(b);assert.deepEqual(Buffer.concat(chunks),bytes);
 await assert.rejects(()=>s.openRead('../outside'));const link=randomUUID();await fs.symlink('/etc/hosts',path.join(root,'objects',link));await assert.rejects(()=>s.openRead(link));
 const staged2=await s.putStaged(Buffer.from('replace'));await assert.rejects(()=>s.commit(staged2,file.objectKey));assert.equal((await s.stat(file.objectKey)).size,bytes.length);
 await s.delete(file.objectKey);await s.delete(file.objectKey);await assert.rejects(()=>s.openRead(file.objectKey));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('storage rejects replacing object directory with an external symlink',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-store-'));const external=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-outside-'));
 try{const s=new LocalFileStore(root);await s.initialize();await fs.rmdir(path.join(root,'objects'));await fs.symlink(external,path.join(root,'objects'));await assert.rejects(()=>s.initialize());await assert.rejects(()=>s.probe());}
 finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(external,{recursive:true,force:true});}
});
test('root identity cannot be rebound after initialization',async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-root-'));const root=path.join(base,'data');const other=path.join(base,'external');const s=new LocalFileStore(root);const outside=new LocalFileStore(other);
 try{await s.initialize();await outside.initialize();await fs.rename(root,root+'-old');await fs.symlink(other,root);await assert.rejects(()=>s.probe());await assert.rejects(()=>s.putStaged(Buffer.from('escape')));assert.deepEqual(await fs.readdir(path.join(other,'staging')),[]);}
 finally{await fs.rm(base,{recursive:true,force:true});}
});
test('commit resumes after link or after lost completion, and verifies expected digest',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aholo-commit-'));try{const s=new LocalFileStore(root);await s.initialize();const id=await s.putStaged(Buffer.from('recover'));await fs.link(path.join(root,'staging',id),path.join(root,'objects',id));const a=await s.commit(id);const b=await s.commit(id,id,a.sha256);assert.deepEqual(a,b);await assert.rejects(()=>s.commit(id,id,'0'.repeat(64)));await s.probe();}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
