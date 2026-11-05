/** Browser/server shared, credential-free T04 geometry contract. Metres, Y up. */
export type Vec3 = [number, number, number];
export type AssetId = 'table' | 'chair' | 'cabinet' | 'vase';
export interface Bounds { min: Vec3; max: Vec3 }
export interface Placement { id: string; assetId: AssetId; position: Vec3; rotation: Vec3; scale: number }
export interface RoomLayout { version: number; name: string; sceneVersion: typeof SCENE_VERSION; placements: Placement[] }
export const SCENE_VERSION = 'courtyard-v1' as const;
export const ROOM_BOUNDS: Bounds = { min: [-6, 0, -4.5], max: [6, 4.8, 4.5] };
export const ASSET_BOUNDS: Record<AssetId, Bounds> = {
  table: { min: [-1, 0, -.5], max: [1, 1.05, .5] },
  chair: { min: [-.35, 0, -.4], max: [.35, 1.1, .4] },
  cabinet: { min: [-.65, 0, -.35], max: [.65, 1.9, .35] },
  vase: { min: [-.5, 0, -.4957359977627142], max: [.5, .7643441746396133, .4957359977627142] },
};
export const assetBounds = ASSET_BOUNDS;

/** Euler XYZ, matching Three.js Euler('XYZ'): no geometry library on the server. */
export function transformedCorners(p: Placement): Vec3[] {
  const bounds = ASSET_BOUNDS[p.assetId];
  const [a, b, c] = p.rotation;
  const sx = Math.sin(a), cx = Math.cos(a), sy = Math.sin(b), cy = Math.cos(b), sz = Math.sin(c), cz = Math.cos(c);
  const result: Vec3[] = [];
  for (const x0 of [bounds.min[0], bounds.max[0]]) for (const y0 of [bounds.min[1], bounds.max[1]]) for (const z0 of [bounds.min[2], bounds.max[2]]) {
    const x=x0*p.scale, y=y0*p.scale, z=z0*p.scale;
    result.push([
      cy*cz*x-cy*sz*y+sy*z+p.position[0],
      (cx*sz+sx*sy*cz)*x+(cx*cz-sx*sy*sz)*y-sx*cy*z+p.position[1],
      (sx*sz-cx*sy*cz)*x+(sx*cz+cx*sy*sz)*y+cx*cy*z+p.position[2],
    ]);
  }
  return result;
}

export function validateLayout(name: unknown, placements: unknown): string | null {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) return '房间名称须为1～80个字符';
  if (!Array.isArray(placements)) return '布局必须是数组';
  const ids = new Set<string>();
  const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
  for (const value of placements) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '摆放格式无效';
    const p = value as Placement;
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id)) return '摆放标识无效或重复';
    ids.add(p.id);
    if (typeof p.assetId !== 'string' || !Object.hasOwn(ASSET_BOUNDS, p.assetId) || !vec(p.position) || !vec(p.rotation) || typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale <= 0) return '变换或模型无效';
    for (const corner of transformedCorners(p)) for (let axis=0;axis<3;axis++) {
      if (!Number.isFinite(corner[axis]) || corner[axis] < ROOM_BOUNDS.min[axis]-1e-6 || corner[axis] > ROOM_BOUNDS.max[axis]+1e-6) return '物品超出房屋可用边界';
    }
  }
  return null;
}
