// T15 third-person: follow-camera boom against the walking contract, avatar preference parsing,
// and the runtime character GLBs (structure, size, Idle/Run clips).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';
import { buildNavWorld, pavilionCamera, supportAt, step, stepFirstPerson, BODY } from '../apps/web/src/game/navigation.ts';
import { boomLength, clampFollowPitch, easeBoom, FOLLOW, turnToward, viewDirection } from '../apps/web/src/game/follow-camera.ts';
import { CHARACTERS, DEFAULT_PREFS, loadPrefs, parsePrefs, PREFS_KEY, savePrefs } from '../apps/web/src/game/avatar-prefs.ts';

register(); // room/navigation.ts imports '../game/navigation.js' (TS source) and @aholo/contracts
const { buildRoomWorld, roomEntrance, ROOM_CAMERA_BLOCKERS } = await import('../apps/web/src/room/navigation.ts');

const layout = JSON.parse(readFileSync(new URL('../assets/t10/pavilion-layout.json', import.meta.url)));
const world = buildNavWorld(layout.exhibitSlots);
const cam = pavilionCamera(world);
const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

function cameraAt(w, blockers, feet, yaw, pitch) {
  const pivot = [feet.x, feet.y + FOLLOW.pivot, feet.z], d = viewDirection(yaw, pitch), back = d.map(v => -v);
  const boom = boomLength(w, pivot, back, FOLLOW.distance, blockers);
  return { boom, pivot, at: pivot.map((v, i) => v + back[i] * boom) };
}
/** Camera point is outside every (unpadded) blocker it must respect and above the floor. */
function assertClear(w, blockers, at, label) {
  for (const c of [...w.colliders, ...blockers]) {
    if (w.passThrough?.has(c.id)) continue;
    const inside = c.kind === 'circle'
      ? Math.hypot(at[0] - c.x, at[2] - c.z) < c.r && at[1] > c.y0 && at[1] < c.y1
      : at[0] > c.x0 && at[0] < c.x1 && at[1] > c.y0 && at[1] < c.y1 && at[2] > c.z0 && at[2] < c.z1;
    assert.ok(!inside, `${label}: camera ${at.map(v => v.toFixed(2))} inside ${c.id}`);
  }
  assert.ok(at[1] >= w.floorY + FOLLOW.floorClearance - 1e-6, `${label}: camera below the floor`);
}

test('view direction matches a YXZ (pitch, yaw) camera', () => {
  assert.ok(close(viewDirection(0, 0), [0, 0, -1]));
  assert.ok(close(viewDirection(-Math.PI / 2, 0), [1, 0, 0]));
  const [, y] = viewDirection(0, 0.5);
  assert.ok(y > 0, 'positive pitch looks up');
  assert.equal(clampFollowPitch(5), FOLLOW.pitch.max);
  assert.equal(clampFollowPitch(-5), FOLLOW.pitch.min);
});

test('pavilion entry: the camera stays inside the doorway (a wall beam crosses it at 1 m)', () => {
  const { boom, at } = cameraAt(cam.world, cam.blockers, world.entry, 0, 0.05);
  assert.ok(at[2] < 13.88 - 0.1, `camera z ${at[2]}`);
  assert.ok(boom > FOLLOW.hideBelow, `avatar still visible at the entry (boom ${boom})`);
});

test('walls, columns and slab undersides shorten the boom', () => {
  // Facing east at the west wall: the camera is pressed against the wall, not through it.
  const wall = cameraAt(cam.world, cam.blockers, { x: -11, y: 0, z: 0 }, -Math.PI / 2, 0);
  assert.ok(wall.boom < 0.9 && wall.at[0] > -11.89, `wall boom ${wall.boom}`);
  // Directly in front of a column, looking away from it.
  const [cx, cz] = [-6.4, 1.5];
  const column = cameraAt(cam.world, cam.blockers, { x: cx, y: 0, z: cz - 1.2 }, 0, 0);
  assert.ok(column.boom < 1.2 - 0.45 && column.boom > 0.4, `column boom ${column.boom}`);
  // Under the upper west slab, looking steeply down: the camera stays below the slab underside.
  const under = cameraAt(cam.world, cam.blockers, { x: -9, y: 0, z: 0 }, Math.PI / 2, FOLLOW.pitch.min);
  assert.ok(under.at[1] < 4.5 - 0.1, `camera y ${under.at[1]}`);
  // Looking up pulls the camera toward the floor; it never goes through.
  const up = cameraAt(cam.world, cam.blockers, { x: -9, y: 0, z: 0 }, Math.PI / 2, FOLLOW.pitch.max);
  assert.ok(up.at[1] >= FOLLOW.floorClearance - 1e-6 && up.boom < FOLLOW.distance);
  // Upper floor below the roof ties.
  const roof = cameraAt(cam.world, cam.blockers, { x: 9, y: 4.8, z: 0 }, 0, FOLLOW.pitch.min);
  assert.ok(roof.at[1] < 8.65, `camera y ${roof.at[1]}`);
});

