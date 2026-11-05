import {ROOM_BOUNDS,SCENE_VERSION,transformedBoundsCorners,type Bounds,type Vec3} from './scene.js';
export interface RoomPlacement {id:string;assetId:string;position:Vec3;rotation:Vec3;scale:number}
export interface RoomModel {id:string;modelFileId:string;normalization:{scale:number;translation:Vec3};bounds:Bounds}
export interface PersonalRoom {id:string;name:string;version:number;sceneVersion:typeof SCENE_VERSION;placements:RoomPlacement[];shareEnabled:boolean;shareUrl:string|null;assets:RoomModel[]}
export interface RoomGrant {id:string;token:string;expiresAt:string}
export interface SharedRoom {name:string;ownerNickname:string;version:number;sceneVersion:typeof SCENE_VERSION;placements:RoomPlacement[];assets:RoomModel[];grant:RoomGrant}
export interface RoomSaveReceipt {savedVersion:number;editSequence:number}
export function validateRoomLayout(name:unknown,placements:unknown,bounds:ReadonlyMap<string,Bounds>):string|null {
 if(typeof name!=='string'||name.trim().length<1||name.trim().length>80)return '房间名称须为1～80个字符';
 if(!Array.isArray(placements))return '布局必须是数组';
 const ids=new Set<string>(),vec=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n));
 for(const raw of placements){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return '摆放格式无效';const p=raw as RoomPlacement;
  if(Object.keys(p).some(k=>!['id','assetId','position','rotation','scale'].includes(k)))return '摆放包含不支持字段';
  if(typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)||ids.has(p.id))return '摆放标识无效或重复';ids.add(p.id);
  if(typeof p.assetId!=='string'||!bounds.has(p.assetId)||!vec(p.position)||!vec(p.rotation)||typeof p.scale!=='number'||!Number.isFinite(p.scale)||p.scale<=0)return '变换或模型无效';
  const b=bounds.get(p.assetId)!;
  for(const corner of transformedBoundsCorners(p,b))for(let axis=0;axis<3;axis++)if(!Number.isFinite(corner[axis])||corner[axis]<ROOM_BOUNDS.min[axis]-1e-6||corner[axis]>ROOM_BOUNDS.max[axis]+1e-6)return '物品超出房屋可用边界';
 }
 return null;
}
