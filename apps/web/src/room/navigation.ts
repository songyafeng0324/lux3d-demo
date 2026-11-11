import { ROOM_BOUNDS, ROOM_COURTYARD_BOUNDS, roomPlacementBounds, roomPlacementFloor, type Bounds, type RoomPlacement } from '@aholo/contracts';
import { BODY, playerOverlaps, supportAt, type BoxCollider, type CircleCollider, type Collider, type FirstPerson, type WalkingWorld } from '../game/navigation.js';
import { BEAM_SOFFIT, FENCE, FLOOR_Y, GROUND_Y, HOUSE, LANTERN, LANTERNS, PLATFORM, POST, POSTS, PORCH_STEP, WALL, WALL_TOP, lanternCentreY } from './layout.js';

export { PORCH_STEP } from './layout.js';
const ground = GROUND_Y;
const indoor = FLOOR_Y;
const platform = PLATFORM;
const house = HOUSE;
export const ROOM_EYE_HEIGHT = 1.625;

const box = (id: string, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): BoxCollider =>
  ({ id, kind: 'box', x0, x1, z0, z1, y0, y1, solid: true });

/** Fixed parts of the house that people bump into; placements are added on top (navigation) or pushed clear (editor). */
function houseColliders(): Collider[] {
  const half = WALL.thickness / 2;
  return [
    box('side-wall-west', -house.x - half, -house.x + half, -house.z, house.z, 0, WALL_TOP),
    box('side-wall-east', house.x - half, house.x + half, -house.z, house.z, 0, WALL_TOP),
    box('rear-wall-and-lattice', -house.x, house.x, -house.z - half, -house.z + half, 0, BEAM_SOFFIT),
    ...POSTS.map(([cx, cz], i): CircleCollider => ({ kind: 'circle', id: 'post-' + i, x: cx, z: cz, r: POST.plinthRadius, y0: 0, y1: ROOM_BOUNDS.max[1] })),
  ];
}

const fenceColliders = (): Collider[] => {
  const t = FENCE.post / 2;
  return [
    box('fence-west', -FENCE.x - t, -FENCE.x + t, -FENCE.z, FENCE.z, ground, ground + FENCE.height),
    box('fence-east', FENCE.x - t, FENCE.x + t, -FENCE.z, FENCE.z, ground, ground + FENCE.height),
    box('fence-north', -FENCE.x, FENCE.x, -FENCE.z - t, -FENCE.z + t, ground, ground + FENCE.height),
    box('fence-south', -FENCE.x, FENCE.x, FENCE.z - t, FENCE.z + t, ground, ground + FENCE.height),
  ];
};

/**
 * walkThrough holds official ground cover (grass) that people pass through; it still
 * counts for the editor's push-out but never blocks walking.
 */
export function buildRoomWorld(placements: RoomPlacement[], bounds: ReadonlyMap<string, Bounds>, walkThrough: ReadonlySet<string> = new Set()): WalkingWorld {
  // Keep the whole body inside the fence. Around the house the lawn stops at the foundation.
  const x = ROOM_COURTYARD_BOUNDS.max[0] - BODY.radius, z = ROOM_COURTYARD_BOUNDS.max[2] - BODY.radius;
  const surfaces = [
    { id: 'courtyard-west', x0: -x, x1: -platform.x, z0: -z, z1: z, y: ground },
    { id: 'courtyard-east', x0: platform.x, x1: x, z0: -z, z1: z, y: ground },
    { id: 'courtyard-north', x0: -platform.x, x1: platform.x, z0: -z, z1: -platform.z, y: ground },
    { id: 'courtyard-south', x0: -platform.x, x1: platform.x, z0: platform.z, z1: z, y: ground },
    { id: 'house-platform', x0: -platform.x, x1: platform.x, z0: -platform.z, z1: platform.z, y: indoor },
    { id: 'porch-step', ...PORCH_STEP },
  ];
  const colliders = [...houseColliders(), ...fenceColliders()];
  for (const placement of placements) {
    const asset = bounds.get(placement.assetId);
    if (!asset || walkThrough.has(placement.assetId)) continue;
    const { min, max } = roomPlacementBounds(placement, asset);
    colliders.push(box(placement.id, min[0], max[0], min[2], max[2], min[1], max[1]));
  }
  return {
    surfaces, colliders,
    airColliders: [
      box('house-foundation', -platform.x, platform.x, -platform.z, platform.z, ground, indoor),
      box('porch-step', PORCH_STEP.x0, PORCH_STEP.x1, PORCH_STEP.z0, PORCH_STEP.z1, ground, PORCH_STEP.y),
    ],
    entry: { x: 0, y: PORCH_STEP.y, z: PORCH_STEP.z1 - BODY.radius },
  };
}

