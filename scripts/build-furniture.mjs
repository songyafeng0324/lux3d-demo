// Locally authored official items (T17); no supplier request or paid generation.
// Items that leave this list are removed from the database by seed-furniture.mjs.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {disposeResources} from '../apps/web/src/scene/assets.ts';
import {gardenBed} from '../apps/web/src/room/garden-bed.ts';
class ExportReader {
 result=null;onloadend=null;onerror=null;
 readAsArrayBuffer(blob){blob.arrayBuffer().then(value=>{this.result=value;this.onloadend?.();},e=>this.onerror?.(e));}
 readAsDataURL(blob){blob.arrayBuffer().then(value=>{this.result=`data:${blob.type};base64,${Buffer.from(value).toString('base64')}`;this.onloadend?.();},e=>this.onerror?.(e));}
}
globalThis.FileReader=ExportReader;
const items=[
 {key:'garden-bed',name:'花草丛',build:gardenBed,walkThrough:true,description:'原小屋庭院里的花草，可以直接穿行，可重复摆放与缩放。'},
];
const out=path.resolve('assets/furniture');await fs.mkdir(out,{recursive:true});
const manifest=[];
for(const item of items){
 const model=item.build();model.name=item.name;const buffer=Buffer.from(await new GLTFExporter().parseAsync(model,{binary:true}));
 const sha=createHash('sha256').update(buffer).digest('hex');await fs.writeFile(path.join(out,item.key+'.glb'),buffer);disposeResources([model]);
 manifest.push({key:item.key,name:item.name,description:item.description,walkThrough:item.walkThrough,file:item.key+'.glb',sha256:sha,byteSize:buffer.length});
}
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({version:2,source:'scripts/build-furniture.mjs',normalization:'longest edge 1m, bottom-centre pivot (applied by the import worker)',items:manifest},null,2)+'\n');console.log(JSON.stringify(manifest));
