import * as T from 'three';
import { BEAM, BEAM_SOFFIT, FLOOR_Y, GROUND_Y, HOUSE, LANTERN, LANTERNS, PLATFORM, POST, POSTS, PORCH_STEP, ROOF, WALL, WALL_TOP, lanternCentreY, roofHeight } from './layout.js';
import { slab, textured, worldBox, worldCylinder } from './textures.js';

/**
 * T17 personal house. Every part rests on the part below it: the foundation stands on the lawn,
 * posts on stone plinths, beams on posts, purlins on trusses and the roof on purlins.
 * Lattices and friezes hang from the beam soffit. The layout numbers live in layout.ts,
 * which navigation.ts reads for walking and the editor's push-out.
 */
export function roomHouse() {
  const group = new T.Group(), roof = new T.Group();
  group.name = 'room-house'; roof.name = 'room-roof';
  const wood = textured('cherry', { tint: 0x8a4a3a, roughness: .55 });
  const darkWood = textured('darkWood', { tint: 0xb08a6e, roughness: .7 });
  const trim = new T.MeshStandardMaterial({ color: 0xa8773f, roughness: .45, metalness: .25 });
  const stone = textured('marble', { tint: 0x8e9290, roughness: .75 });
  const coping = textured('marble', { tint: 0xb8b6ae, roughness: .6 });
  const floor = textured('granite', { tint: 0xe8e2d6, lift: 2.4, roughness: .55 });
  const plaster = textured('marble', { tint: 0xd8c7a6, roughness: .9, normal: .4, scale: 2 });
  const paper = new T.MeshStandardMaterial({ color: 0xf2e5c4, roughness: .95, emissive: 0x3a2c18, side: T.DoubleSide });
  const tiles = textured('roof', { tint: 0x8d9aa0, roughness: .8, rotate: true });
  const ceiling = textured('planks', { tint: 0xa47c60, roughness: .8 });

  // Foundation on the lawn, with a wider footing course, stone coping ring and granite floor.
  const { x: px, z: pz } = PLATFORM, top = FLOOR_Y - .03;
  slab(group, stone, 2 * px + .12, .1, 2 * pz + .12, 0, GROUND_Y + .05, 0);
  slab(group, stone, 2 * px, top - GROUND_Y - .1, 2 * pz, 0, (top + GROUND_Y + .1) / 2, 0);
  const hx = HOUSE.x, hz = HOUSE.z;
  slab(group, floor, 2 * hx, .03, 2 * hz, 0, FLOOR_Y - .015, 0);
  for (const side of [-1, 1]) {
    slab(group, coping, 2 * px, .03, pz - hz, 0, FLOOR_Y - .015, side * (hz + pz) / 2);
    slab(group, coping, px - hx, .03, 2 * hz, side * (hx + px) / 2, FLOOR_Y - .015, 0);
  }
  const step = slab(group, coping, PORCH_STEP.x1 - PORCH_STEP.x0, PORCH_STEP.y - GROUND_Y, PORCH_STEP.z1 - PORCH_STEP.z0,
    0, (PORCH_STEP.y + GROUND_Y) / 2, (PORCH_STEP.z0 + PORCH_STEP.z1) / 2);
  step.name = 'porch-step';

  // Posts on plinths; low walls and their cap rails run between them.
  for (const [x, z] of POSTS) {
    const plinth = new T.Mesh(worldCylinder(POST.plinthRadius - .03, POST.plinthRadius, POST.plinthHeight, 20), coping);
    plinth.position.set(x, FLOOR_Y + POST.plinthHeight / 2, z);
    const height = BEAM_SOFFIT - POST.plinthHeight;
    const post = new T.Mesh(worldCylinder(POST.radius, POST.base, height, 16), wood);
    post.position.set(x, FLOOR_Y + POST.plinthHeight + height / 2, z);
    group.add(plinth, post);
  }
  const between = (a: number, b: number) => [a + POST.base - .01, b - POST.base + .01] as const;
  const sideZ = [-hz, -hz / 2, 0, hz / 2, hz], rearX = [-hx, -hx / 2, 0, hx / 2, hx];
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const [z0, z1] = between(sideZ[i], sideZ[i + 1]);
      slab(group, plaster, WALL.thickness, WALL.height, z1 - z0, side * hx, WALL.height / 2, (z0 + z1) / 2);
      slab(group, darkWood, WALL.thickness + .06, WALL.cap, z1 - z0, side * hx, WALL.height + WALL.cap / 2, (z0 + z1) / 2);
      frieze(group, darkWood, side * hx, z0, z1);
    }
    const [x0, x1] = between(rearX[i], rearX[i + 1]);
    slab(group, plaster, x1 - x0, WALL.height, WALL.thickness, (x0 + x1) / 2, WALL.height / 2, -hz);
    slab(group, darkWood, x1 - x0, WALL.cap, WALL.thickness + .06, (x0 + x1) / 2, WALL.height + WALL.cap / 2, -hz);
    lattice(group, darkWood, paper, x0, x1, -hz);
  }

  // Beam ring on the posts: front and rear run full width, the sides fit between them.
  const beamY = BEAM_SOFFIT + BEAM.depth / 2;
  for (const z of [-hz, hz]) slab(group, wood, 2 * hx + BEAM.width, BEAM.depth, BEAM.width, 0, beamY, z);
  for (const x of [-hx, hx]) slab(group, wood, BEAM.width, BEAM.depth, 2 * hz - BEAM.width, x, beamY, 0);

  // Lanterns hang on rods from the front lintel.
  const lanternRed = new T.MeshStandardMaterial({ color: 0xb4402c, roughness: .6, emissive: 0x7a1e0e, emissiveIntensity: .9 });
  const rod = new T.MeshStandardMaterial({ color: 0x2d2622, roughness: .5, metalness: .4 });
  for (const [x, z] of LANTERNS) {
    const cy = lanternCentreY(), half = LANTERN.radius * LANTERN.stretch;
    const hanger = new T.Mesh(new T.CylinderGeometry(.012, .012, LANTERN.drop, 6), rod);
    hanger.position.set(x, BEAM_SOFFIT - LANTERN.drop / 2, z);
    const body = new T.Mesh(new T.SphereGeometry(LANTERN.radius, 20, 14), lanternRed);
    body.scale.y = LANTERN.stretch; body.position.set(x, cy, z);
    const capTop = new T.Mesh(new T.CylinderGeometry(.09, .12, .06, 14), trim);
    capTop.position.set(x, cy + half - .01, z);
    const capBottom = capTop.clone(); capBottom.rotation.x = Math.PI; capBottom.position.y = cy - half + .01;
    const tassel = new T.Mesh(new T.CylinderGeometry(.015, .045, .26, 8), lanternRed);
    tassel.position.set(x, cy - half - .02 - .13, z);
    group.add(hanger, body, capTop, capBottom, tassel);
  }

  // Roof frame, shown with the roof in walking modes.
  const tieTop = beamY + BEAM.depth / 2 + .24;
  const purlinXs = [-hx, -hx / 2, 0, hx / 2, hx];
  const underside = (x: number) => roofChord(x) - ROOF.thickness / 2 / Math.cos(roofSlope(x)) - .005;
  for (const z of sideZ) {
    slab(roof, wood, 2 * hx + BEAM.width, .24, .2, 0, tieTop - .12, z);
    for (const x of purlinXs.slice(1, -1)) {
      const height = underside(x) - .2 - tieTop;
      slab(roof, wood, .16, height, .16, x, tieTop + height / 2, z);
    }
  }
  const purlinLength = 2 * hz + 2 * ROOF.overhangZ - .1;
  for (const x of purlinXs) {
    const bottom = Math.abs(x) === hx ? beamY + BEAM.depth / 2 : underside(x) - .2;
    const height = underside(x) - bottom;
    slab(roof, wood, .2, height, purlinLength, x, bottom + height / 2, 0);
  }
  // Gable infill rests on the end tie beam (its outer face is at hz + .1).
  for (const side of [-1, 1]) roof.add(gable(plaster, darkWood, side * (hz + .08), tieTop, underside));

  // Swept roof strips: tiles above, plank ceiling below, then the ridge cap.
  const roofFaces = [tiles, tiles, tiles, ceiling, tiles, tiles];
  for (const side of [-1, 1]) for (let i = 0; i < ROOF_SEGMENTS; i++) {
    const x0 = side * i / ROOF_SEGMENTS * (hx + ROOF.overhangX), x1 = side * (i + 1) / ROOF_SEGMENTS * (hx + ROOF.overhangX);
    const y0 = roofHeight(x0), y1 = roofHeight(x1);
    const length = Math.hypot(x1 - x0, y1 - y0) + .02;
    const strip = new T.Mesh(worldBox(length, ROOF.thickness, 2 * hz + 2 * ROOF.overhangZ), roofFaces);
    strip.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    // Keep the tile face (+y) up on both slopes.
    strip.rotation.z = -side * Math.atan2(y0 - y1, Math.abs(x1 - x0));
    strip.castShadow = strip.receiveShadow = true;
    roof.add(strip);
  }
  const ridgeY = roofHeight(0) + ROOF.thickness / 2;
  slab(roof, trim, .26, .26, 2 * hz + 2 * ROOF.overhangZ + .2, 0, ridgeY + .1, 0);
  for (const side of [-1, 1]) {
    const end = slab(roof, trim, .3, .5, .3, 0, ridgeY + .34, side * (hz + ROOF.overhangZ + .1));
    end.rotation.x = side * -.25;
  }
  group.add(roof);
  return { group, roof };
}

