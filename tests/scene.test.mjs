import test from 'node:test';
import assert from 'node:assert/strict';
import {ASSET_BOUNDS,transformedCorners,validateLayout} from '@aholo/contracts';
const placement=(change={})=>({id:'one',assetId:'table',position:[0,0,0],rotation:[0,0,0],scale:1,...change});

test('shared bounds tests all eight corners with Euler XYZ and positive uniform scale',()=>{
 let seed=3103;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
 for(let i=0;i<500;i++){
  const p=placement({rotation:[rnd()*6,rnd()*6,rnd()*6],position:[rnd(),rnd(),rnd()],scale:.1+rnd()*3});
  const bounds=ASSET_BOUNDS[p.assetId];let n=0;
  for(const x of [bounds.min[0],bounds.max[0]])for(const y of [bounds.min[1],bounds.max[1]])for(const z of [bounds.min[2],bounds.max[2]]){
   // Independent sequential intrinsic-XYZ reference: Z then Y then X.
   let [u,v,w]=[x*p.scale,y*p.scale,z*p.scale];let c=Math.cos(p.rotation[2]),s=Math.sin(p.rotation[2]);[u,v]=[u*c-v*s,u*s+v*c];c=Math.cos(p.rotation[1]);s=Math.sin(p.rotation[1]);[u,w]=[u*c+w*s,-u*s+w*c];c=Math.cos(p.rotation[0]);s=Math.sin(p.rotation[0]);[v,w]=[v*c-w*s,v*s+w*c];
   const corner=transformedCorners(p)[n++];[u,v,w].forEach((value,axis)=>assert(Math.abs(corner[axis]-value-p.position[axis])<1e-10));
  }
 }
});
test('layout validates transformed edges rather than origins, permits overlap and no item-count cap',()=>{
 assert.equal(validateLayout('小屋',[placement()]),null);
 assert.match(validateLayout('小屋',[placement({position:[5.5,0,0]})]),/边界/);
 assert.match(validateLayout('小屋',[placement({rotation:[0,0,Math.PI/2]})]),/边界/);
 assert.equal(validateLayout('小屋',[placement({rotation:[Math.PI/2,.4,.3],position:[0,2,0],scale:.5})]),null);
 assert.equal(validateLayout('小屋',Array.from({length:1500},(_,i)=>placement({id:'p'+i}))),null);
 assert.match(validateLayout('小屋',[placement(),placement()]),/重复/);
 for(const p of [placement({scale:0}),placement({scale:-1}),placement({scale:NaN}),placement({position:[0,Infinity,0]}),placement({rotation:[0,0]}),placement({assetId:'__proto__'}),placement({assetId:undefined})])assert.notEqual(validateLayout('小屋',[p]),null);
 assert.notEqual(validateLayout('',[]),null);assert.notEqual(validateLayout('小屋',{}),null);
});
