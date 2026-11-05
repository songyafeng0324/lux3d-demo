/**
 * T10-C pavilion navigation contract (metres, Web Y up, north = -Z, east = +X).
 *
 * Every surface and collider below is transcribed from the geometry that
 * scripts/blender/build_t10.py actually builds for pavilion-v1.glb (line refs
 * in comments). Walk surfaces are what feet stand on; colliders are vertical
 * blockers checked against the body circle. The browser check compares these
 * surfaces with real downward rays against the GLB, so drift is detectable.
 *
 * Pure TypeScript with no runtime dependencies, so node --test can import it.
 */

export interface Rect { x0: number; x1: number; z0: number; z1: number }
/** Flat surface (y) or a ramp along Z: y goes from y0 at z=zA to y1 at z=zB. */
export interface Surface extends Rect { id: string; y?: number; ramp?: { zA: number; zB: number; y0: number; y1: number } }
export interface BoxCollider extends Rect { id: string; kind: 'box'; y0: number; y1: number }
export interface CircleCollider { id: string; kind: 'circle'; x: number; z: number; r: number; y0: number; y1: number }
export type Collider = BoxCollider | CircleCollider;
export interface ExhibitSlot { id: string; floor: number; position: [number, number, number]; footprint: [number, number] }
export interface NavWorld { surfaces: Surface[]; colliders: Collider[]; slots: ExhibitSlot[]; entry: Player }
export interface Player { x: number; y: number; z: number }
export interface MoveInput { forward: number; right: number; run: boolean }

export const BODY = { radius: 0.3, height: 1.7, eye: 1.6, stepUp: 0.3, maxDrop: 0.45, walk: 3.0, run: 5.2, substep: 0.05 } as const;
export const UPPER_Y = 4.8;
const RAIL_TOP = 1.15 + 0.1; // rail(): top beam at height, posts +0.07, caps +0.09
const STAIR_RAIL_TOP = 1.05 + 0.1;
const WALL_IN = { x: 11.89, z: 13.88 }; // walls 0.22–0.24 thick centred on ±12 / ±14

const box = (id: string, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): BoxCollider =>
  ({ id, kind: 'box', x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), y0, y1 });
/** A rail segment from (xa,za) to (xb,zb) as a thin box. */
const rail = (id: string, xa: number, za: number, xb: number, zb: number, y0: number, y1: number, t = 0.1): BoxCollider =>
  box(id, Math.min(xa, xb) - t, Math.max(xa, xb) + t, Math.min(za, zb) - t, Math.max(za, zb) + t, y0, y1);

export const COLUMNS: [number, number][] = [[-6.4, -4.9], [-6.4, 1.5], [-6.4, 7.9], [6.4, -4.9], [6.4, 1.5], [6.4, 7.9]];

