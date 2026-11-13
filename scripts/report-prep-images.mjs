// 项目报告书素材：把证据截图、参考图、渲染图统一压成 JPEG，放进 docs/report/assets/img/（报告 HTML 只引用这里）。
// 用法：node scripts/report-prep-images.mjs   （先跑过 report-render-models.mjs 与 report-live-shots.mjs）
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const sharp = createRequire(path.resolve('packages/domain/package.json'))('sharp');
const OUT = path.resolve('docs/report/assets/img');
await fs.mkdir(OUT, { recursive: true });

const E = 'docs/validation/evidence';
const t17 = ['01-八仙桌', '02-圈椅', '03-博古架', '04-四扇屏风', '05-落地宫灯', '06-铜香炉', '07-荷花缸', '08-太湖石', '09-松树盆景', '10-高花几'];
const props = ['B1-stone-lion', 'B2-stone-lamp', 'B3-incense-burner', 'B4-vase', 'B5-jade-bi', 'B6-bronze-jue', 'B7-ruyi', 'B8-book-box', 'B9-jade-mountain'];

// [输出名, 源文件, 宽度, 可选 extract 区域]
const JOBS = [
  // 线上实拍
  ['live-intro', 'docs/report/assets/live/01-intro.jpg', 1600],
  ['live-hall', 'docs/report/assets/live/02-hall.jpg', 1600],
  ['live-walk', 'docs/report/assets/live/03-walk.jpg', 1600],
  ['live-lookup', 'docs/report/assets/live/04-look-up.jpg', 1600],
  ['live-detail', 'docs/report/assets/live/05-exhibit-detail.jpg', 1600],
  // 场景迭代
  ['t10a-concept', 'docs/design/t10-a/01-entry-concept.png', 1200],
  ['t10-v1-intro', `${E}/t10-c/01-intro.png`, 1200],
  ['t10-v1-upper', `${E}/t10-c/06-upper-gallery.png`, 1200],
  ['style-ref', 'docs/design/references/仙侠古阁风格参考.png', 1200],
  ['concept-entry', 'docs/design/t16/concepts/01-entry.png', 1200],
  ['concept-atrium', 'docs/design/t16/concepts/02-atrium-up.png', 1200],
  ['d2-entry', 'SCRATCH/hist/d2-entry.png', 1200],
  ['d2-atrium', 'SCRATCH/hist/d2-atrium.png', 1200],
  ['d3-entry', `${E}/t16/d3/01-entry.jpg`, 1200],
  ['d3-atrium', `${E}/t16/d3/02-atrium-up.jpg`, 1200],
  ['d3-sky', `${E}/t16/d3/06-terrace-sky.jpg`, 1200],
  ['d3-lion', `${E}/t16/d3/14-exterior-wide.jpg`, 1200],
  ['d3-hall', `${E}/t16/d3/13-hall-wide.jpg`, 1200],
  // 小屋 / 后台 / 背包
  ['room-t11', `${E}/t11/courtyard-edit.png`, 1200],
  ['room-t17-overview', `${E}/t17/01-edit-overview.png`, 1200],
  ['room-t17-visit', `${E}/t17/11-visit.png`, 1200],
  ['room-t17-inside', `${E}/t17/06-visit.png`, 1200],
  ['room-t19-stack', `${E}/t19/02-stacked.png`, 1200],
  ['admin-slots', `${E}/t21/02-slot-panel.png`, 1200],
  ['backpack-t06', `${E}/t06/backpack-real-model.png`, 1200],
  // 角色
  ['cat-reference', 'assets/characters/humanoid-tabby/reference.png', 700],
  ['cat-motion', 'assets/characters/humanoid-tabby/final-motion.png', 1200],
  ['bronze-ref-ding', 'assets/bronze-references/fang-ding.png', 900],
  // 官方物品：参考图 → Lux3D 模型渲染
  ...t17.map((n, i) => [`t17-ref-${String(i + 1).padStart(2, '0')}`, `assets/furniture/references/t17/${n}.png`, 420]),
  ...t17.map((n, i) => [`t17-model-${String(i + 1).padStart(2, '0')}`, `docs/report/assets/models/t17-${String(i + 1).padStart(2, '0')}.png`, 420]),
  // 摆件
  ...props.map(p => [`prop-ref-${p}`, `docs/design/t16/props/${p}.png`, 420]),
  ...props.map(p => [`prop-model-${p}`, `docs/report/assets/models/${p}.png`, 420]),
];

const SCRATCH = process.env.SCRATCH ?? '/private/tmp/claude-501/-Users-yafeng--claude-spares-spare-WKfxsL/5227df33-a756-4d41-9fa4-0997cf142692/scratchpad';
for (const [name, srcRaw, width] of JOBS) {
  let src = srcRaw.replace('SCRATCH', SCRATCH);
  if (srcRaw.startsWith('SCRATCH')) {
    // 历史版本截图已从 git 取出放在草稿目录；不存在时用 git show 现取
    try { await fs.access(src); } catch {
      const map = { 'SCRATCH/hist/d2-entry.png': '9a6229b:docs/validation/evidence/t16/01-entry.png', 'SCRATCH/hist/d2-atrium.png': '9a6229b:docs/validation/evidence/t16/02-atrium-up.png' };
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, execFileSync('git', ['show', map[srcRaw]], { maxBuffer: 1 << 26 }));
    }
  }
  const out = path.join(OUT, name + '.jpg');
  await sharp(src).resize({ width, withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 84, mozjpeg: true }).toFile(out);
  console.log(name, ((await fs.stat(out)).size / 1024).toFixed(0) + ' KB');
}
