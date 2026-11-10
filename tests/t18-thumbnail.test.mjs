import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';
register();
const T = await import('three');
const { framePreview } = await import('../apps/web/src/game/model-preview-scene.ts');
const { THUMBNAIL_FILL } = await import('../apps/web/src/game/AssetThumbnail.tsx');

/** Largest |NDC| reached by the model's bounding-box corners, per axis. */
function extent(model, camera) {
  camera.updateMatrixWorld(true); model.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(model), p = new T.Vector3();
  let x = 0, y = 0;
  for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
    p.set(cx, cy, cz).project(camera); x = Math.max(x, Math.abs(p.x)); y = Math.max(y, Math.abs(p.y));
  }
  return { x, y };
}

test('T18 thumbnails: flat, tall and long models all fill the frame to THUMBNAIL_FILL without clipping', () => {
  // A low grass clump, a tall vase, a long bench, a cube; each off-centre to check the centring too.
  for (const [w, h, d] of [[3, .5, 2.6], [.3, 1.4, .3], [2.4, .45, .5], [1, 1, 1]]) {
    const model = new T.Mesh(new T.BoxGeometry(w, h, d));
    model.position.set(5, -2, 1);
    const group = new T.Group(); group.add(model);
    const camera = new T.PerspectiveCamera(35, 192 / 144);
    framePreview(group, camera, THUMBNAIL_FILL);
    const { x, y } = extent(group, camera);
    assert.ok(x <= THUMBNAIL_FILL + 1e-6 && y <= THUMBNAIL_FILL + 1e-6, `inside: ${w}×${h}×${d} → ${x}, ${y}`);
    assert.ok(Math.max(x, y) > THUMBNAIL_FILL - 1e-3, `binding axis reaches the fill: ${w}×${h}×${d} → ${x}, ${y}`);
  }
});