export function buildNavWorld(slots: ExhibitSlot[]): NavWorld {
  const surfaces: Surface[] = [
    // GroundBase top y=0 (line 77); interior bounded by walls.
    { id: 'ground', x0: -WALL_IN.x, x1: WALL_IN.x, z0: -WALL_IN.z, z1: WALL_IN.z, y: 0 },
    // UpperSlab parts (line 82): ring minus atrium and stair well, top 4.8.
    { id: 'upper-west', x0: -WALL_IN.x, x1: -6, z0: -WALL_IN.z, z1: WALL_IN.z, y: UPPER_Y },
    { id: 'upper-east', x0: 6, x1: WALL_IN.x, z0: -WALL_IN.z, z1: WALL_IN.z, y: UPPER_Y },
    { id: 'upper-south', x0: -6, x1: 6, z0: 7.5, z1: WALL_IN.z, y: UPPER_Y },
    { id: 'upper-north-strip', x0: -6, x1: 6, z0: -WALL_IN.z, z1: -13, y: UPPER_Y },
    { id: 'upper-well-west', x0: -6, x1: -2.7, z0: -13, z1: -6.7, y: UPPER_Y },
    { id: 'upper-well-east', x0: 2.7, x1: 6, z0: -13, z1: -6.7, y: UPPER_Y },
    { id: 'upper-north-crossing', x0: -6, x1: 6, z0: -6.7, z1: -4.5, y: UPPER_Y },
    // Stairs (lines 117–121): 15 treads × 0.16 per flight, walked as a smooth ramp.
    { id: 'east-flight', x0: 0.3, x1: 2.7, z0: -11.5, z1: -6.7, ramp: { zA: -6.7, zB: -11.5, y0: 0, y1: 2.4 } },
    { id: 'landing', x0: -2.7, x1: 2.7, z0: -13, z1: -11.5, y: 2.4 },
    { id: 'west-flight', x0: -2.7, x1: -0.3, z0: -11.5, z1: -6.7, ramp: { zA: -11.5, zB: -6.7, y0: 2.4, y1: UPPER_Y } },
  ];
  const H = 9.2, up = UPPER_Y, guard = up + RAIL_TOP;
  const colliders: Collider[] = [
    // Outer walls (lines 101–111); entry gap x∈[-2,2] closed by an invisible threshold.
    box('wall-west', -12.2, -WALL_IN.x, -14.2, 14.2, 0, H),
    box('wall-east', WALL_IN.x, 12.2, -14.2, 14.2, 0, H),
    box('wall-north', -12.2, 12.2, -14.2, -WALL_IN.z, 0, H),
    box('wall-south-w', -12.2, -2, WALL_IN.z, 14.2, 0, H),
    box('wall-south-e', 2, 12.2, WALL_IN.z, 14.2, 0, H),
    box('entry-threshold', -2, 2, WALL_IN.z, 14.2, 0, 3.7),
    // Columns r≈0.40 with 0.53 stone bases (lines 85–88).
    ...COLUMNS.map(([x, z], i): CircleCollider => ({ id: `column-${i}`, kind: 'circle', x, z, r: 0.45, y0: 0, y1: H })),
    // Upper atrium guards (line 127).
    rail('atrium-guard-n', -6, -4.5, 6, -4.5, up, guard), rail('atrium-guard-s', -6, 7.5, 6, 7.5, up, guard),
    rail('atrium-guard-w', -6, -4.5, -6, 7.5, up, guard), rail('atrium-guard-e', 6, -4.5, 6, 7.5, up, guard),
    // Stair-well guards (line 128): open only at the west flight exit x∈[-2.7,-0.3].
    rail('well-guard-n', -2.7, -13, 2.7, -13, up, guard), rail('well-guard-w', -2.7, -13, -2.7, -6.7, up, guard),
    rail('well-guard-e', 2.7, -13, 2.7, -6.7, up, guard), rail('well-guard-s', -0.3, -6.7, 2.7, -6.7, up, guard),
    // Flight handrails (lines 129–131), boxed over their full sloped height.
    rail('east-rail-in', 0.36, -11.5, 0.36, -6.7, 0, 2.4 + STAIR_RAIL_TOP, 0.08),
    rail('east-rail-out', 2.64, -11.5, 2.64, -6.7, 0, 2.4 + STAIR_RAIL_TOP, 0.08),
    rail('west-rail-in', -0.36, -11.5, -0.36, -6.7, 2.4, up + STAIR_RAIL_TOP, 0.08),
    rail('west-rail-out', -2.64, -11.5, -2.64, -6.7, 2.4, up + STAIR_RAIL_TOP, 0.08),
    rail('landing-rail', -2.64, -12.94, 2.64, -12.94, 2.4, 2.4 + STAIR_RAIL_TOP, 0.08),
    // Under-stair closure (lines 124–125) plus ground blockers that seal the gap
    // the model leaves north of z=-12.65 below the landing ("no access below").
    box('under-stair-south', -2.7, 0.3, -6.78, -6.66, 0, 2.2),
    box('under-stair-west', -2.82, -2.58, -WALL_IN.z, -6.7, 0, 2.2),
    box('under-stair-east', 2.58, 2.82, -WALL_IN.z, -6.7, 0, 2.2),
    // Exhibit plinths 1.2×1.2, 1.17 tall (lines 133–138).
    ...slots.map(s => {
      const [x, y, z] = s.position, hx = s.footprint[0] / 2 + 0.02, hz = s.footprint[1] / 2 + 0.02;
      return box(`slot-${s.id}`, x - hx, x + hx, z - hz, z + hz, y, y + 1.2);
    }),
  ];
  return { surfaces, colliders, slots, entry: { x: 0, y: 0, z: 12.2 } };
}

function surfaceY(s: Surface, z: number): number {
  if (s.y !== undefined) return s.y;
  const r = s.ramp!, t = Math.min(1, Math.max(0, (z - r.zA) / (r.zB - r.zA)));
  return r.y0 + (r.y1 - r.y0) * t;
}
const inRect = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

/** Highest walkable surface under (x,z) that feet at y can step onto; null = void. */
export function supportAt(world: NavWorld, x: number, z: number, y: number): number | null {
  let best: number | null = null;
  for (const s of world.surfaces) {
    if (!inRect(s, x, z)) continue;
    const h = surfaceY(s, z);
    if (h <= y + BODY.stepUp && (best === null || h > best)) best = h;
  }
  return best;
}

const activeAt = (c: Collider, y: number) => c.y1 > y + BODY.stepUp && c.y0 < y + BODY.height;