const ROOF_SEGMENTS = 12;
/** Height of the flat strip (not the ideal curve) above |x|: what the purlins actually touch. */
function roofChord(x: number) {
  const span = HOUSE.x + ROOF.overhangX, a = Math.min(Math.abs(x) / span, 1) * ROOF_SEGMENTS;
  const i = Math.min(Math.floor(a), ROOF_SEGMENTS - 1), t = a - i;
  return roofHeight(i / ROOF_SEGMENTS * span) * (1 - t) + roofHeight((i + 1) / ROOF_SEGMENTS * span) * t;
}
function roofSlope(x: number) {
  const span = HOUSE.x + ROOF.overhangX, i = Math.min(Math.floor(Math.min(Math.abs(x) / span, 1) * ROOF_SEGMENTS), ROOF_SEGMENTS - 1);
  return Math.atan2(Math.abs(roofHeight((i + 1) / ROOF_SEGMENTS * span) - roofHeight(i / ROOF_SEGMENTS * span)), span / ROOF_SEGMENTS);
}

/** Gable infill between the end truss and the roof, framed in dark wood. */
function gable(fill: T.Material, frame: T.Material, z: number, bottom: number, underside: (x: number) => number) {
  const shape = new T.Shape(), points: [number, number][] = [];
  for (let i = 0; i <= 24; i++) { const x = -HOUSE.x + i / 24 * 2 * HOUSE.x; points.push([x, underside(x)]); }
  shape.moveTo(-HOUSE.x, bottom);
  for (const [x, y] of points) shape.lineTo(x, Math.max(y, bottom));
  shape.lineTo(HOUSE.x, bottom);
  const panel = new T.Mesh(new T.ExtrudeGeometry(shape, { depth: .04, bevelEnabled: false }), fill);
  panel.position.z = z - .02;
  const group = new T.Group(); group.add(panel);
  for (const x of [-HOUSE.x / 4 * 3, -HOUSE.x / 4, HOUSE.x / 4, HOUSE.x / 4 * 3]) {
    const height = underside(x) - bottom;
    slab(group, frame, .1, height, .06, x, bottom + height / 2, z);
  }
  panel.castShadow = panel.receiveShadow = true;
  return group;
}

