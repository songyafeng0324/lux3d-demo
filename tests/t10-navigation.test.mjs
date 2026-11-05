// T10-C navigation contract: real up/down route, rails, openings, low FPS and fuzzing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNavWorld, step, supportAt, floorOf, targetSlot, BODY, COLUMNS, UPPER_Y } from '../apps/web/src/game/navigation.ts';

const layout = JSON.parse(readFileSync(new URL('../assets/t10/pavilion-layout.json', import.meta.url)));
const draft = JSON.parse(readFileSync(new URL('../docs/design/t10-a/layout-draft.json', import.meta.url)));
const world = buildNavWorld(layout.exhibitSlots);
const still = { forward: 0, right: 0, run: false };
const fwd = { forward: 1, right: 0, run: false };
const yawTo = (p, x, z) => Math.atan2(-(x - p.x), -(z - p.z));

function hold(p, input, yaw, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) p = step(world, p, input, yaw, dt);
  return p;
}
function walkTo(p, [x, , z], dt = 1 / 60) {
  for (let i = 0; i < 4000; i++) {
    if (Math.hypot(p.x - x, p.z - z) < 0.06) return p;
    const n = step(world, p, fwd, yawTo(p, x, z), Math.min(dt, Math.hypot(p.x - x, p.z - z) / BODY.walk));
    if (n === p) assert.fail(`stuck at ${JSON.stringify(p)} heading to ${x},${z}`);
    p = n;
  }
  assert.fail(`did not reach ${x},${z} from ${JSON.stringify(p)}`);
}
const ROUTE = [
  [0, 0, 9], [8, 0, 9], [8, 0, -5.9], [1.5, 0, -5.9], [1.5, 0, -6.7], [1.5, 2.4, -11.5], [1.5, 2.4, -12.25],
  [-1.5, 2.4, -12.25], [-1.5, 2.4, -11.5], [-1.5, 4.8, -6.7], [-1.5, 4.8, -5.9], [-8, 4.8, -5.9], [-8, 4.8, 10],
  [8, 4.8, 10], [8, 4.8, -5.9], [-1.5, 4.8, -5.9], [-1.5, 4.8, -6.7], [-1.5, 2.4, -11.5], [-1.5, 2.4, -12.25],
  [1.5, 2.4, -12.25], [1.5, 2.4, -11.5], [1.5, 0, -6.7], [1.5, 0, -5.9], [8, 0, -5.9], [8, 0, 9], [0, 0, 9], [0, 0, 12.2],
];

test('nav constants agree with the exported layout and design draft', () => {
  assert.equal(layout.upperFloorY, UPPER_Y);
  assert.deepEqual(COLUMNS, draft.columns);
  assert.equal(world.slots.length, 30);
  assert.deepEqual(layout.atriumOpening, { x: [-6, 6], z: [-4.5, 7.5] });
  assert.deepEqual(layout.stairOpening, { x: [-2.7, 2.7], z: [-13, -6.7] });
  assert.deepEqual(layout.stairPath, ROUTE.slice(4, 10).map(([x, y, z]) => [x, y, z]));
});

test('walks entry → stairs → full upper ring → back down to the entry', () => {
  let p = { ...world.entry }, maxY = 0;
  for (const wp of ROUTE) {
    p = walkTo(p, wp);
    assert.ok(Math.abs(p.y - wp[1]) < 0.05, `height at ${wp} was ${p.y}`);
    maxY = Math.max(maxY, p.y);
  }
  assert.equal(maxY, UPPER_Y);
  assert.ok(Math.hypot(p.x, p.z - 12.2) < 0.1 && p.y === 0);
});

test('same route works at 4 FPS (dt=0.25s) without tunnelling', () => {
  let p = { ...world.entry };
  for (const wp of ROUTE) { p = walkTo(p, wp, 0.25); assert.ok(Math.abs(p.y - wp[1]) < 0.05); }
});

