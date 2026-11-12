import { ROOM_BOUNDS, ROOM_COURTYARD_BOUNDS, ROOM_PLATFORM_HALF, ROOM_ROOF_RISE } from '@aholo/contracts';

/**
 * T17 house and courtyard layout. The scene (house.ts, courtyard.ts) and the walking and
 * placement rules (navigation.ts) both read these numbers, so they cannot drift apart.
 */
export const GROUND_Y = ROOM_COURTYARD_BOUNDS.min[1];
/** Top of the indoor tiles; equals the contract floor ROOM_BOUNDS.min[1]. */
export const FLOOR_Y = ROOM_BOUNDS.min[1];
export const PLATFORM = ROOM_PLATFORM_HALF;
export const HOUSE = { x: ROOM_BOUNDS.max[0], z: ROOM_BOUNDS.max[2], height: ROOM_BOUNDS.max[1] };

export const WALL = { thickness: .16, height: .9, cap: .08 } as const;
/** Low walls including their wooden cap rail. */
export const WALL_TOP = WALL.height + WALL.cap;
/** Beams ring the top of the posts; everything hung from them starts at the beam soffit. */
export const BEAM = { width: .22, depth: .24 } as const;
export const BEAM_SOFFIT = HOUSE.height - .1 - BEAM.depth / 2;
export const POST = { radius: .15, base: .17, plinthRadius: .21, plinthHeight: .14 } as const;

/** Posts: five along each side wall, three more inside the rear wall (corners shared). */
export const POSTS: [number, number][] = [
  ...[-HOUSE.x, HOUSE.x].flatMap(cx => [-HOUSE.z, -HOUSE.z / 2, 0, HOUSE.z / 2, HOUSE.z].map((cz): [number, number] => [cx, cz])),
  [-HOUSE.x / 2, -HOUSE.z], [0, -HOUSE.z], [HOUSE.x / 2, -HOUSE.z],
];

export const PORCH_STEP = { x0: -1.025, x1: 1.025, z0: PLATFORM.z, z1: 5.4, y: -.2 };
/** Stone path from the porch to the gate in the south fence. */
export const PATH = { halfWidth: 1.05, curb: .14, z0: PORCH_STEP.z1, z1: ROOM_COURTYARD_BOUNDS.max[2] } as const;

/** Lanterns hang from the front lintel, clear of the side friezes. */
export const LANTERNS: [number, number][] = [[-HOUSE.x / 2 - .9, HOUSE.z], [HOUSE.x / 2 + .9, HOUSE.z]];
export const LANTERN = { radius: .24, stretch: 1.3, drop: .62 } as const;
export const lanternCentreY = () => BEAM_SOFFIT - LANTERN.drop - LANTERN.radius * LANTERN.stretch;

/** The fence runs just outside the placement edge, so every legal placement stays inside it. */
export const FENCE = {
  x: ROOM_COURTYARD_BOUNDS.max[0] + .12, z: ROOM_COURTYARD_BOUNDS.max[2] + .12,
  height: 1.05, post: .13, gate: PATH.halfWidth + .25,
} as const;

/** Swept gable roof: height above the posts at |x| (ridge along z). Shared by the roof strips and the purlins. */
export const ROOF = { overhangX: .9, overhangZ: .75, rise: ROOM_ROOF_RISE, curl: .55, thickness: .13 } as const;
export function roofHeight(x: number) {
  const a = Math.min(Math.abs(x) / (HOUSE.x + ROOF.overhangX), 1);
  return HOUSE.height + ROOF.rise * (1 - a) + ROOF.curl * a * a * a;
}
