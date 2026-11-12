// T16 navigation contract on the exported graybox layout: real up/down route over stepped stairs,
// rails, openings, low FPS, fuzzing, E targets, tiers and jumps. Geometry comes from
// assets/t16/pavilion-layout.json, written by scripts/blender/build_t16.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNavWorld, step, stepFirstPerson, supportAt, floorOf, targetSlot, playerOverlaps, exhibitCollider, freePlayer, EXHIBIT_COLLIDER, BODY, UPPER_Y } from '../apps/web/src/game/navigation.ts';

const layout = JSON.parse(readFileSync(new URL('../assets/t16/pavilion-layout.json', import.meta.url)));
const world = buildNavWorld(layout);
const still = { forward: 0, right: 0, run: false };
const fwd = { forward: 1, right: 0, run: false };
const yawTo = (p, x, z) => Math.atan2(-(x - p.x), -(z - p.z));
const ZSTAIR = -15, ZLAND = -22.68, YLAND = 4.5;

function hold(p, input, yaw, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) p = step(world, p, input, yaw, dt);
  return p;
}
function walkTo(p, [x, , z], dt = 1 / 60) {
  for (let i = 0; i < 6000; i++) {
    if (Math.hypot(p.x - x, p.z - z) < 0.06) return p;
    const n = step(world, p, fwd, yawTo(p, x, z), Math.min(dt, Math.hypot(p.x - x, p.z - z) / BODY.walk));
    if (n === p) assert.fail(`stuck at ${JSON.stringify(p)} heading to ${x},${z}`);
    p = n;
  }
  assert.fail(`did not reach ${x},${z} from ${JSON.stringify(p)}`);
}
// Entry → carpet → around the Treasure dais → central flight → landing → east flight → upper east hall → south gallery →
// west hall → bridge → west flight down → landing → central flight down → back to the door.
export const ROUTE = [
  [0, 0, 18], [-5, 0, 9], [-5, 0, -5], [0, 0, -13], [0, 0, ZSTAIR + 0.1], [0, YLAND, ZLAND - 0.6], [9.1, YLAND, ZLAND - 0.6], [9.1, YLAND, ZLAND + 0.1],
  [9.1, UPPER_Y, ZSTAIR + 0.6], [14, UPPER_Y, -13.5], [14, UPPER_Y, 20], [-14, UPPER_Y, 20], [-14, UPPER_Y, -13.5],
  [-9.1, UPPER_Y, -13.5], [-9.1, UPPER_Y, ZSTAIR + 0.6], [-9.1, YLAND, ZLAND + 0.1], [-9.1, YLAND, ZLAND - 0.6],
  [0, YLAND, ZLAND - 0.6], [0, YLAND, ZLAND - 0.1], [0, 0, ZSTAIR + 0.1], [5, 0, -5], [5, 0, 9], [0, 0, 24],
];