test('fuzz: reachable positions, any view — camera never inside a blocker or under the floor', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let p = { ...world.entry }, checked = 0;
  for (let i = 0; i < 4000; i++) {
    p = step(world, p, { forward: 1, right: rnd() - 0.5, run: rnd() > 0.5 }, rnd() * Math.PI * 2, 0.2);
    const yaw = rnd() * Math.PI * 2, pitch = FOLLOW.pitch.min + rnd() * (FOLLOW.pitch.max - FOLLOW.pitch.min);
    const { at } = cameraAt(cam.world, cam.blockers, p, yaw, pitch);
    assertClear(cam.world, cam.blockers, at, `step ${i}`);
    checked++;
  }
  assert.equal(checked, 4000);
});

test('room: roof, friezes and placements keep the camera out of the house shell', () => {
  const bounds = new Map([['chest', { min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] }]]);
  const rw = buildRoomWorld([{ id: 'p1', assetId: 'chest', position: [0, 0.025, -1.6], rotation: [0, 0, 0], scale: 1 }], bounds);
  const w = { colliders: rw.colliders, surfaces: rw.surfaces, floorY: -0.4 };
  const inside = cameraAt(w, ROOM_CAMERA_BLOCKERS, { x: 0, y: 0.025, z: 0 }, Math.PI, FOLLOW.pitch.min);
  assert.ok(inside.at[1] < 4.8 - 0.3, `camera y ${inside.at[1]} under the roof`);
  const behindChest = cameraAt(w, ROOM_CAMERA_BLOCKERS, { x: 0, y: 0.025, z: -0.5 }, Math.PI, 0);
  assert.ok(behindChest.at[2] > -1.1 + 0.05 - FOLLOW.pad, `chest stops the camera: ${behindChest.at[2]}`);
  const entry = cameraAt(w, ROOM_CAMERA_BLOCKERS, rw.entry, 0, 0);
  assert.equal(entry.boom, FOLLOW.distance, 'porch start sees the house at full distance');
  for (let a = 0; a < 64; a++) {
    for (const pitch of [FOLLOW.pitch.min, 0, FOLLOW.pitch.max]) {
      for (const feet of [rw.entry, { x: 3, y: 0.025, z: 2 }, { x: -5.5, y: 0.025, z: -4 }, { x: 8, y: -0.4, z: 7 }]) {
        assertClear(w, ROOM_CAMERA_BLOCKERS, cameraAt(w, ROOM_CAMERA_BLOCKERS, feet, a / 64 * Math.PI * 2, pitch).at, 'room');
      }
    }
  }
});

test('boom easing pulls in at once and eases back out; facing turns the short way', () => {
  assert.equal(easeBoom(3, 1, 1 / 60), 1);
  const out = easeBoom(1, 3, 1 / 60);
  assert.ok(out > 1 && out < 1.2);
  assert.ok(Math.abs(turnToward(3.0, -3.0, 100, 1) - (2 * Math.PI - 3.0)) < 1e-9, 'crosses ±π instead of spinning around');
  assert.ok(Math.abs(turnToward(0, 1, 2, 0.1) - 0.2) < 1e-9, 'rate-limited');
  assert.ok(supportAt(world, 0, 0, 0) === 0 && BODY.radius === 0.3);
});