/** Hanging frieze (挂落) along a side bay: rails from the beam soffit down to 3.7 m with slats. */
function frieze(parent: T.Object3D, material: T.Material, at: number, a0: number, a1: number) {
  const top = BEAM_SOFFIT, bottom = 3.7, length = a1 - a0, mid = (a0 + a1) / 2;
  slab(parent, material, .08, .06, length, at, bottom + .03, mid);
  slab(parent, material, .08, .05, length, at, top - .025, mid);
  const count = Math.max(2, Math.round(length / .32));
  for (let i = 1; i < count; i++) {
    const z = a0 + i / count * length;
    slab(parent, material, .05, top - bottom - .11, .035, at, (top + bottom) / 2 + .005, z);
  }
  for (const y of [bottom + .32, bottom + .6]) slab(parent, material, .05, .03, length - .02, at, y, mid);
}

/** Rear window bay: frame from the wall cap to the beam soffit, lattice in front of rice paper. */
function lattice(parent: T.Object3D, material: T.Material, paper: T.Material, x0: number, x1: number, z: number) {
  const bottom = WALL_TOP, top = BEAM_SOFFIT, width = x1 - x0, height = top - bottom, mid = (x0 + x1) / 2;
  slab(parent, material, width, .08, .12, mid, bottom + .04, z);
  slab(parent, material, width, .08, .12, mid, top - .04, z);
  slab(parent, material, width, .1, .1, mid, bottom + height * .72, z);
  const inner = bottom + .08, upper = top - .08;
  const columns = Math.max(3, Math.round(width / .3)), rows = Math.round((upper - inner) / .3);
  for (let i = 1; i < columns; i++) slab(parent, material, .035, upper - inner, .05, x0 + i / columns * width, (inner + upper) / 2, z + .02);
  for (let j = 1; j < rows; j++) slab(parent, material, width - .02, .035, .05, mid, inner + j / rows * (upper - inner), z + .02);
  const sheet = new T.Mesh(new T.PlaneGeometry(width - .02, upper - inner), paper);
  sheet.position.set(mid, (inner + upper) / 2, z - .03);
  sheet.receiveShadow = true;
  parent.add(sheet);
}