test('layout agrees with the walking constants and the 30-slot contract', () => {
  assert.equal(layout.upperY, UPPER_Y);
  assert.equal(layout.source, 'scripts/blender/build_t16.py');
  assert.deepEqual(layout.stats.overlaps, [], 'render parts must not interpenetrate');
  assert.deepEqual(layout.stats.reachGaps, [], 'every part a visitor can touch is solid to the walker');
  assert.equal(world.slots.length, 30);
  assert.deepEqual(world.slots.map(s => s.id), Array.from({ length: 30 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
  const tiers = world.slots.reduce((m, s) => ({ ...m, [s.tier]: (m[s.tier] ?? 0) + 1 }), {});
  assert.deepEqual(tiers, { S: 1, A: 9, B: 20 });
  // T01 Treasure dais, T02 north landing, T03–T10 the eight atrium column bays (west then east, north → south).
  assert.equal(world.slots[0].tier, 'S'); assert.deepEqual(world.slots[1].position, [0, YLAND, -28]);
  const bays = [-8.5, -1.5, 5.5, 12.5];
  assert.deepEqual(world.slots.slice(2, 10).map(s => [s.position[0], s.position[2]]), [...bays.map(z => [-11, z]), ...bays.map(z => [11, z])]);
  for (const s of world.slots) {
    const top = { S: 1.35, A: s.position[1] + 0.95, B: s.position[1] + 1.05 }[s.tier];
    assert.equal(s.fit.restY, top, `${s.id} rests at its tier height`);
    assert.equal(s.fit.maxSize, { S: 5, A: 2.5, B: 1.6 }[s.tier]);
    assert.ok(s.label && Number.isFinite(s.yaw));
  }
  // Treads rise 0.18 m: well inside the 0.3 m step-up, so the feet follow each tread exactly.
  const treads = world.surfaces.filter(s => s.id.includes('tread')).map(s => s.y).sort((a, b) => a - b);
  assert.equal(treads.length, 72);
  const ids = [...world.colliders, ...world.airColliders, ...world.cameraBlockers].map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'collider ids are unique');
});

test('walks entry → central flight → landing → side flight → whole upper floor → back down to the door', () => {
  let p = { ...world.entry }, maxY = 0;
  for (const wp of ROUTE) {
    p = walkTo(p, wp);
    assert.ok(Math.abs(p.y - wp[1]) < 0.2, `height at ${wp} was ${p.y}`);
    maxY = Math.max(maxY, p.y);
  }
  assert.equal(maxY, UPPER_Y);
  assert.ok(Math.hypot(p.x, p.z - 24) < 0.1 && p.y === 0);
});

test('same route works at 4 FPS (dt=0.25s) without tunnelling', () => {
  let p = { ...world.entry };
  for (const wp of ROUTE) { p = walkTo(p, wp, 0.25); assert.ok(Math.abs(p.y - wp[1]) < 0.2); }
});

test('stairs: feet stand exactly on each tread (no sinking into the steps)', () => {
  let p = { ...world.entry };
  for (const wp of ROUTE.slice(0, 5)) p = walkTo(p, wp); // around the dais to the foot of the flight
  for (let i = 0; i < 400 && p.y < YLAND; i++) {
    p = step(world, p, fwd, 0, 1 / 60);
    const tread = world.surfaces.find(s => s.id.includes('tread') && p.x >= s.x0 && p.x <= s.x1 && p.z >= s.z0 && p.z <= s.z1);
    if (tread) assert.ok(p.y === tread.y || p.y === tread.y - 0.18 || p.y === tread.y + 0.18, `y ${p.y} on tread ${tread.y}`);
  }
  assert.equal(p.y, YLAND);
});

const cases = [
  ['ground → walk out over the terrace rail', { x: 0, y: 0, z: 34 }, Math.PI, p => p.z <= 35.8 - BODY.radius + 1e-6 && p.y === 0],
  ['ground → walk into the west wall', { x: -18, y: 0, z: 0 }, Math.PI / 2, p => p.x >= -22 + BODY.radius - 1e-6],
  ['ground → walk into an atrium column base', { x: 8, y: 0, z: 2 }, -Math.PI / 2, p => Math.hypot(p.x - 11, p.z - 2) >= 1.2 + BODY.radius - 1e-3],
  ['ground → walk into a column-bay lotus pedestal', { x: -7, y: 0, z: -1.5 }, Math.PI / 2, p => Math.hypot(p.x + 11, p.z + 1.5) >= 1.2 + BODY.radius - 1e-3],
  ['ground → walk into the Treasure dais', { x: 0, y: 0, z: 10 }, 0, p => p.y === 0 && Math.hypot(p.x, p.z - 2) >= 3.2 + BODY.radius - 1e-3],
  ['ground → walk into an entrance-hall column', { x: 11, y: 0, z: 25.5 }, 0, p => Math.hypot(p.x - 11, p.z - 22) >= 1.2 + BODY.radius - 1e-3],
  ['ground → into an alcove plinth', { x: -18, y: 0, z: 5 }, Math.PI / 2, p => p.x >= -20.4 + BODY.radius - 1e-6],
  ['ground → north under the side flights into the landing podium', { x: 5, y: 0, z: -13 }, 0, p => p.y === 0 && Math.abs(p.z - (ZLAND + BODY.radius)) < 1e-6],
  ['ground → north into the side-flight pier', { x: 9.1, y: 0, z: -15.5 }, 0, p => p.y === 0 && p.z >= -18.84 + BODY.radius - 1e-6],
  ['floor beside the central flight → west under its rail', { x: 4, y: 0, z: -19 }, Math.PI / 2, p => p.y === 0 && p.x >= 2.8 + BODY.radius - 1e-6],
  ['central flight → step sideways into its rail', { x: 0, y: 2.34, z: -19 }, -Math.PI / 2, p => p.x <= 2.6 - BODY.radius + 1e-6 && p.y === 2.34],
  ['landing → walk off its south edge (rail)', { x: 5, y: YLAND, z: -24 }, Math.PI, p => p.y === YLAND && p.z <= ZLAND - 0.2 - BODY.radius + 1e-6],
  ['landing → walk off its east edge (rail)', { x: 9, y: YLAND, z: -27 }, -Math.PI / 2, p => p.y === YLAND && p.x <= 10.8 - BODY.radius + 1e-6],
  ['landing → into the moon gate', { x: 3, y: YLAND, z: -25 }, 0, p => Math.abs(p.z - (-31.4 + BODY.radius)) < 1e-6],
  ['upper → into the atrium rail', { x: 0, y: UPPER_Y, z: 20 }, 0, p => p.z >= 16.2 + BODY.radius - 1e-6 && p.y === UPPER_Y],
  ['upper → off the bridge toward the central flight', { x: 0, y: UPPER_Y, z: -13.5 }, 0, p => p.z >= -14.8 + BODY.radius - 1e-6 && p.y === UPPER_Y],
  ['upper east hall → into the stair hall', { x: 14, y: UPPER_Y, z: -25 }, Math.PI / 2, p => p.x >= 11.2 + BODY.radius - 1e-6 && p.y === UPPER_Y],
];
for (const dt of [1 / 60, 0.25]) for (const [name, start, yaw, ok] of cases) {
  test(`blocked: ${name} @dt=${dt}`, () => {
    const p = hold({ ...start }, { forward: 1, right: 0, run: true }, yaw, 6, dt);
    assert.ok(ok(p), JSON.stringify(p));
  });
}

test('fuzz: random input never leaves a valid surface, overlaps a collider or drops a floor', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const starts = [world.entry, { x: -16, y: UPPER_Y, z: 0 }, { x: 0, y: YLAND, z: -24.5 }, { x: 9.1, y: 6.66, z: -19 }, { x: -5, y: 0, z: 2 }, { x: 5, y: 0, z: -19 }];
  for (let run = 0; run < 250; run++) {
    let p = { ...starts[run % starts.length] }, yaw = rnd() * 6.3;
    for (let i = 0; i < 600; i++) {
      if (rnd() < 0.05) yaw = rnd() * 6.3;
      const input = { forward: Math.round(rnd() * 2 - 0.6), right: Math.round(rnd() * 2 - 1), run: rnd() < 0.3 };
      const dt = 0.005 + rnd() * 0.245, n = step(world, p, input, yaw, dt);
      // the steepest descent is one 0.18 m tread per substep; anything more is a fall
      assert.ok(p.y - n.y <= Math.ceil(BODY.run * dt / BODY.substep) * 0.18 + 1e-9, `dropped ${JSON.stringify([p, n])}`);
      const s = supportAt(world, n.x, n.z, n.y);
      assert.ok(s !== null && Math.abs(s - n.y) < 1e-9, `off-surface ${JSON.stringify(n)}`);
      assert.ok(!playerOverlaps(world.colliders.filter(c => c.y1 > n.y + BODY.stepUp), n), `inside a collider ${JSON.stringify(n)}`);
      if (n.y > UPPER_Y - 0.2) assert.ok(!(n.x > -11 && n.x < 11 && n.z > -12 && n.z < 16), `in atrium ${JSON.stringify(n)}`);
      // never on the floor inside a solid stair mass (central flight or landing podium)
      if (n.y < 0.1) assert.ok(!(Math.abs(n.x) < 2.8 && n.z < -15 - 0.32 || Math.abs(n.x) < 11 && n.z < -22.68), `inside the stair mass ${JSON.stringify(n)}`);
      p = n;
    }
  }
});

test('E targets: a lotus within 3 m, the Treasure dais from the carpet, nothing when looking away', () => {
  const s = world.slots.find(v => v.id === 'T03');
  const eye = [s.position[0] + 2.6, 1.75, s.position[2]];
  const d = [-2.6, 0.9 - 1.75, 0], l = Math.hypot(...d);
  assert.equal(targetSlot(world, eye, d.map(v => v / l))?.id, 'T03');
  assert.equal(targetSlot(world, eye, [0, 0.6, 0.8]), null);
  assert.equal(targetSlot(world, [0, 1.75, 8], [0, -0.05, -1])?.id, 'T01');
  const alcove = world.slots.find(v => v.id === 'T23'); // upper west hall
  const ae = [alcove.position[0] + 2.2, UPPER_Y + 1.75, alcove.position[2]], ad = [-2.2, 1 - 1.75, 0], al = Math.hypot(...ad);
  assert.equal(targetSlot(world, ae, ad.map(v => v / al))?.id, 'T23');
  assert.equal(floorOf(0), 'ground'); assert.equal(floorOf(YLAND), 'stairs'); assert.equal(floorOf(UPPER_Y), 'upper');
  assert.deepEqual(step(world, world.entry, still, 0, 1), world.entry);
});

test('one jump clears the atrium rail, lands on the ground floor and cannot tunnel at 4 FPS', () => {
  for (const dt of [1 / 60, .25]) {
    let player = { x: 0, y: UPPER_Y, z: 16.6, velocityY: null }, peak = player.y;
    for (let t = 0; t < 3; t += dt) {
      player = stepFirstPerson(world, player, fwd, 0, dt, t === 0);
      peak = Math.max(peak, player.y);
    }
    assert.ok(peak > UPPER_Y + 1.25);
    assert.ok(player.z < 16 && player.y === 0 && player.velocityY === null, JSON.stringify(player));
  }
});

test('jumping under a side flight stops the head at the treads and lands back on the floor', () => {
  const under = { x: 9.1, z: -21.5, y: 0, velocityY: null }; // tread 4 underside ≈ 4.62
  let player = stepFirstPerson(world, under, still, 0, .25, true);
  for (let t = 0; t < 2; t += .25) player = stepFirstPerson(world, player, still, 0, .25, false);
  assert.equal(player.y, 0);
  assert.equal(player.velocityY, null);
});

// 2026-11-10 user report: holding W and jumping up the central flight sometimes dropped the player inside
// the stair mass (the riser in front was not solid in the air). Every frame the feet must stay on or above
// the stepped surface under them, and the climb must still reach the landing.
const centralTop = (x, z) => (Math.abs(x) <= 2.8 && z <= ZSTAIR && z >= ZLAND)
  ? Math.min(24, Math.ceil((ZSTAIR - z) / 0.32 - 1e-9)) * 0.18 : null;
for (const dt of [1 / 60, 1 / 30, .25]) for (const run of [false, true]) for (const hop of ['once', 'every landing']) {
  test(`jumping up the central flight never sinks into the steps (dt=${dt.toFixed(3)}, ${run ? 'run' : 'walk'}, jump ${hop})`, () => {
    let p = { x: 0.4, y: 0, z: -13, velocityY: null }, first = true;
    for (let t = 0; t < 6 && p.z > ZLAND - 0.5; t += dt) {
      const jump = first || (hop === 'every landing' && p.velocityY === null);
      first = false;
      p = stepFirstPerson(world, p, { forward: 1, right: 0, run }, 0, dt, jump);
      const top = centralTop(p.x, p.z);
      if (top !== null) assert.ok(p.y >= top - 1e-6, `feet ${p.y.toFixed(3)} below the step top ${top.toFixed(2)} at z=${p.z.toFixed(2)}`);
    }
    for (let t = 0; t < 2 && p.velocityY !== null; t += dt) p = stepFirstPerson(world, p, still, 0, dt, false);   // let the last hop land
    assert.ok(Math.abs(p.y - YLAND) < 1e-6 && p.z < ZLAND && p.velocityY === null, `ended at ${JSON.stringify(p)}`);
  });
}

test('the export reach audit uses the same body as the walker', () => {
  const kit = readFileSync(new URL('../scripts/blender/t16_kit.py', import.meta.url), 'utf8');
  const m = kit.match(/BODY_R, BODY_H, STEP_UP, JUMP_REACH = ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)/);
  assert.ok(m, 'reach constants not found in t16_kit.py');
  const peak = BODY.jump ** 2 / (2 * BODY.gravity);
  assert.deepEqual(m.slice(1, 4).map(Number), [BODY.radius, BODY.height, BODY.stepUp]);
  assert.ok(Number(m[4]) >= peak - 1e-9, `jump reach ${m[4]} must cover the jump peak ${peak.toFixed(3)}`);
});

