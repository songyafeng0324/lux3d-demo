/**
 * Pavilion navigation contract (metres, Web Y up, north = -Z, east = +X).
 *
 * The geometry is NOT written here: scripts/blender/build_t16.py declares every part once and
 * exports both the render GLB and assets/t16/pavilion-layout.json (walk surfaces, colliders, jump
 * ceilings, camera-only blockers, exhibit slots). This module only runs the walking rules on that
 * data. Walk surfaces are what feet stand on (stairs are one flat surface per tread); colliders are
 * vertical blockers checked against the body circle. The browser check compares the surfaces with
 * real downward rays against the GLB, so drift is detectable.
 *
 * Pure TypeScript with no runtime dependencies, so node --test can import it.
 */

export interface Rect { x0: number; x1: number; z0: number; z1: number }
/** Flat surface (y) or a ramp along Z: y goes from y0 at z=zA to y1 at z=zB. */
export interface Surface extends Rect { id: string; y?: number; ramp?: { zA: number; zB: number; y0: number; y1: number } }
export interface BoxCollider extends Rect { id: string; kind: 'box'; y0: number; y1: number; solid?: boolean }
export interface CircleCollider { id: string; kind: 'circle'; x: number; z: number; r: number; y0: number; y1: number }
export type Collider = BoxCollider | CircleCollider;
/** Exhibit slot n = marker `T0n`. `fit` is the tier's largest edge and the height the model rests at. */
export interface ExhibitSlot {
  id: string; floor: number; position: [number, number, number]; footprint: [number, number];
  tier?: 'S' | 'A' | 'B'; label?: string; yaw?: number;
  fit?: { maxSize: number; restY: number };
  /** Vertical extent of the box E-targeting aims at (defaults to the old 1.25 m plinth). */
  target?: { y0: number; y1: number };
}
export interface WalkingWorld { surfaces: Surface[]; colliders: Collider[]; airColliders: Collider[]; entry: Player }
export interface NavWorld extends WalkingWorld { slots: ExhibitSlot[]; cameraBlockers: Collider[]; floorY: number; entryYaw: number }
/** The exported layout (assets/t16/pavilion-layout.json), as far as walking needs it. */
export interface PavilionLayout {
  upperY: number; floorY: number; entry: Player; entryYaw: number;
  exhibitSlots: ExhibitSlot[]; surfaces: Surface[]; colliders: Collider[]; airColliders: Collider[]; cameraBlockers: Collider[];
}
export interface Player { x: number; y: number; z: number }
export interface FirstPerson extends Player { velocityY: number | null }
export interface MoveInput { forward: number; right: number; run: boolean }
export const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0],
  KeyA: [0, -1], ArrowLeft: [0, -1], KeyD: [0, 1], ArrowRight: [0, 1],
};

/** walk = the old Shift speed (2026-11-09); Shift multiplies it by the same 1.73× again. */
export const BODY = { radius: 0.3, height: 1.7, eye: 1.6, stepUp: 0.3, maxDrop: 0.45, walk: 5.2, run: 9.0, substep: 0.05, jump: 6.9, gravity: 14 } as const;
/** Upper floor height of the T16 pavilion (checked against the layout by the tests). */
export const UPPER_Y = 9;

export function buildNavWorld(layout: PavilionLayout): NavWorld {
  return {
    // colliders is a fresh array: the engine adds and removes the loaded exhibits' boxes at run time.
    surfaces: layout.surfaces, colliders: [...layout.colliders], airColliders: layout.airColliders,
    cameraBlockers: layout.cameraBlockers, slots: layout.exhibitSlots,
    entry: { ...layout.entry }, entryYaw: layout.entryYaw, floorY: layout.floorY,
  };
}

function surfaceY(s: Surface, z: number): number {
  if (s.y !== undefined) return s.y;
  const r = s.ramp!, t = Math.min(1, Math.max(0, (z - r.zA) / (r.zB - r.zA)));
  return r.y0 + (r.y1 - r.y0) * t;
}
const inRect = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

/** Highest walkable surface under (x,z) that feet at y can step onto; null = void. */
export function supportAt(world: WalkingWorld, x: number, z: number, y: number): number | null {
  let best: number | null = null;
  for (const s of world.surfaces) {
    if (!inRect(s, x, z)) continue;
    const h = surfaceY(s, z);
    if (h <= y + BODY.stepUp && (best === null || h > best)) best = h;
  }
  return best;
}

const EPSILON = 1e-6;
const activeAt = (c: Collider, y: number) => c.y1 > y + (c.kind === 'box' && c.solid ? EPSILON : BODY.stepUp) && c.y0 < y + BODY.height;