test('avatar preferences: defaults, damaged values and unavailable storage', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{bad json'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs(JSON.stringify({ character: 'nobody', view: 'top' })), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs(JSON.stringify({ character: 'shin-chan', view: 'first' })), { character: 'shin-chan', view: 'first' });
  assert.deepEqual(parsePrefs(JSON.stringify({ view: 'first' })), { ...DEFAULT_PREFS, view: 'first' });
  const map = new Map(), store = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  savePrefs({ character: 'bull-tpose', view: 'first' }, store);
  assert.deepEqual(JSON.parse(map.get(PREFS_KEY)), { character: 'bull-tpose', view: 'first' });
  assert.deepEqual(loadPrefs(store), { character: 'bull-tpose', view: 'first' });
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadPrefs(broken), DEFAULT_PREFS);
  assert.doesNotThrow(() => savePrefs(DEFAULT_PREFS, broken));
  assert.equal(new Set(CHARACTERS.map(c => c.id)).size, 6);
});

test('runtime character GLBs: six skinned models with Idle and Run, JPEG textures, small', () => {
  const manifest = JSON.parse(readFileSync(new URL('../assets/characters/runtime/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.items.map(i => i.id).sort(), CHARACTERS.map(c => c.id).sort());
  for (const item of manifest.items) {
    const glb = readFileSync(new URL(`../assets/characters/runtime/${item.file}`, import.meta.url));
    assert.equal(glb.readUInt32LE(0), 0x46546c67);
    assert.equal(glb.readUInt32LE(8), glb.length);
    assert.equal(glb.length, item.byteSize);
    assert.ok(glb.length < 4e6, `${item.id} is ${glb.length} bytes`);
    const len = glb.readUInt32LE(12), json = JSON.parse(glb.subarray(20, 20 + len).toString());
    assert.deepEqual(json.animations.map(a => a.name).sort(), ['Idle', 'Run']);
    assert.equal(json.skins.length, 1);
    assert.ok(json.images.every(img => img.mimeType === 'image/jpeg'));
    const bin = glb.readUInt32LE(20 + len);
    for (const v of json.bufferViews) assert.ok((v.byteOffset ?? 0) + v.byteLength <= bin, `${item.id} bufferView out of range`);
  }
});

test('character picker thumbnails: one small WebP per character', () => {
  for (const c of CHARACTERS) {
    const webp = readFileSync(new URL(`../assets/characters/runtime/thumbs/${c.id}.webp`, import.meta.url));
    assert.equal(webp.subarray(0, 4).toString(), 'RIFF', c.id);
    assert.equal(webp.subarray(8, 12).toString(), 'WEBP', c.id);
    assert.ok(webp.length < 40e3, `${c.id} thumbnail is ${webp.length} bytes`);
  }
});

test('Shift quick walk: the room uses the same run speed as the pavilion', () => {
  const room = buildRoomWorld([], new Map()), dt = 1 / 60;
  const walkFor = (w, run) => { let p = w === room ? roomEntrance(room) : { ...w.entry, velocityY: null }; const z0 = p.z; for (let i = 0; i < 30; i++) p = stepFirstPerson(w, p, { forward: 1, right: 0, run }, 0, dt, false); return (z0 - p.z) / (30 * dt); };
  const roomWalk = walkFor(room, false), roomRun = walkFor(room, true), hallRun = walkFor(world, true);
  assert.ok(Math.abs(roomWalk - room.walkSpeed) < 0.05, `room walk ${roomWalk}`);
  assert.ok(Math.abs(roomRun - BODY.run) < 0.05, `room run ${roomRun}`);
  assert.ok(Math.abs(roomRun - hallRun) < 0.05, `room ${roomRun} vs pavilion ${hallRun}`);
});

test('lantern caps: a camera rising under a hanging lantern stops below its bottom frame', () => {
  // Pivot beside the ground-floor lantern at (7.1, 3.3, -7), looking down steeply so the boom rises under it.
  const { at, boom } = cameraAt(cam.world, cam.blockers, { x: 7.01, y: 0, z: -6.48 }, Math.PI, FOLLOW.pitch.min);
  assert.ok(at[1] < 3.01 - 0.08, `camera y ${at[1]} (boom ${boom})`);
});