test('baked lightmaps belong to the current GLB and every map file exists', async () => {
  const { createHash } = await import('node:crypto');
  const { existsSync } = await import('node:fs');
  const dir = new URL('../assets/t16/lightmaps/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('../assets/t16/pavilion-lightmaps.json', import.meta.url)));
  const glb = readFileSync(new URL('../assets/t16/pavilion-t16.glb', import.meta.url));
  assert.equal(manifest.glbSHA256, createHash('sha256').update(glb).digest('hex'), 'GLB changed since the bake: rerun scripts/blender/bake_t16.py');
  assert.ok(Object.keys(manifest.maps).length >= 10);
  for (const m of Object.values(manifest.maps)) for (const f of [m.ao, m.gi]) assert.ok(existsSync(new URL(f, dir)), f);
});

test('the runtime pavilion (scripts/compress-t16.mjs) was built from the current GLB and lightmaps', async () => {
  const { createHash } = await import('node:crypto');
  const sha = b => createHash('sha256').update(b).digest('hex');
  const read = p => readFileSync(new URL(`../assets/t16/${p}`, import.meta.url));
  const rt = JSON.parse(read('runtime/manifest.json'));
  const stale = 'runtime copy is stale: rerun node scripts/compress-t16.mjs';
  assert.equal(rt.inputs.glbSHA256, sha(read('pavilion-t16.glb')), stale);
  assert.equal(rt.inputs.lightmapManifestSHA256, sha(read('pavilion-lightmaps.json')), stale);
  assert.equal(rt.inputs.scriptSHA256, sha(readFileSync(new URL('../scripts/compress-t16.mjs', import.meta.url))), stale);
  assert.equal(rt.glb.sha256, sha(read(`runtime/${rt.glb.file}`)), 'runtime GLB edited by hand');
  const baked = JSON.parse(read('pavilion-lightmaps.json'));
  for (const m of Object.values(baked.maps)) for (const f of [m.ao, m.gi]) {
    const entry = rt.lightmaps[f];
    assert.ok(entry, `no runtime copy of ${f}`);
    assert.equal(entry.sourceSHA256, sha(read(`lightmaps/${f}`)), `${f}: ${stale}`);
    assert.equal(entry.sha256, sha(read(`runtime/lightmaps/${entry.file}`)), entry.file);
    assert.equal(entry.preview.sha256, sha(read(`runtime/lightmaps/${entry.preview.file}`)), entry.preview.file);
  }
  // The runtime GLB must keep what the web relies on: the lightmap UV set, GPU instances, KTX2, meshopt.
  const glb = read(`runtime/${rt.glb.file}`), json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)));
  for (const ext of ['EXT_meshopt_compression', 'KHR_texture_basisu', 'EXT_mesh_gpu_instancing', 'KHR_mesh_quantization']) assert.ok(json.extensionsUsed.includes(ext), ext);
  // Every lightmapped material still has its lightmap UVs on every primitive that draws it.
  for (const name of Object.keys(baked.maps)) {
    const mi = json.materials.findIndex(m => m.name === name);
    const prims = json.meshes.flatMap(m => m.primitives).filter(p => p.material === mi);
    assert.ok(mi >= 0 && prims.length && prims.every(p => 'TEXCOORD_1' in p.attributes), `${name}: TEXCOORD_1 (lightmap UVs) on every primitive`);
  }
  assert.ok(json.images.every(i => i.mimeType === 'image/ktx2'), 'every texture is KTX2');
  // First screen: the GLB holds small previews only, each named after its full-size file in runtime/textures/.
  const names = json.images.map(i => i.name);
  assert.equal(new Set(names).size, names.length, 'preview names are unique (the web maps them to full-size files)');
  assert.deepEqual(names.slice().sort(), Object.keys(rt.textures).sort(), 'every GLB texture has exactly one full-size file');
  for (const [name, t] of Object.entries(rt.textures)) assert.equal(t.sha256, sha(read(`runtime/textures/${t.file}`)), name);
  const previewBytes = json.images.reduce((n, i) => n + json.bufferViews[i.bufferView].byteLength, 0);
  assert.ok(previewBytes < 600e3, `GLB previews weigh ${previewBytes} bytes`);
  assert.ok(glb.length < 5e6, `first-screen GLB is ${glb.length} bytes`);
});