/** Push the body circle out of every collider overlapping its vertical span. */
function resolve(world: WalkingWorld, x: number, z: number, y: number): [number, number] {
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

function overlapsFootprint(c: Collider, x: number, z: number): boolean {
  const r = BODY.radius - 1e-3;
  if (c.kind === 'circle') return Math.hypot(x - c.x, z - c.z) < r + c.r;
  const cx = Math.min(c.x1, Math.max(c.x0, x)), cz = Math.min(c.z1, Math.max(c.z0, z));
  return Math.hypot(x - cx, z - cz) < r;
}

export function playerOverlaps(colliders: readonly Collider[], { x, y, z }: Player): boolean {
  return colliders.some(c => c.y1 > y + EPSILON && c.y0 < y + BODY.height - EPSILON && overlapsFootprint(c, x, z));
}

/** One tiny move; returns the new player or null if the target is a wall/void/ledge. */
function tryMove(world: WalkingWorld, p: Player, dx: number, dz: number): Player | null {
  const [x, z] = resolve(world, p.x + dx, p.z + dz, p.y);
  if (Math.hypot(x - p.x, z - p.z) > Math.hypot(dx, dz) + 0.02) return null; // never let push-out teleport
  const ground = supportAt(world, x, z, p.y);
  if (ground === null || ground < p.y - BODY.maxDrop) return null; // anti-fall: no stepping off edges
  if (world.colliders.some(c => activeAt(c, ground) && overlapsFootprint(c, x, z))) return null;
  return { x, y: ground, z };
}

/**
 * Advance the player by `dt` seconds of input. Movement is swept in ≤5 cm
 * substeps whatever the frame rate, so low FPS cannot tunnel through rails.
 */
function velocity(world: WalkingWorld, input: MoveInput, yaw: number): [number, number] {
  const { forward: f, right: r } = input;
  const speed = (input.run ? BODY.run : BODY.walk) / (Math.hypot(f, r) || 1);
  return [(-Math.sin(yaw) * f + Math.cos(yaw) * r) * speed, (-Math.cos(yaw) * f - Math.sin(yaw) * r) * speed];
}

export function step(world: WalkingWorld, p: Player, input: MoveInput, yaw: number, dt: number): Player {
  if (!input.forward && !input.right) return p;
  const [vx, vz] = velocity(world, input, yaw);
  const elapsed = Math.min(dt, 0.25);
  const n = Math.max(1, Math.ceil(Math.hypot(vx, vz) * elapsed / BODY.substep));
  const sx = vx * elapsed / n, sz = vz * elapsed / n;
  let cur = p;
  for (let i = 0; i < n; i++) {
    // full move, else slide along whichever axis is still free
    cur = tryMove(world, cur, sx, sz) ?? tryMove(world, cur, sx, 0) ?? tryMove(world, cur, 0, sz) ?? cur;
  }
  return cur;
}

/**
 * Horizontal move while airborne. A walk surface is the top of solid mass (a tread, the landing): if it
 * stands above the feet within the body's span, the feet may not slide into it from the side. Up to one
 * step (BODY.stepUp) the feet are lifted onto it — landing if already falling — like walking up a riser;
 * anything taller is a wall. Without this, a jump up the central flight could carry the feet past a
 * riser, the tread would then count as "above the feet", and the fall landed on the floor inside the stairs.
 */
function moveInAir(world: WalkingWorld, colliders: readonly Collider[], p: FirstPerson, dx: number, dz: number): FirstPerson {
  const tryAir = (x: number, z: number): FirstPerson | null => {
    let y = p.y, any = false;
    for (const s of world.surfaces) {
      if (!inRect(s, x, z)) continue;
      any = true;
      const h = surfaceY(s, z);
      if (h <= p.y + EPSILON || h >= p.y + BODY.height) continue;
      if (h - p.y > BODY.stepUp) return null;
      y = Math.max(y, h);
    }
    if (!any) return null;
    const next: FirstPerson = y > p.y ? { x, y, z, velocityY: (p.velocityY ?? 0) > 0 ? p.velocityY : null } : { ...p, x, z };
    return playerOverlaps(colliders, next) ? null : next;
  };
  return tryAir(p.x + dx, p.z + dz) ?? tryAir(p.x + dx, p.z) ?? tryAir(p.x, p.z + dz) ?? p;
}

function verticalMove(world: WalkingWorld, colliders: readonly Collider[], p: FirstPerson, previous: Player, dt: number): FirstPerson {
  const velocityY = p.velocityY ?? 0;
  const nextVelocity = velocityY - BODY.gravity * dt;
  const y = p.y + (velocityY + nextVelocity) * 0.5 * dt;
  if (y > p.y) {
    let ceiling: number | null = null;
    for (const c of colliders) {
      const headStop = c.y0 - BODY.height;
      if (headStop >= p.y - EPSILON && headStop <= y && (ceiling === null || headStop < ceiling) && overlapsFootprint(c, p.x, p.z)) ceiling = headStop;
    }
    return ceiling === null ? { ...p, y, velocityY: nextVelocity } : { ...p, y: ceiling, velocityY: 0 };
  }
  let floor: number | null = null;
  const consider = (h: number, previousHeight: number) => {
    if (h >= y && previousHeight <= previous.y + EPSILON && (floor === null || h > floor)) floor = h;
  };
  for (const surface of world.surfaces) {
    if (!inRect(surface, p.x, p.z)) continue;
    const height = surfaceY(surface, p.z);
    // An uphill ramp can rise above the feet during the same slice as the descent.
    consider(height, inRect(surface, previous.x, previous.z) ? surfaceY(surface, previous.z) : height);
  }
  for (const c of colliders) if (overlapsFootprint(c, p.x, p.z)) consider(c.y1, c.y1);
  return floor === null ? { ...p, y, velocityY: nextVelocity } : { ...p, y: floor, velocityY: null };
}

/** Preserve grounded navigation and use swept 3D collisions for a deliberate jump or a step off an object. */
export function stepFirstPerson(world: WalkingWorld, p: FirstPerson, input: MoveInput, yaw: number, dt: number, jump: boolean): FirstPerson {
  const moving = Boolean(input.forward || input.right);
  if (p.velocityY === null && !jump) {
    if (!moving) return p;
    const standingOnSurface = supportAt(world, p.x, p.z, p.y - BODY.stepUp + EPSILON);
    if (standingOnSurface !== null && Math.abs(standingOnSurface - p.y) <= EPSILON) {
      return { ...step(world, p, input, yaw, dt), velocityY: null };
    }
  }

  const colliders = [...world.colliders, ...world.airColliders];
  const [vx, vz] = velocity(world, input, yaw);
  const elapsed = Math.min(dt, 0.25);
  const n = Math.max(1, Math.ceil(elapsed * 120)), slice = elapsed / n;
  let current = p.velocityY === null && jump ? { ...p, velocityY: BODY.jump } : p;
  for (let i = 0; i < n; i++) {
    const previous = current;
    if (moving) current = moveInAir(world, colliders, current, vx * slice, vz * slice);
    // Lifted onto a riser while falling: the rest of the frame is ordinary walking. (Standing on a collider
    // top — a plinth — also has velocityY null but no lift; it keeps the airborne path, as before.)
    if (current.velocityY === null && current.y > previous.y) return { ...step(world, current, input, yaw, (n - i - 1) * slice), velocityY: null };
    current = verticalMove(world, colliders, current, previous, slice);
  }
  return current;
}

export function floorOf(y: number): 'ground' | 'stairs' | 'upper' {
  return y < 0.2 ? 'ground' : y > UPPER_Y - 0.2 ? 'upper' : 'stairs';
}

/** Horizontal reach and half-angle of the facing fallback in targetSlot. */
export const TARGET_FACING = { reach: 2.5, halfAngle: Math.PI * 40 / 180 } as const;

/**
 * The plinth the visitor is aiming at: first the nearest plinth box hit by the view ray within maxDist;
 * if the ray misses (looking level or up past a low plinth, common in third person), the nearest plinth
 * on the same floor within TARGET_FACING.reach whose centre lies within TARGET_FACING.halfAngle of the
 * horizontal view direction. Pitch alone never hides the E prompt (2026-11-10 user feedback).
 */
export function targetSlot(world: NavWorld, origin: [number, number, number], dir: [number, number, number], maxDist = 3, feetY = origin[1] - BODY.eye): ExhibitSlot | null {
  return rayTarget(world, origin, dir, maxDist) ?? facingTarget(world, origin, dir, feetY);
}

/** Does the horizontal segment a→b cross a collider that blocks a body standing at feetY (walls, pillars)? */
function segmentBlocked(world: WalkingWorld, [ax, az]: [number, number], [bx, bz]: [number, number], feetY: number): boolean {
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  for (const c of world.colliders) {
    if (c.id.startsWith(EXHIBIT_COLLIDER) || !activeAt(c, feetY)) continue;
    if (c.kind === 'circle') {
      const t = len2 ? Math.min(1, Math.max(0, ((c.x - ax) * dx + (c.z - az) * dz) / len2)) : 0;
      if (Math.hypot(ax + dx * t - c.x, az + dz * t - c.z) < c.r) return true;
      continue;
    }
    let t0 = 0, t1 = 1;
    for (const [o, d, lo, hi] of [[ax, dx, c.x0, c.x1], [az, dz, c.z0, c.z1]] as const) {
      if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) { t0 = 2; break; } continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 <= t1) return true;
  }
  return false;
}