export function roomEntrance(world: WalkingWorld): FirstPerson {
  const entry = { ...world.entry, velocityY: null };
  if (!playerOverlaps(world.colliders, entry)) return entry;

  // If a placement blocks the step, use the outdoor path or another free surface.
  const path = { x: 0, y: ground, z: 6, velocityY: null };
  if (!playerOverlaps(world.colliders, path)) return path;
  for (const surface of world.surfaces) {
    for (let x = surface.x0 + .3; x < surface.x1; x += .6) {
      for (let z = surface.z0 + .3; z < surface.z1; z += .6) {
        const y = supportAt(world, x, z, Infinity)!;
        const candidate = { x, y, z, velocityY: null };
        if (!playerOverlaps(world.colliders, candidate)) return candidate;
      }
    }
  }

  // Even if the whole ground is covered, start above the outdoor path and land on the first surface.
  return { ...path, y: ROOM_COURTYARD_BOUNDS.max[1], velocityY: 0 };
}

/** Camera-only blockers for the third-person boom: the roof with its eaves, the side friezes and the lanterns (house.ts). */
const ROOF_TOP = ROOM_BOUNDS.max[1];
export const ROOM_CAMERA_BLOCKERS: Collider[] = [
  { id: 'roof', kind: 'box', x0: -ROOM_BOUNDS.max[0] - 1.1, x1: ROOM_BOUNDS.max[0] + 1.1, z0: -ROOM_BOUNDS.max[2] - .95, z1: ROOM_BOUNDS.max[2] + .95, y0: ROOF_TOP - .3, y1: ROOF_TOP + 2.2 },
  ...[-1, 1].map((side): Collider => ({ id: `side-frieze-${side}`, kind: 'box', x0: side * ROOM_BOUNDS.max[0] - .08, x1: side * ROOM_BOUNDS.max[0] + .08, z0: ROOM_BOUNDS.min[2], z1: ROOM_BOUNDS.max[2], y0: 3.5, y1: ROOF_TOP })),
  ...LANTERNS.map(([x, z], i): Collider => {
    const r = LANTERN.radius + .05, y = lanternCentreY();
    return { id: 'lantern-' + i, kind: 'box', x0: x - r, x1: x + r, z0: z - r, z1: z + r, y0: y - LANTERN.radius * LANTERN.stretch - .15, y1: BEAM_SOFFIT };
  }),
];

/** Editor obstacles: house parts as boxes with their height span, plus the porch step. */
interface Block { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
const STRUCTURE: Block[] = [
  ...houseColliders().map(c => c.kind === 'circle'
    ? { x0: c.x - c.r, x1: c.x + c.r, z0: c.z - c.r, z1: c.z + c.r, y0: c.y0, y1: c.y1 }
    : { x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1, y0: c.y0, y1: c.y1 }),
  { x0: PORCH_STEP.x0, x1: PORCH_STEP.x1, z0: PORCH_STEP.z0, z1: PORCH_STEP.z1, y0: ground, y1: PORCH_STEP.y },
  ...LANTERNS.map(([x, z]) => ({ x0: x - LANTERN.radius, x1: x + LANTERN.radius, z0: z - LANTERN.radius, z1: z + LANTERN.radius, y0: lanternCentreY() - LANTERN.radius * LANTERN.stretch - .1, y1: BEAM_SOFFIT })),
];
const GAP = .02, TOUCH = 1e-3;
const overlaps = (b: Bounds, o: Block) => b.min[0] < o.x1 - TOUCH && b.max[0] > o.x0 + TOUCH && b.min[2] < o.z1 - TOUCH && b.max[2] > o.z0 + TOUCH && b.min[1] < o.y1 - TOUCH && b.max[1] > o.y0 + TOUCH;
/** Resting on the house floor while partly sticking out over the lawn (that part would hang in the air). */
const straddles = (b: Bounds) => {
  const onPlatform = b.min[0] < platform.x && b.max[0] > -platform.x && b.min[2] < platform.z && b.max[2] > -platform.z;
  const inside = b.min[0] >= -platform.x - TOUCH && b.max[0] <= platform.x + TOUCH && b.min[2] >= -platform.z - TOUCH && b.max[2] <= platform.z + TOUCH;
  return onPlatform && !inside && b.min[1] <= indoor + .02;
};

/** Which fixed part a placement runs into, if any (the editor outlines it red). */
export function placementConflict(b: Bounds): string | null {
  if (straddles(b)) return '物品跨在台基边缘，一部分会悬空';
  return STRUCTURE.some(o => overlaps(b, o)) ? '物品碰到了柱子、墙体或台阶' : null;
}

const shortest = (...shifts: number[]) => shifts.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a);
/**
 * Smallest horizontal move that clears the house structure and the platform edge. Moving
 * on or off the platform also moves the item to that floor. Null when no clear spot is near.
 */