test('standing on a plinth top (a collider, not a walk surface) still walks across it and steps off', () => {
  // Lotus guard of T03: circle r 1.2 at (-11, -8.5), top 0.8. Cross-model review 2026-11-10: landing on a
  // riser hands the frame to ground walking only after a real lift, never while merely on a collider top.
  let p = { x: -11, y: 0.8, z: -8.5, velocityY: null };
  const start = { ...p };
  for (let t = 0; t < 0.15; t += 1 / 60) p = stepFirstPerson(world, p, { forward: 1, right: 0, run: false }, Math.PI / 2, 1 / 60, false);
  assert.ok(Math.abs(p.x - start.x) > 0.3 && p.y === 0.8, `moved across the top: ${JSON.stringify(p)}`);
  for (let t = 0; t < 1.5; t += 1 / 60) p = stepFirstPerson(world, p, { forward: 1, right: 0, run: false }, Math.PI / 2, 1 / 60, false);
  assert.ok(p.y === 0 && p.velocityY === null && p.x < -12.5, `stepped off onto the floor: ${JSON.stringify(p)}`);
});

test('E prompt does not depend on pitch: level or upward views beside a plinth still target it', () => {
  // 2026-11-10 user report: looking level or up near an exhibit hid the E prompt (the ray passed over the plinth).
  for (const [id, y] of [['T03', 0], ['T23', UPPER_Y], ['T02', YLAND]]) {
    const s = world.slots.find(v => v.id === id);
    const yaw = s.yaw ?? 0, out = [Math.sin(yaw), 0, Math.cos(yaw)];          // the plinth faces the visitor along +yaw
    const reach = Math.max(...s.footprint) / 2 + 1.0;
    const eye = [s.position[0] + out[0] * reach, y + 1.3, s.position[2] + out[2] * reach];
    for (const pitch of [0, 0.35, 0.8]) {
      const dir = [-out[0] * Math.cos(pitch), Math.sin(pitch), -out[2] * Math.cos(pitch)];
      assert.equal(targetSlot(world, eye, dir, 3, y)?.id, id, `${id} at pitch ${pitch}`);
    }
    // Turned away (90°) or far: nothing.
    assert.equal(targetSlot(world, eye, [out[2], 0, -out[0]], 3, y), null, `${id} turned away`);
    const far = [s.position[0] + out[0] * (reach + 2.5), y + 1.3, s.position[2] + out[2] * (reach + 2.5)];
    assert.equal(targetSlot(world, far, [-out[0], 0.3, -out[2]], 3, y), null, `${id} too far`);
  }
});