function facingTarget(world: NavWorld, [ox, , oz]: [number, number, number], [dx, , dz]: [number, number, number], feetY: number): ExhibitSlot | null {
  const h = Math.hypot(dx, dz);
  if (h < 1e-6) return null;
  let best: ExhibitSlot | null = null, bestD: number = TARGET_FACING.reach;
  for (const s of world.slots) {
    const [x, y, z] = s.position, hx = s.footprint[0] / 2, hz = s.footprint[1] / 2;
    if (Math.abs(feetY - y) > BODY.stepUp) continue;                         // same floor as the visitor's feet (not mid-stairs)
    const nx = Math.min(x + hx, Math.max(x - hx, ox)), nz = Math.min(z + hz, Math.max(z - hz, oz));
    const d = Math.hypot(nx - ox, nz - oz);
    if (d > bestD) continue;
    const cx = x - ox, cz = z - oz, cl = Math.hypot(cx, cz);
    if (cl > 1e-6 && (cx * dx + cz * dz) / (cl * h) < Math.cos(TARGET_FACING.halfAngle)) continue;
    // Not through a wall: the line to the plinth edge (stopping just short of it) must be clear.
    const k = d > 0.15 ? (d - 0.15) / d : 0;
    if (k > 0 && segmentBlocked(world, [ox, oz], [ox + (nx - ox) * k, oz + (nz - oz) * k], feetY)) continue;
    best = s; bestD = d;
  }
  return best;
}

