import type {Bounds,Vec3} from './scene.js';
import type {RoomModel,RoomGrant} from './room.js';
/** Public exhibit information frozen at submission (or official entry) time. */
export interface PublicDetails {name:string;description:string;era:string;material:string;ownershipType:'personal_collection'|'museum';holderName:string;location:string;officialUrl:string;sourceNickname:string}
export interface GalleryExhibit {candidateId:string;name:string;model:RoomModel}
export interface GallerySlot {slotNo:number;exhibit:GalleryExhibit|null}
export interface GalleryView {version:number;slots:GallerySlot[];grant:RoomGrant}
export interface ExhibitDetail extends PublicDetails {candidateId:string;slotNo:number;model:RoomModel}
export interface CollectedAsset extends RoomModel {collectionId:string;name:string;authorNickname:string}
export type ExhibitCollectionStatus = 'available' | 'collected' | 'owned' | 'unavailable';
export interface CollectionRemoval {previousVersion:number;roomVersion:number;placementsRemoved:number}
export const GALLERY_SLOT_COUNT=30;
/** Slot n in the database is plinth `T0n` in assets/t10/pavilion-layout.json. */
export const slotMarker=(slotNo:number)=>`T${String(slotNo).padStart(2,'0')}`;
/**
 * Automatic centring and fitting on a plinth (PRD 7.7: no manual height/rotation/scale tools).
 * Input bounds are the normalised model bounds; output is uniform scale plus the offset that puts
 * the model's footprint centre on the plinth axis and its lowest point on the plinth top.
 */
export const EXHIBIT_FIT={maxSize:0.8,plinthTop:1.17} as const;
export function exhibitFit(bounds:Bounds,maxSize:number=EXHIBIT_FIT.maxSize):{scale:number;offset:Vec3}{
 const size=[0,1,2].map(i=>bounds.max[i]-bounds.min[i]);const largest=Math.max(...size);
 if(!(largest>0)||!Number.isFinite(largest))throw new Error('Invalid exhibit bounds');
 const scale=maxSize/largest;
 return {scale,offset:[-(bounds.min[0]+bounds.max[0])/2*scale,-bounds.min[1]*scale,-(bounds.min[2]+bounds.max[2])/2*scale]};
}
/** Server-side validation of an administrator's whole 30-slot arrangement. Returns an error message or null. */
export function validateGallerySlots(slots:unknown):string|null{
 if(!Array.isArray(slots)||slots.length!==GALLERY_SLOT_COUNT)return `须提交全部${GALLERY_SLOT_COUNT}个展位`;
 const seenSlots=new Set<number>(),seenCandidates=new Set<string>();
 for(const raw of slots){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return '展位格式无效';const s=raw as Record<string,unknown>;
  if(Object.keys(s).some(k=>k!=='slotNo'&&k!=='candidateId'))return '展位包含不支持字段';
  if(!Number.isInteger(s.slotNo)||(s.slotNo as number)<1||(s.slotNo as number)>GALLERY_SLOT_COUNT||seenSlots.has(s.slotNo as number))return '展位编号缺失或重复';
  seenSlots.add(s.slotNo as number);
  if(s.candidateId===null)continue;
  if(typeof s.candidateId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s.candidateId))return '候选标识无效';
  const key=s.candidateId.toLowerCase();if(seenCandidates.has(key))return '同一候选不能同时占用多个展位';seenCandidates.add(key);
 }
 return null;
}