test('E facing fallback: not mid-stairs, not through a wall, not when looking straight up', () => {
  const s = world.slots.find(v => v.id === 'T03');
  const eye = [s.position[0] + 2.2, 1.75, s.position[2]], level = [-1, 0, 0];
  assert.equal(targetSlot(world, eye, level, 3, 0)?.id, 'T03');
  assert.equal(targetSlot(world, eye, level, 3, 1.0), null, 'feet mid-stairs are not on the plinth floor');
  assert.equal(targetSlot(world, eye, [0, 1, 0], 3, 0), null, 'straight up has no facing');
  const alcove = world.slots.find(v => v.id === 'T11');                       // west wall, ground floor
  const outside = [-22.6 - 0.9, 1.75, alcove.position[2]];                    // beyond the wall, facing it
  assert.equal(targetSlot(world, outside, [1, 0, 0], 3, 0), null, 'never through the wall');
});

test('exhibit colliders: finite boxes only, and a visitor caught inside one is moved clear', () => {
  assert.equal(exhibitCollider(3, [NaN, 0, 0], [1, 1, 1]), null);
  assert.equal(exhibitCollider(3, [0, 0, 0], [0, 1, 1]), null);
  const lw = buildNavWorld(layout);                                           // private copy: colliders are mutated
  const s = lw.slots.find(v => v.id === 'T03');
  const c = exhibitCollider(3, [s.position[0] - 0.8, 0.95, s.position[2] - 1.1], [s.position[0] + 0.8, 3.45, s.position[2] + 1.1]);
  assert.ok(c && c.id === `${EXHIBIT_COLLIDER}3`);
  lw.colliders.push(c);
  assert.ok(!world.colliders.some(v => v.id === c.id), 'the shared layout is untouched');
  // Standing on the lotus top (0.8) when the exhibit appears: the body now overlaps it.
  const caught = { x: s.position[0], y: 0.8, z: s.position[2], velocityY: null };
  assert.ok(playerOverlaps(lw.colliders, caught));
  const freed = freePlayer(lw, caught);
  assert.ok(!playerOverlaps(lw.colliders, freed) && supportAt(lw, freed.x, freed.z, freed.y) === freed.y, JSON.stringify(freed));
  assert.ok(Math.hypot(freed.x - caught.x, freed.z - caught.z) < 3, 'moved to a spot close by');
  // And it can walk away from there.
  const away = Math.max(...[0, Math.PI / 2, Math.PI, -Math.PI / 2].map(yaw => {
    const m = stepFirstPerson(lw, freed, { forward: 1, right: 0, run: false }, yaw, 0.2, false);
    return Math.hypot(m.x - freed.x, m.z - freed.z);
  }));
  assert.ok(away > 0.8, `can walk away (${away.toFixed(2)} m in 0.2 s)`);
  // A free visitor is left where they are.
  const free = { x: 0, y: 0, z: 20, velocityY: null };
  assert.equal(freePlayer(lw, free), free);
  // Clearing by prefix leaves the layout colliders exactly as exported.
  const kept = lw.colliders.filter(v => !v.id.startsWith(EXHIBIT_COLLIDER));
  assert.equal(kept.length, layout.colliders.length);
});

test('the follow camera is pulled in by a loaded exhibit (it shares the walking colliders)', async () => {
  const { boomLength, FOLLOW } = await import('../apps/web/src/game/follow-camera.ts');
  const { pavilionCamera } = await import('../apps/web/src/game/navigation.ts');
  const lw = buildNavWorld(layout), cam = pavilionCamera(lw);
  const pivot = [-7.5, 1.75, -8.5], back = [-1, 0, 0];                       // a 3.2 m boom reaches x -10.7, past the exhibit face at -10.2
  const before = boomLength(cam.world, pivot, back, FOLLOW.distance, cam.blockers);
  lw.colliders.push(exhibitCollider(3, [-11.8, 0.95, -9.6], [-10.2, 3.45, -7.4]));
  const after = boomLength(cam.world, pivot, back, FOLLOW.distance, cam.blockers);
  assert.ok(after < before && after < 2.75, `boom ${before.toFixed(2)} → ${after.toFixed(2)}`);
});