/** Run-time exhibit boxes (engine.setExhibits) carry this id prefix; layout colliders never do. */
export const EXHIBIT_COLLIDER = 'exhibit-';

/**
 * A loaded exhibit's world box as a walking collider (conservative: the AABB of the turned model), or
 * null if the box is empty or not finite (a broken model must never poison the walker with NaN).
 */
export function exhibitCollider(slotNo: number, min: readonly number[], max: readonly number[]): BoxCollider | null {
  if (![...min, ...max].every(Number.isFinite) || min.some((v, i) => v >= max[i])) return null;
  return { id: `${EXHIBIT_COLLIDER}${slotNo}`, kind: 'box', x0: min[0], x1: max[0], y0: min[1], y1: max[1], z0: min[2], z1: max[2] };
}

/**
 * If the player overlaps a collider (an exhibit that just loaded where they stand, e.g. on its plinth
 * top), move them to the nearest free standing spot nearby; push-out in tryMove deliberately refuses
 * long jumps, so without this they could not move at all. Falls back to the entry.
 */
export function freePlayer(world: NavWorld, p: FirstPerson): FirstPerson {
  if (!playerOverlaps(world.colliders, p)) return p;
  for (const r of [0.4, 0.8, 1.2, 1.6, 2.2, 3, 4, 5, 6.5, 8]) {
    let best: FirstPerson | null = null;
    for (let k = 0; k < 24; k++) {
      const a = k * Math.PI / 12, x = p.x + r * Math.cos(a), z = p.z + r * Math.sin(a);
      const y = supportAt(world, x, z, p.y);
      if (y === null || playerOverlaps(world.colliders, { x, y, z })) continue;
      if (!best || Math.abs(y - p.y) < Math.abs(best.y - p.y)) best = { x, y, z, velocityY: null };
    }
    if (best) return best;
  }
  return { ...world.entry, velocityY: null };
}

function rayTarget(world: NavWorld, origin: [number, number, number], dir: [number, number, number], maxDist: number): ExhibitSlot | null {
  let best: ExhibitSlot | null = null, bestT = maxDist;
  for (const s of world.slots) {
    const [x, y, z] = s.position, hx = s.footprint[0] / 2, hz = s.footprint[1] / 2;
    const lo = [x - hx, s.target?.y0 ?? y, z - hz], hi = [x + hx, s.target?.y1 ?? y + 1.25, z + hz];
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

/**
 * Third-person camera geometry: the walking colliders and surfaces, plus the jump ceilings (slab and
 * tread undersides) and the camera-only blockers the build script exports for everything else the
 * boom could pass through (capitals, clerestory, caisson rings, lanterns, alcove canopies, door head).
 */
export function pavilionCamera(world: NavWorld): { world: { colliders: readonly Collider[]; surfaces: readonly Surface[]; floorY: number; passThrough: ReadonlySet<string> }; blockers: Collider[] } {
  return {
    world: { colliders: world.colliders, surfaces: world.surfaces, floorY: world.floorY, passThrough: new Set<string>() },
    blockers: [...world.airColliders, ...world.cameraBlockers],
  };
}
