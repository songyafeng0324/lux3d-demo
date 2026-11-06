import test from 'node:test';import assert from 'node:assert/strict';
import {validateRoomLayout,transformedBoundsCorners} from '@aholo/contracts';
const id='61f4df27-a36b-41fa-a3f2-1d6001db3665',bounds={min:[-.5,0,-.25],max:[.5,1,.25]},all=new Map([[id,bounds]]),p={id:'instance1',assetId:id,position:[0,0,0],rotation:[0,0,0],scale:1};
test('formal layout uses asset UUID/bounds and checks transformed corners rather than a fixed catalog',()=>{
 assert.equal(validateRoomLayout('我的小屋',[p],all),null);
 assert.equal(validateRoomLayout('我的小屋',[{...p,position:[5.5,0,0]}],all),null);
 assert.equal(validateRoomLayout('庭院边缘',[{...p,position:[10.5,-.4,8.75]}],all),null);
 assert.ok(validateRoomLayout('超出泥土',[{...p,position:[10.51,-.4,8.75]}],all));
 assert.ok(validateRoomLayout('穿过室内地面',[{...p,position:[0,-.1,0]}],all));
 assert.ok(validateRoomLayout('埋进庭院',[{...p,position:[10.5,-.41,8.75]}],all));
 const rotated={...p,rotation:[0,0,Math.PI/2],position:[0,.5,0]};assert.equal(validateRoomLayout('悬空重叠',[p, {...rotated,id:'rotated'}],all),null);
 assert.ok(transformedBoundsCorners(rotated,bounds).every(c=>c.every(Number.isFinite)));
 for(const patch of [{scale:0},{scale:Infinity},{position:[NaN,0,0]},{assetId:'unknown'},{extra:true}])assert.ok(validateRoomLayout('拒绝',[{...p,...patch}],all));
 assert.ok(validateRoomLayout('拒绝',[p,p],all));
});
test('formal layout keeps all repeated placements and imposes no item-count ceiling',()=>{const many=Array.from({length:5000},(_,n)=>({...p,id:'placement_'+n}));assert.equal(validateRoomLayout('完整大布局',many,all),null);assert.equal(many.length,5000);});