/** Push the body circle out of every collider overlapping its vertical span. */
function resolve(world: NavWorld, x: number, z: number, y: number): [number, number] {
  const r = BODY.radius;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const c of world.colliders) {
      if (!activeAt(c, y)) continue;
      if (c.kind === 'circle') {
        const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), min = r + c.r;
        if (d < min) { const k = d > 1e-6 ? (min - d) / d : 0; x += d > 1e-6 ? dx * k : min; z += dz * k; moved = true; }
        continue;
      }
      const cx = Math.min(c.x1, Math.max(c.x0, x)), cz = Math.min(c.z1, Math.max(c.z0, z));
      const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d > 1e-6) { x += dx / d * (r - d); z += dz / d * (r - d); }
      else { // centre inside the box: leave by the shallowest face
        const exits = [[c.x0 - r - x, 0], [c.x1 + r - x, 0], [0, c.z0 - r - z], [0, c.z1 + r - z]];
        const [ex, ez] = exits.reduce((a, b) => Math.abs(a[0] + a[1]) < Math.abs(b[0] + b[1]) ? a : b);
        x += ex; z += ez;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return [x, z];
}

function overlapsAny(world: NavWorld, x: number, z: number, y: number): boolean {
  const r = BODY.radius - 1e-3;
  return world.colliders.some(c => {
    if (!activeAt(c, y)) return false;
    if (c.kind === 'circle') return Math.hypot(x - c.x, z - c.z) < r + c.r;
    const cx = Math.min(c.x1, Math.max(c.x0, x)), cz = Math.min(c.z1, Math.max(c.z0, z));
    return Math.hypot(x - cx, z - cz) < r;
  });
}

/** One tiny move; returns the new player or null if the target is a wall/void/ledge. */
function tryMove(world: NavWorld, p: Player, dx: number, dz: number): Player | null {
  const [x, z] = resolve(world, p.x + dx, p.z + dz, p.y);
  if (Math.hypot(x - p.x, z - p.z) > Math.hypot(dx, dz) + 0.02) return null; // never let push-out teleport
  const ground = supportAt(world, x, z, p.y);
  if (ground === null || ground < p.y - BODY.maxDrop) return null; // anti-fall: no stepping off edges
  if (overlapsAny(world, x, z, ground)) return null; // new height must also be clear
  return { x, y: ground, z };
}

/**
 * Advance the player by `dt` seconds of input. Movement is swept in ≤5 cm
 * substeps whatever the frame rate, so low FPS cannot tunnel through rails.
 */
export function step(world: NavWorld, p: Player, input: MoveInput, yaw: number, dt: number): Player {
  let f = input.forward, rt = input.right;
  const len = Math.hypot(f, rt);
  if (!len) return p;
  f /= len; rt /= len;
  const dist = (input.run ? BODY.run : BODY.walk) * Math.min(dt, 0.25);
  const dirX = -Math.sin(yaw) * f + Math.cos(yaw) * rt, dirZ = -Math.cos(yaw) * f - Math.sin(yaw) * rt;
  const n = Math.max(1, Math.ceil(dist / BODY.substep)), sx = dirX * dist / n, sz = dirZ * dist / n;
  let cur = p;
  for (let i = 0; i < n; i++) {
    // full move, else slide along whichever axis is still free
    cur = tryMove(world, cur, sx, sz) ?? tryMove(world, cur, sx, 0) ?? tryMove(world, cur, 0, sz) ?? cur;
  }
  return cur;
}

export function floorOf(y: number): 'ground' | 'stairs' | 'upper' {
  return y < 0.2 ? 'ground' : y > UPPER_Y - 0.2 ? 'upper' : 'stairs';
}

/** Nearest exhibit plinth hit by a ray within maxDist (slab test on the plinth box). */
export function targetSlot(world: NavWorld, origin: [number, number, number], dir: [number, number, number], maxDist = 3): ExhibitSlot | null {
  let best: ExhibitSlot | null = null, bestT = maxDist;
  for (const s of world.slots) {
    const [x, y, z] = s.position, hx = s.footprint[0] / 2, hz = s.footprint[1] / 2;
    const lo = [x - hx, y, z - hz], hi = [x + hx, y + 1.25, z + hz];
    let t0 = 0, t1 = bestT, ok = true;
    for (let a = 0; a < 3 && ok; a++) {
      if (Math.abs(dir[a]) < 1e-9) { if (origin[a] < lo[a] || origin[a] > hi[a]) ok = false; continue; }
      let ta = (lo[a] - origin[a]) / dir[a], tb = (hi[a] - origin[a]) / dir[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) ok = false;
    }
    if (ok && t0 < bestT) { bestT = t0; best = s; }
  }
  return best;
}
