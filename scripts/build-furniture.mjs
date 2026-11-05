// Locally authored official furniture; no supplier request or paid generation.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {furniture,disposeResources} from '../apps/web/src/scene/assets.ts';
class ExportReader {
 result=null;onloadend=null;onerror=null;
 readAsArrayBuffer(blob){blob.arrayBuffer().then(value=>{this.result=value;this.onloadend?.();},e=>this.onerror?.(e));}
 readAsDataURL(blob){blob.arrayBuffer().then(value=>{this.result=`data:${blob.type};base64,${Buffer.from(value).toString('base64')}`;this.onloadend?.();},e=>this.onerror?.(e));}
}
globalThis.FileReader=ExportReader;
const out=path.resolve('assets/furniture');await fs.mkdir(out,{recursive:true});
const ids=['table','chair','cabinet'],names=['明式长案','靠背木椅','双门陈列柜'],manifest=[];
for(let n=0;n<ids.length;n++){
 const model=furniture(ids[n]);model.name=names[n];const buffer=Buffer.from(await new GLTFExporter().parseAsync(model,{binary:true}));
 const sha=createHash('sha256').update(buffer).digest('hex');await fs.writeFile(path.join(out,ids[n]+'.glb'),buffer);disposeResources([model]);
 manifest.push({key:ids[n],name:names[n],file:ids[n]+'.glb',sha256:sha,byteSize:buffer.length});
}
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({version:1,source:'apps/web/src/scene/assets.ts#furniture',normalization:'longest edge 1m, bottom-centre pivot',items:manifest},null,2)+'\n');console.log(JSON.stringify(manifest));