export function settlePlacement(start: Bounds): [number, number, number] | null {
  let b: Bounds = { min: [...start.min], max: [...start.max] };
  const move = (dx: number, dz: number) => {
    const floorBefore = roomPlacementFloor(b);
    const next: Bounds = { min: [b.min[0] + dx, b.min[1], b.min[2] + dz], max: [b.max[0] + dx, b.max[1], b.max[2] + dz] };
    // An item resting on (or sunk into) its floor lands on the floor it ends up over.
    const dy = b.min[1] <= floorBefore + .02 ? roomPlacementFloor(next) - b.min[1] : 0;
    next.min[1] += dy; next.max[1] += dy;
    b = next;
  };
  for (let step = 0; step < 8; step++) {
    if (straddles(b)) {
      const px = platform.x, pz = platform.z;
      const inX = b.min[0] < -px ? -px - b.min[0] : b.max[0] > px ? px - b.max[0] : 0;
      const inZ = b.min[2] < -pz ? -pz - b.min[2] : b.max[2] > pz ? pz - b.max[2] : 0;
      const width = b.max[0] - b.min[0], depth = b.max[2] - b.min[2];
      const fits = width <= 2 * px && depth <= 2 * pz;
      const outX = shortest(px - b.min[0] + GAP, -px - b.max[0] - GAP), outZ = shortest(pz - b.min[2] + GAP, -pz - b.max[2] - GAP);
      const options: [number, number][] = [[outX, 0], [0, outZ]];
      if (fits) options.push([inX, inZ]);
      const [dx, dz] = options.reduce((a, o) => Math.hypot(...o) < Math.hypot(...a) ? o : a);
      move(dx, dz);
      continue;
    }
    const hit = STRUCTURE.find(o => overlaps(b, o));
    if (!hit) {
      const outside = b.min[0] < ROOM_COURTYARD_BOUNDS.min[0] - 1e-6 || b.max[0] > ROOM_COURTYARD_BOUNDS.max[0] + 1e-6
        || b.min[2] < ROOM_COURTYARD_BOUNDS.min[2] - 1e-6 || b.max[2] > ROOM_COURTYARD_BOUNDS.max[2] + 1e-6;
      return outside ? null : [b.min[0] - start.min[0], b.min[1] - start.min[1], b.min[2] - start.min[2]];
    }
    const dx = shortest(hit.x1 - b.min[0] + GAP, hit.x0 - b.max[0] - GAP), dz = shortest(hit.z1 - b.min[2] + GAP, hit.z0 - b.max[2] - GAP);
    if (Math.abs(dx) <= Math.abs(dz)) move(dx, 0); else move(0, dz);
  }
  return null;
}

/**
 * T19: other placements as the editor sees them (world boxes, the same ones walking collides
 * with). Walk-through ground cover such as grass neither blocks nor holds anything up.
 */
export interface ItemBlock { id: string; box: Bounds }
export function itemBlocks(placements: readonly RoomPlacement[], bounds: ReadonlyMap<string, Bounds>, walkThrough: ReadonlySet<string>, exclude: ReadonlySet<string> = new Set()): ItemBlock[] {
  const blocks: ItemBlock[] = [];
  for (const placement of placements) {
    const asset = bounds.get(placement.assetId);
    if (asset && !walkThrough.has(placement.assetId) && !exclude.has(placement.id)) blocks.push({ id: placement.id, box: roomPlacementBounds(placement, asset) });
  }
  return blocks;
}

/** An item counts as resting on what is under it when its bottom is within this of the top. */
export const REST_GAP = .02;
const area = (b: Bounds) => (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
const centreOver = (b: Bounds, under: Bounds) => {
  const x = (b.min[0] + b.max[0]) / 2, z = (b.min[2] + b.max[2]) / 2;
  return x > under.min[0] && x < under.max[0] && z > under.min[2] && z < under.max[2];
};
/** `under` can hold `b` up: b's centre is over it and it is at least as large in plan. */
const holds = (under: Bounds, b: Bounds) => centreOver(b, under) && area(under) >= area(b) - 1e-9;

/**
 * What the item would stand on at its current spot: the top of the highest item under its centre
 * that is at least as large in plan (a vase on a table, not a table on a vase), else the floor.
 */
export function supportUnder(b: Bounds, items: readonly ItemBlock[]): { y: number; id: string | null } {
  let best: { y: number; id: string | null } = { y: roomPlacementFloor(b), id: null };
  for (const item of items) if (item.box.max[1] > best.y && holds(item.box, b)) best = { y: item.box.max[1], id: item.id };
  return best;
}

/** Items resting on `base` and, layer by layer, on those — they move together with it. Lowest first. */
export function ridersOf(base: ItemBlock, items: readonly ItemBlock[]): string[] {
  const riders: ItemBlock[] = [], queue = [base];
  for (let i = 0; i < queue.length; i++) {
    const under = queue[i];
    for (const item of items) {
      if (item.id === base.id || riders.includes(item)) continue;
      if (Math.abs(item.box.min[1] - under.box.max[1]) <= REST_GAP && holds(under.box, item.box)) { riders.push(item); queue.push(item); }
    }
  }
  return riders.map(r => r.id);
}

/** The first other item the box runs into; sitting exactly on top or side by side does not count. */
export function itemConflict(b: Bounds, items: readonly ItemBlock[]): string | null {
  for (const item of items) {
    const o = item.box;
    if (overlaps(b, { x0: o.min[0], x1: o.max[0], z0: o.min[2], z1: o.max[2], y0: o.min[1], y1: o.max[1] })) return item.id;
  }
  return null;
}
