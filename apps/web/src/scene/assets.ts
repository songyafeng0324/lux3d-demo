import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
export const palette={wood:0x6d3f2b,edge:0xa97948,red:0x743b31,stone:0xd4d0c4,wall:0xe9e4d6,tile:0x495d59};
export function material(color:number,roughness=.8){return new T.MeshStandardMaterial({color,roughness});}
export function box(parent:T.Object3D,w:number,h:number,d:number,x:number,y:number,z:number,mat:T.Material){const m=new T.Mesh(new T.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.castShadow=false;m.receiveShadow=true;parent.add(m);return m;}
export function furniture(id:'table'|'chair'|'cabinet'){
 const g=new T.Group(),wood=material(palette.wood),trim=material(palette.edge);
 if(id==='table'){
  box(g,2,.12,1,0,.99,0,wood);box(g,1.9,.15,.9,0,.85,0,trim);
  for(const x of [-.83,.83])for(const z of [-.35,.35])box(g,.1,.84,.1,x,.42,z,wood);
 }else if(id==='chair'){
  box(g,.7,.12,.8,0,.51,0,wood);
  for(const x of [-.28,.28])for(const z of [-.32,.32])box(g,.09,.48,.09,x,.24,z,wood);
  for(const x of [-.28,.28])box(g,.09,.59,.09,x,.805,-.32,wood);
  box(g,.65,.12,.1,0,1.04,-.32,trim);box(g,.52,.1,.08,0,.84,-.32,wood);
 }else{
  box(g,1.3,1.64,.7,0,1.02,0,wood);box(g,1.3,.12,.7,0,1.84,0,trim);
  for(const x of [-.55,.55])for(const z of [-.25,.25])box(g,.12,.2,.12,x,.1,z,wood);
  for(const x of [-.32,.32]){box(g,.59,1.35,.04,x,1.04,.305,trim);box(g,.51,1.22,.045,x,1.04,.32,wood);box(g,.025,.12,.04,x+(x<0?.2:-.2),1.05,.33,material(0xc3a35a));}
 }
 mergeOpaque(g);return g;
}
interface ArchitectureFinish { floor: number[]; base: number; wall: number; wood: number; trim: number }
export function architecture(gallery=false,finish?: ArchitectureFinish){
 const g=new T.Group(),roof=new T.Group();const wood=material(finish?.wood ?? palette.red),trim=material(finish?.trim ?? palette.edge),wall=material(finish?.wall ?? palette.wall),stone=material(finish?.base ?? palette.stone),tiles=material(palette.tile);
 const w=gallery?24:12,d=gallery?28:9,h=4.8;
 box(g,w+.8,.28,d+.8,0,-.14,0,stone);box(g,w+.3,.08,d+.3,0,-.32,0,trim);
 const floor=(finish?.floor ?? [0xb5b09a]).map(color=>material(color,finish ? .91 : .8));
 for(let x=0;x<w/1.5;x++)for(let z=0;z<d/1.5;z++){
  const tile=floor[((x*13+z*7)^(x*z+z))%floor.length];
  box(g,1.48,.025,1.48,x*1.5-w/2+.75,.0125,z*1.5-d/2+.75,tile);
 }
 box(g,w,.9,.16,0,.45,-d/2,wall);box(g,.16,.9,d,-w/2,.45,0,wall);box(g,.16,.9,d,w/2,.45,0,wall);
 for(const x of [-w/2,w/2])for(let z=-d/2;z<=d/2+.1;z+=d/4){const p=new T.Mesh(new T.CylinderGeometry(.13,.17,h,12),wood);p.position.set(x,h/2,z);g.add(p);box(g,.54,.15,.5,x,h-.18,z,trim);box(g,.38,.19,.38,x,h-.37,z,wood);}
 for(let x=-w/2;x<=w/2+.1;x+=w/4){const p=new T.Mesh(new T.CylinderGeometry(.13,.17,h,12),wood);p.position.set(x,h/2,-d/2);g.add(p);box(g,.5,.18,.38,x,h-.23,-d/2,trim);}
 box(g,w+.2,.24,.22,0,h-.1,-d/2,wood);box(g,.22,.24,d,-w/2,h-.1,0,wood);box(g,.22,.24,d,w/2,h-.1,0,wood);
 // Lattice rear windows and side friezes remain separate from user placements.
 for(let x=-w/2+.5;x<w/2;x+=.55){box(g,.035,2.5,.08,x,2.45,-d/2,wood);for(const y of [1.25,2,2.75,3.5])box(g,.5,.035,.08,x,y,-d/2,trim);}
 for(const side of [-1,1])for(let z=-d/2+.5;z<d/2;z+=.7){box(g,.08,.8,.035,side*w/2,3.95,z,wood);box(g,.08,.035,.65,side*w/2,3.55,z,trim);}
 // Segmented swept roof rises at the eaves; this is locally authored geometry.
 for(const side of [-1,1])for(let i=0;i<12;i++){const a=i/12,b=(i+1)/12;const x0=side*a*(w/2+.9),x1=side*b*(w/2+.9);const y0=h+1.8*(1-a)+.55*a*a*a,y1=h+1.8*(1-b)+.55*b*b*b;const strip=box(roof,Math.hypot(x1-x0,y1-y0),.13,d+1.5,(x0+x1)/2,(y0+y1)/2,0,tiles);strip.rotation.z=Math.atan2(y1-y0,x1-x0);}
 box(roof,.22,.22,d+1.8,0,h+1.85,0,trim);g.add(roof);
 for(const x of [-w/2,w/2]){const lantern=new T.Mesh(new T.SphereGeometry(.23,12,8),material(0xba6243));lantern.scale.y=1.3;lantern.position.set(x,3.75,d/2-.4);g.add(lantern);}
 mergeOpaque(roof);mergeOpaque(g,roof);return {group:g,roof};
}
export function disposeResources(roots:T.Object3D[]){
 const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>();
 for(const root of roots)root.traverse(o=>{const m=o as T.Mesh;if(m.geometry)geometries.add(m.geometry);if(m.material)for(const mat of Array.isArray(m.material)?m.material:[m.material])materials.add(mat);});
 for(const mat of materials)for(const v of Object.values(mat))if(v instanceof T.Texture)textures.add(v);
 for(const t of textures){const image=t.source?.data;if(typeof ImageBitmap!=='undefined'&&image instanceof ImageBitmap)image.close();t.dispose();}
 for(const m of materials)m.dispose();for(const g of geometries)g.dispose();
}

export function enableMeshShadows(root: T.Object3D) {
 root.traverse(object => {
  const mesh = object as T.Mesh;
  if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
 });
}

// Merge static pieces by material; source models keep their shared resources.
function mergeOpaque(root:T.Group,excluded?:T.Group){
 root.updateMatrixWorld(true);const batches=new Map<T.Material,T.BufferGeometry[]>(),remove:T.Mesh[]=[];
 root.traverse(o=>{if(!(o instanceof T.Mesh)||Array.isArray(o.material))return;let ancestor:T.Object3D|null=o;while(ancestor){if(ancestor===excluded)return;ancestor=ancestor.parent;}const geometries=batches.get(o.material)||[];geometries.push(o.geometry.clone().applyMatrix4(o.matrixWorld));batches.set(o.material,geometries);remove.push(o);});
 for(const mesh of remove){mesh.removeFromParent();mesh.geometry.dispose();}
 for(const [mat,parts] of batches){const geometry=mergeGeometries(parts,false);for(const part of parts)part.dispose();if(geometry)root.add(new T.Mesh(geometry,mat));}
}
