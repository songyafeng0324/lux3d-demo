// T16 D3: downscale the user's backdrop paintings for the web sky (assets/t16/sky/, committed).
//   node scripts/prep-t16-sky.mjs   (repo root)
// A11 (a misty mountain cluster, transparent) and A12 (a 2×2 atlas of floating isles, transparent) become
// billboards around the pavilion (apps/web/src/game/sky.ts). Alpha is kept; nothing else is changed.
// WebP since 2026-11-12 (first-screen budget): the 1024 px PNGs weighed 2.1 MB together and PNG does not
// gzip; lossy WebP with a near-lossless alpha keeps the soft misty edges at a small fraction of that.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const sharp = createRequire(path.resolve('packages/domain/package.json'))('sharp');
const SRC = path.resolve('docs/design/t16/textures'), OUT = path.resolve('assets/t16/sky');
await fs.mkdir(OUT, { recursive: true });
for (const [src, dst, width] of [['A11-mountain-layers.png', 'mountains.webp', 1024], ['A12-floating-isles.png', 'isles.webp', 1024]]) {
  const out = path.join(OUT, dst);
  await sharp(path.join(SRC, src)).resize({ width }).webp({ quality: 82, alphaQuality: 90, effort: 6, smartSubsample: true }).toFile(out);
  const meta = await sharp(out).metadata();
  console.log(dst, meta.width, meta.height, (await fs.stat(out)).size);
}
