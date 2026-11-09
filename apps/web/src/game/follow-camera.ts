/**
 * T15 third-person follow camera. Pure TypeScript (node --test imports it).
 *
 * The boom is shortened against the same analytic geometry the walking contract uses
 * (navigation colliders + walk surfaces) plus a few camera-only blockers for slabs and
 * roofs. Render meshes are never ray-cast: the merged pavilion has no BVH and the
 * project rule is that collision follows navigation.ts, not the GLB.
 */
import type { Collider, Surface } from './navigation.js';

export type Vec3 = [number, number, number];
export interface CameraWorld {
  colliders: readonly Collider[];
  surfaces: readonly Surface[];
  /** Lowest ground anywhere (outside the walk surfaces too); the camera never goes below it. */
  floorY: number;
  /** Collider ids the camera may pass through (invisible gameplay walls). */
  passThrough?: ReadonlySet<string>;
}

export const FOLLOW = {
  distance: 3.2,
  /** Pivot height above the feet (just over the 1.5 m avatar's head, so the character sits low in frame); the camera orbits it and E-targeting starts here. */
  pivot: 1.75,
  /** Starting pitch: looking slightly down over the character's head. */
  entryPitch: -0.2,
  /** Clearance kept from blockers (covers the near plane and thin geometry). */
  pad: 0.14,
  floorClearance: 0.18,
  /** Below this boom length the avatar would fill the screen; it is hidden instead. */
  hideBelow: 0.7,
  /** Pressed against a wall the camera may come all the way to the pivot (avatar hidden by then). */
  minBoom: 0.02,
  pitch: { min: -1.15, max: 0.8 },
} as const;

/** Forward vector of a camera with rotation (pitch, yaw, 0) in 'YXZ' order. */
export function viewDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

function rayBox(o: Vec3, d: Vec3, lo: Vec3, hi: Vec3): number | null {
  // Pivot already inside (e.g. standing under a low beam): this blocker cannot be judged, skip it.
  if (o.every((v, a) => v > lo[a] && v < hi[a])) return null;
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue; }
    let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

function rayCylinder(o: Vec3, d: Vec3, cx: number, cz: number, r: number, y0: number, y1: number): number | null {
  const ox = o[0] - cx, oz = o[2] - cz, inside = ox * ox + oz * oz <= r * r;
  if (inside && o[1] > y0 && o[1] < y1) return null; // pivot inside: cannot be judged, as for boxes
  // Entry/exit of the infinite vertical cylinder (side), then of the y slab (caps); the hit is where both overlap.
  let s0 = -Infinity, s1 = Infinity;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a < 1e-12) { if (!inside) return null; }
  else {
    const b = 2 * (ox * d[0] + oz * d[2]), c = ox * ox + oz * oz - r * r, disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const q = Math.sqrt(disc);
    s0 = (-b - q) / (2 * a); s1 = (-b + q) / (2 * a);
  }
  let h0 = -Infinity, h1 = Infinity;
  if (Math.abs(d[1]) < 1e-9) { if (o[1] < y0 || o[1] > y1) return null; }
  else { h0 = (y0 - o[1]) / d[1]; h1 = (y1 - o[1]) / d[1]; if (h0 > h1) [h0, h1] = [h1, h0]; }
  const enter = Math.max(s0, h0, 0), exit = Math.min(s1, h1);
  return enter <= exit ? enter : null;
}

/** First crossing of the ray down through a walk surface (flat or ramp), raised by the clearance. */
function rayFloor(o: Vec3, d: Vec3, s: Surface, lift: number): number | null {
  if (d[1] >= 0) return null;
  let k: number, height0: number;
  if (s.y !== undefined) { k = 0; height0 = s.y; }
  else {
    const r = s.ramp!, slope = (r.y1 - r.y0) / (r.zB - r.zA);
    k = slope * d[2]; height0 = r.y0 + slope * (o[2] - r.zA);
  }
  // o.y + d.y t = height0 + k t + lift  →  linear in t
  const gap = o[1] - height0 - lift, rate = d[1] - k;
  if (gap < 0 || rate >= 0) return null;
  const t = gap / -rate, x = o[0] + d[0] * t, z = o[2] + d[2] * t;
  return x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 ? t : null;
}

/**
 * Distance from `origin` along unit vector `back` the camera may sit, capped at `max`.
 * `blockers` are camera-only boxes (slab undersides, roofs) in collider form.
 */
export function boomLength(world: CameraWorld, origin: Vec3, back: Vec3, max: number, blockers: readonly Collider[] = []): number {
  const p = FOLLOW.pad;
  let hit = max + p;
  for (const c of [...world.colliders, ...blockers]) {
    if (world.passThrough?.has(c.id)) continue;
    const cast = (q: number) => c.kind === 'circle'
      ? rayCylinder(origin, back, c.x, c.z, c.r + q, c.y0 - q, c.y1 + q)
      : rayBox(origin, back, [c.x0 - q, c.y0 - q, c.z0 - q], [c.x1 + q, c.y1 + q, c.z1 + q]);
    // Hugging a wall puts the pivot inside the padded blocker: then the unpadded one decides,
    // and a ray heading into it leaves the camera at the minimum boom.
    let t = cast(p);
    if (t === null) { const raw = cast(0); if (raw !== null) t = raw - p; }
    if (t !== null && t < hit) hit = t;
  }
  for (const s of world.surfaces) {
    const t = rayFloor(origin, back, s, FOLLOW.floorClearance);
    if (t !== null && t < hit) hit = t;
  }
  if (back[1] < 0) {
    const t = (origin[1] - world.floorY - FOLLOW.floorClearance) / -back[1];
    if (t >= 0 && t < hit) hit = t;
  }
  return Math.min(max, Math.max(FOLLOW.minBoom, hit - 0.04));
}

/**
 * Camera boom easing: pull in at once when something blocks the view (no clipping frame),
 * ease back out so the camera does not pop when the blocker is passed.
 */
export function easeBoom(current: number, target: number, dt: number): number {
  return target < current ? target : current + (target - current) * (1 - Math.exp(-dt * 5));
}

/** Facing that turns toward `target` along the shortest arc, at most `rate` rad/s. */
export function turnToward(current: number, target: number, rate: number, dt: number): number {
  let delta = ((target - current + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const max = rate * dt;
  if (Math.abs(delta) > max) delta = Math.sign(delta) * max;
  return current + delta;
}

/** Third-person view pitch range (looking up pulls the camera toward the floor). */
export const clampFollowPitch = (pitch: number) => Math.min(FOLLOW.pitch.max, Math.max(FOLLOW.pitch.min, pitch));
