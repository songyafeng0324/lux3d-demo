import {ROOM_BOUNDS,SCENE_VERSION,transformedBoundsCorners,type Bounds,type Vec3} from './scene.js';
export const ROOM_PLATFORM_HALF = { x: ROOM_BOUNDS.max[0] + .4, z: ROOM_BOUNDS.max[2] + .4 };
/** How far the roof ridge rises above the posts (apps/web/src/room/layout.ts ROOF). */
export const ROOM_ROOF_RISE = 1.8;
const COURTYARD_GROUND = -.4;
/**
 * T17: the house platform is the centre cell of a 3×3 grid; the fence runs just outside this edge.
 * Outdoors an item may reach three houses high (courtyard ground to roof ridge, ×3); over the platform
 * it stays under the beams (ROOM_BOUNDS), see roomPlacementCeiling.
 */
export const ROOM_COURTYARD_BOUNDS: Bounds = {
 min: [-3 * ROOM_PLATFORM_HALF.x, COURTYARD_GROUND, -3 * ROOM_PLATFORM_HALF.z],
 max: [3 * ROOM_PLATFORM_HALF.x, COURTYARD_GROUND + 3 * (ROOM_BOUNDS.max[1] + ROOM_ROOF_RISE - COURTYARD_GROUND), 3 * ROOM_PLATFORM_HALF.z],
};
export interface RoomPlacement {id:string;assetId:string;position:Vec3;rotation:Vec3;scale:number}
/** walkThrough: official ground cover such as grass that people walk through (T17). */
export interface RoomModel {id:string;modelFileId:string;normalization:{scale:number;translation:Vec3};bounds:Bounds;walkThrough?:boolean}
export interface PersonalRoom {id:string;name:string;version:number;sceneVersion:typeof SCENE_VERSION;placements:RoomPlacement[];shareEnabled:boolean;shareUrl:string|null;assets:RoomModel[]}
export interface RoomGrant {id:string;token:string;expiresAt:string}
export interface SharedRoom {name:string;ownerNickname:string;version:number;sceneVersion:typeof SCENE_VERSION;placements:RoomPlacement[];assets:RoomModel[];grant:RoomGrant}
export interface SharedRoomListing {id:string;ownerNickname:string;name:string;popularity:number;shareUrl:string}
export interface RoomPopularity {popularity:number}
export type RoomLikeView = RoomPopularity & (
  {state:'guest'|'owner'|'liked'} | {state:'available';csrfToken:string}
);
export interface RoomSaveReceipt {savedVersion:number;editSequence:number}
export function roomPlacementBounds(placement: RoomPlacement, bounds: Bounds): Bounds {
 const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
 for (const corner of transformedBoundsCorners(placement, bounds)) for (let axis = 0; axis < 3; axis++) {
  min[axis] = Math.min(min[axis], corner[axis]);
  max[axis] = Math.max(max[axis], corner[axis]);
 }
 return { min, max };
}
function overPlatform({ min, max }: Bounds): boolean {
 const { x, z } = ROOM_PLATFORM_HALF;
 return min[0] < x && max[0] > -x && min[2] < z && max[2] > -z;
}
export function roomPlacementFloor(bounds: Bounds): number {
 return overPlatform(bounds) ? ROOM_BOUNDS.min[1] : ROOM_COURTYARD_BOUNDS.min[1];
}
/** Highest allowed top: under the beams once any part is over the house platform, otherwise three houses high. */
export function roomPlacementCeiling(bounds: Bounds): number {
 return overPlatform(bounds) ? ROOM_BOUNDS.max[1] : ROOM_COURTYARD_BOUNDS.max[1];
}
export function validateRoomLayout(name:unknown,placements:unknown,bounds:ReadonlyMap<string,Bounds>):string|null {
 if(typeof name!=='string'||name.trim().length<1||name.trim().length>80)return '房间名称须为1～80个字符';
 if(!Array.isArray(placements))return '布局必须是数组';
 const ids=new Set<string>(),vec=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n));
 for(const raw of placements){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return '摆放格式无效';const p=raw as RoomPlacement;
  if(Object.keys(p).some(k=>!['id','assetId','position','rotation','scale'].includes(k)))return '摆放包含不支持字段';
  if(typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(p.id)||ids.has(p.id))return '摆放标识无效或重复';ids.add(p.id);
  if(typeof p.assetId!=='string'||!bounds.has(p.assetId)||!vec(p.position)||!vec(p.rotation)||typeof p.scale!=='number'||!Number.isFinite(p.scale)||p.scale<=0)return '变换或模型无效';
  const worldBounds = roomPlacementBounds(p, bounds.get(p.assetId)!);
  const min: Vec3 = [ROOM_COURTYARD_BOUNDS.min[0], roomPlacementFloor(worldBounds), ROOM_COURTYARD_BOUNDS.min[2]];
  const max: Vec3 = [ROOM_COURTYARD_BOUNDS.max[0], roomPlacementCeiling(worldBounds), ROOM_COURTYARD_BOUNDS.max[2]];
  for (let axis = 0; axis < 3; axis++) {
   if (!Number.isFinite(worldBounds.min[axis]) || !Number.isFinite(worldBounds.max[axis]) ||
       worldBounds.min[axis] < min[axis] - 1e-6 || worldBounds.max[axis] > max[axis] + 1e-6) return '物品超出小屋及庭院可用边界';
  }
 }
 return null;
}
