import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';
register(); // room/*.ts import TS sources and @aholo/contracts
const { itemBlocks, itemConflict, ridersOf, supportUnder, REST_GAP } = await import('../apps/web/src/room/navigation.ts');
const { GROUND_Y } = await import('../apps/web/src/room/layout.ts');

// Model-space bounds of a few typical items (bottom at y = 0).
const bounds = new Map([
  ['table', { min: [-.8, 0, -.5], max: [.8, .75, .5] }],
  ['vase', { min: [-.15, 0, -.15], max: [.15, .4, .15] }],
  ['cup', { min: [-.05, 0, -.05], max: [.05, .1, .05] }],
  ['grass', { min: [-.6, 0, -.6], max: [.6, .3, .6] }],
]);
const place = (id, assetId, x, y, z) => ({ id, assetId, position: [x, y, z], rotation: [0, 0, 0], scale: 1 });
const box = p => itemBlocks([p], bounds, new Set())[0].box;

test('T19 support: a smaller item over a table rests on its top; a table over a vase does not', () => {
  const items = itemBlocks([place('t', 'table', 0, 0, 0)], bounds, new Set());
  assert.deepEqual(supportUnder(box(place('v', 'vase', .4, 0, .2)), items), { y: .75, id: 't' });
  // Centre off the table: back on the floor (house floor is y = 0).
  assert.deepEqual(supportUnder(box(place('v', 'vase', 1.2, 0, 0)), items), { y: 0, id: null });
  // A table is never held up by a vase underneath.
  const vaseItems = itemBlocks([place('v', 'vase', 0, 0, 0)], bounds, new Set());
  assert.equal(supportUnder(box(place('t', 'table', 0, 0, 0)), vaseItems).id, null);
  // On the lawn the floor is the courtyard level.
  assert.equal(supportUnder(box(place('v', 'vase', 12, 0, 10)), []).y, GROUND_Y);
});

test('T19 support: the highest holder wins, so stacks build up layer by layer', () => {
  const placements = [place('t', 'table', 0, 0, 0), place('v', 'vase', 0, .75, 0)];
  const items = itemBlocks(placements, bounds, new Set());
  assert.deepEqual(supportUnder(box(place('c', 'cup', 0, 0, 0)), items), { y: 1.15, id: 'v' });
});

test('T19 grass neither blocks nor holds anything up', () => {
  const items = itemBlocks([place('g', 'grass', 0, 0, 0)], bounds, new Set(['grass']));
  assert.equal(items.length, 0);
  assert.equal(itemConflict(box(place('v', 'vase', 0, 0, 0)), items), null);
});

test('T19 conflicts: overlapping counts, resting on top or standing side by side does not', () => {
  const items = itemBlocks([place('t', 'table', 0, 0, 0)], bounds, new Set());
  assert.equal(itemConflict(box(place('v', 'vase', .3, 0, 0)), items), 't', 'vase inside the table box');
  assert.equal(itemConflict(box(place('v', 'vase', .3, .75, 0)), items), null, 'vase exactly on the top');
  assert.equal(itemConflict(box(place('v', 'vase', .95, 0, 0)), items), null, 'vase touching the side');
  assert.equal(itemConflict(box(place('t2', 'table', 1.2, 0, 0)), items), 't', 'second table half over the first');
});

test('T19 riders: items resting on the dragged one, and those on them, move with it', () => {
  const placements = [
    place('t', 'table', 0, 0, 0),
    place('v', 'vase', .4, .75, 0),
    place('c', 'cup', .4, 1.15, 0),
    place('v2', 'vase', -.4, .75 + REST_GAP / 2, 0), // within the rest gap still counts
    place('lifted', 'vase', -.4, 1.3, .2),         // lifted on purpose: not riding
    place('beside', 'vase', 1.2, 0, 0),            // on the floor next to it
  ];
  const all = itemBlocks(placements, bounds, new Set());
  const table = all.find(b => b.id === 't');
  assert.deepEqual(ridersOf(table, all), ['v', 'v2', 'c'], 'lowest layer first');
  assert.deepEqual(ridersOf(all.find(b => b.id === 'v'), all), ['c']);
  assert.deepEqual(ridersOf(all.find(b => b.id === 'beside'), all), []);
});
