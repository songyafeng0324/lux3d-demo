import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';
register(); // room/*.ts import TS sources and @aholo/contracts
const { buildRoomWorld, placementConflict, settlePlacement } = await import('../apps/web/src/room/navigation.ts');
const { FENCE, FLOOR_Y, GROUND_Y, PLATFORM, POSTS, POST } = await import('../apps/web/src/room/layout.ts');
const { ROOM_COURTYARD_BOUNDS, roomPlacementBounds, roomPlacementFloor, validateRoomLayout } = await import('@aholo/contracts');
const { stepFirstPerson, playerOverlaps, BODY } = await import('../apps/web/src/game/navigation.ts');

const cube = { min: [-.5, 0, -.5], max: [.5, 1, .5] };
const at = (x, y, z) => roomPlacementBounds({ id: 'p', assetId: 'a', position: [x, y, z], rotation: [0, 0, 0], scale: 1 }, cube);
const shifted = (b, s) => ({ min: b.min.map((v, i) => v + s[i]), max: b.max.map((v, i) => v + s[i]) });

test('T17 grounds: the house platform is the centre cell of a 3×3 grid and the fence stands outside it', () => {
  assert.ok(Math.abs(ROOM_COURTYARD_BOUNDS.max[0] - 3 * PLATFORM.x) < 1e-9);
  assert.ok(Math.abs(ROOM_COURTYARD_BOUNDS.max[2] - 3 * PLATFORM.z) < 1e-9);
  assert.ok(FENCE.x - FENCE.post / 2 > ROOM_COURTYARD_BOUNDS.max[0] && FENCE.z - FENCE.post / 2 > ROOM_COURTYARD_BOUNDS.max[2]);
  assert.equal(FLOOR_Y, 0, 'items on the house floor stand on the tile tops (contract floor)');
  const world = buildRoomWorld([], new Map());
  // Walking straight at each fence stops inside it.
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    let player = { x: 12, y: GROUND_Y, z: 9, velocityY: null };
    for (let i = 0; i < 600; i++) player = stepFirstPerson(world, player, { forward: 1, right: 0, run: true }, yaw, 1 / 30, false);
    assert.ok(Math.abs(player.x) < FENCE.x - FENCE.post && Math.abs(player.z) < FENCE.z - FENCE.post, `yaw ${yaw}: ${player.x}, ${player.z}`);
  }
});

test('T17 walk-through items (grass) never block walking; ordinary items still do', () => {
  const bounds = new Map([['grass', cube], ['chest', cube]]);
  const placements = [{ id: 'g', assetId: 'grass', position: [10, GROUND_Y, 8], rotation: [0, 0, 0], scale: 2 }];
  const solid = buildRoomWorld(placements.map(p => ({ ...p, assetId: 'chest' })), bounds);
  const open = buildRoomWorld(placements, bounds, new Set(['grass']));
  const inside = { x: 10, y: GROUND_Y, z: 8, velocityY: null };
  assert.ok(playerOverlaps(solid.colliders, inside));
  assert.ok(!playerOverlaps(open.colliders, inside));
});

test('T17 editor: items touching posts, walls, the step or the platform edge are flagged and pushed clear', () => {
  assert.equal(placementConflict(at(0, 0, 0)), null);
  assert.equal(placementConflict(at(10, GROUND_Y, 8)), null);
  const [px, pz] = POSTS[0];
  const cases = [
    at(px + .3, 0, pz + 1.2), // into a side post and wall
    at(0, 0, -4.3), // into the rear wall
    at(PLATFORM.x - .2, 0, 0), // hangs over the platform edge
    at(0, GROUND_Y, 5.6), // into the porch step
  ];
  for (const b of cases) {
    assert.ok(placementConflict(b), JSON.stringify(b));
    const shift = settlePlacement(b);
    assert.ok(shift, 'a clear spot is close');
    const settled = shifted(b, shift);
    assert.equal(placementConflict(settled), null, JSON.stringify(settled));
    assert.ok(Math.hypot(shift[0], shift[2]) < 1.2, `small move: ${shift}`);
    // The settled item rests on the floor it ends up over and stays valid.
    assert.ok(Math.abs(settled.min[1] - roomPlacementFloor(settled)) < 1e-9);
  }
  // A placement legal before T17 stays legal (the push-out is editor-only).
  assert.equal(validateRoomLayout('旧布局', [{ id: 'p', assetId: 'a', position: [PLATFORM.x - .2, 0, 0], rotation: [0, 0, 0], scale: 1 }], new Map([['a', cube]])), null);
  // Plinths are wider than the old post collider, so the body is kept off them too.
  assert.ok(POST.plinthRadius >= POST.base);
  assert.ok(BODY.radius > 0);
});