const cases = [
  ['upper floor → into atrium south guard', { x: 0, y: 4.8, z: 10 }, 0, p => p.z >= 7.5 + 0.1 + BODY.radius - 1e-6 && p.y === 4.8],
  ['north crossing → into atrium', { x: 0, y: 4.8, z: -5.6 }, Math.PI, p => p.z <= -4.5 - 0.1 - BODY.radius + 1e-6 && p.y === 4.8],
  ['north crossing → into stair well (east of exit)', { x: 1.5, y: 4.8, z: -5.6 }, 0, p => p.z >= -6.6 + BODY.radius - 1e-6 && p.y === 4.8],
  ['upper east of well → west into well', { x: 4, y: 4.8, z: -10 }, Math.PI / 2, p => p.x >= 2.8 + BODY.radius - 1e-6 && p.y === 4.8],
  ['upper west side → diagonal into atrium guard slides', { x: -8, y: 4.8, z: 0 }, -Math.PI / 4, p => p.x <= -6.1 - BODY.radius + 1e-6 && p.y === 4.8],
  ['landing → north into landing rail', { x: 0, y: 2.4, z: -12.2 }, 0, p => p.z >= -12.86 + BODY.radius - 1e-6 && p.y === 2.4],
  ['landing → south into gap between flights', { x: 0, y: 2.4, z: -12.2 }, Math.PI, p => p.y === 2.4 && p.z <= -11.5 + 1e-6],
  ['ground NW → east under the landing', { x: -4, y: 0, z: -13.5 }, -Math.PI / 2, p => p.x <= -2.82 - BODY.radius + 1e-6 && p.y === 0],
  ['ground NE → west under the landing', { x: 4, y: 0, z: -13.5 }, Math.PI / 2, p => p.x >= 2.82 + BODY.radius - 1e-6 && p.y === 0],
  ['ground → south closure under west flight', { x: -1.5, y: 0, z: -5.6 }, 0, p => p.z >= -6.66 + BODY.radius - 1e-6 && p.y === 0],
  ['ground → walk out of the entrance', { x: 0, y: 0, z: 12.2 }, Math.PI, p => p.z <= 13.88 - BODY.radius + 1e-6 && p.y === 0],
  ['ground → walk into a column', { x: 6.4, y: 0, z: 4 }, 0, p => Math.hypot(p.x - 6.4, p.z - 1.5) >= 0.75 - 1e-3],
  ['upper → walk into a plinth', { x: 7.5, y: 4.8, z: 10 }, -Math.PI / 2, p => p.x <= 9.6 - 0.62 - BODY.radius + 1e-6],
];
for (const dt of [1 / 60, 0.25]) for (const [name, start, yaw, ok] of cases) {
  test(`blocked: ${name} @dt=${dt}`, () => {
    const p = hold({ ...start }, { forward: 1, right: 0, run: true }, yaw, 6, dt);
    assert.ok(ok(p), JSON.stringify(p));
  });
}

test('strafing on the east flight stays between its rails and on the ramp', () => {
  let p = walkTo({ ...world.entry }, [1.5, 0, -5.9]);
  p = walkTo(p, [1.5, 0, -9]);
  for (const right of [1, -1]) {
    const q = hold(p, { forward: 0, right, run: true }, 0, 3);
    assert.ok(q.x > 0.36 + 0.08 + BODY.radius - 1e-6 && q.x < 2.64 - 0.08 - BODY.radius + 1e-6, JSON.stringify(q));
    assert.ok(Math.abs(q.y - (-6.7 - q.z) * 0.5) < 1e-6);
  }
});

test('fuzz: random input never leaves a valid surface, overlaps a wall or drops a floor', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const starts = [world.entry, { x: -8, y: 4.8, z: 0 }, { x: 0, y: 2.4, z: -12.2 }, { x: 8, y: 4.8, z: -10 }];
  for (let run = 0; run < 240; run++) {
    let p = { ...starts[run % starts.length] }, yaw = rnd() * 6.3;
    for (let i = 0; i < 600; i++) {
      if (rnd() < 0.05) yaw = rnd() * 6.3;
      const input = { forward: Math.round(rnd() * 2 - 0.6), right: Math.round(rnd() * 2 - 1), run: rnd() < 0.3 };
      const dt = 0.005 + rnd() * 0.245, n = step(world, p, input, yaw, dt);
      // stairs descend 0.5 m per metre walked; anything beyond that is a fall
      assert.ok(p.y - n.y <= 0.5 * BODY.run * dt + 1e-9, `dropped ${JSON.stringify([p, n])}`);
      const s = supportAt(world, n.x, n.z, n.y);
      assert.ok(s !== null && Math.abs(s - n.y) < 1e-9, `off-surface ${JSON.stringify(n)}`);
      if (n.y > 4.6) {
        assert.ok(!(n.x > -6 && n.x < 6 && n.z > -4.5 && n.z < 7.5), `in atrium ${JSON.stringify(n)}`);
        if (n.x > -2.7 && n.x < 2.7 && n.z > -13 && n.z < -6.7) assert.ok(n.x < -0.3, `in well ${JSON.stringify(n)}`);
      }
      if (n.y < 0.2) assert.ok(!(Math.abs(n.x) < 2.7 && n.z < -6.7 && !(n.x > 0.3)), `under stair ${JSON.stringify(n)}`);
      p = n;
    }
  }
});

test('E target: facing a plinth within 3 m, nothing when looking away or too far', () => {
  const s = layout.exhibitSlots.find(v => v.id === 'T19');
  const eye = [s.position[0] + 2, 4.8 + BODY.eye, s.position[2]];
  const d = [-2, 1 - BODY.eye, 0], l = Math.hypot(...d);
  assert.equal(targetSlot(world, eye, d.map(v => v / l))?.id, 'T19');
  assert.equal(targetSlot(world, eye, [1, 0, 0]), null);
  assert.equal(targetSlot(world, [eye[0] + 3, eye[1], eye[2]], d.map(v => v / l)), null);
  assert.equal(floorOf(0), 'ground'); assert.equal(floorOf(2.4), 'stairs'); assert.equal(floorOf(4.8), 'upper');
  assert.deepEqual(step(world, world.entry, still, 0, 1), world.entry);
});
