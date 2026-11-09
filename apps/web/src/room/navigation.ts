import { ROOM_BOUNDS, ROOM_COURTYARD_BOUNDS, ROOM_PLATFORM_HALF, roomPlacementBounds, type Bounds, type RoomPlacement } from '@aholo/contracts';
import { BODY, playerOverlaps, supportAt, type BoxCollider, type CircleCollider, type Collider, type FirstPerson, type WalkingWorld } from '../game/navigation.js';

const ground = ROOM_COURTYARD_BOUNDS.min[1];
const indoor = .025; // Top of the indoor tiles.
const platform = ROOM_PLATFORM_HALF;
const house = { x: ROOM_BOUNDS.max[0], z: ROOM_BOUNDS.max[2] };
export const PORCH_STEP = { x0: -1.025, x1: 1.025, z0: platform.z, z1: 5.4, y: -.2 };
export const ROOM_EYE_HEIGHT = 1.625;

const box = (id: string, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): BoxCollider =>
  ({ id, kind: 'box', x0, x1, z0, z1, y0, y1, solid: true });

export function buildRoomWorld(placements: RoomPlacement[], bounds: ReadonlyMap<string, Bounds>): WalkingWorld {
  // Keep the whole body on the dirt. Around the house the dirt stops at the foundation.
  const x = ROOM_COURTYARD_BOUNDS.max[0] - BODY.radius, z = ROOM_COURTYARD_BOUNDS.max[2] - BODY.radius;
  const surfaces = [
    { id: 'courtyard-west', x0: -x, x1: -platform.x, z0: -z, z1: z, y: ground },
    { id: 'courtyard-east', x0: platform.x, x1: x, z0: -z, z1: z, y: ground },
    { id: 'courtyard-north', x0: -platform.x, x1: platform.x, z0: -z, z1: -platform.z, y: ground },
    { id: 'courtyard-south', x0: -platform.x, x1: platform.x, z0: platform.z, z1: z, y: ground },
    { id: 'house-platform', x0: -platform.x, x1: platform.x, z0: -platform.z, z1: platform.z, y: indoor },
    { id: 'porch-step', ...PORCH_STEP },
  ];
  const columns: [number, number][] = [
    ...[-house.x, house.x].flatMap(cx => [-house.z, -house.z / 2, 0, house.z / 2, house.z].map((cz): [number, number] => [cx, cz])),
    [-house.x / 2, -house.z], [0, -house.z], [house.x / 2, -house.z],
  ];
  const colliders = [
    box('side-wall-west', -house.x - .08, -house.x + .08, -house.z, house.z, 0, .9),
    box('side-wall-east', house.x - .08, house.x + .08, -house.z, house.z, 0, .9),
    box('rear-wall-and-lattice', -house.x, house.x, -house.z - .08, -house.z + .08, 0, 3.7),
    ...columns.map(([cx, cz], i): CircleCollider => ({ kind: 'circle', id: 'post-' + i, x: cx, z: cz, r: .17, y0: 0, y1: ROOM_BOUNDS.max[1] })),
  ];
  for (const placement of placements) {
    const asset = bounds.get(placement.assetId);
    if (!asset) continue;
    const { min, max } = roomPlacementBounds(placement, asset);
    colliders.push(box(placement.id, min[0], max[0], min[2], max[2], min[1], max[1]));
  }
  return {
    surfaces, colliders, walkSpeed: 2.6,
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

/** Camera-only blockers for the third-person boom: the roof with its eaves and the side friezes (scene/assets.ts architecture()). */
const ROOF_TOP = ROOM_BOUNDS.max[1];
export const ROOM_CAMERA_BLOCKERS: Collider[] = [
  { id: 'roof', kind: 'box', x0: -ROOM_BOUNDS.max[0] - 1.1, x1: ROOM_BOUNDS.max[0] + 1.1, z0: -ROOM_BOUNDS.max[2] - .95, z1: ROOM_BOUNDS.max[2] + .95, y0: ROOF_TOP - .3, y1: ROOF_TOP + 2.2 },
  ...[-1, 1].map((side): Collider => ({ id: `side-frieze-${side}`, kind: 'box', x0: side * ROOM_BOUNDS.max[0] - .08, x1: side * ROOM_BOUNDS.max[0] + .08, z0: ROOM_BOUNDS.min[2], z1: ROOM_BOUNDS.max[2], y0: 3.5, y1: ROOF_TOP })),
];
