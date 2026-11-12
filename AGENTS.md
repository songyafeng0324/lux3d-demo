# 藏宝阁与个人小屋（aholo-lux3d） · 协作约定(Claude Code / Codex 共用入口)

> `CLAUDE.md` 软链到本文件,两个工具读同一份。**真相源在文件里,不在对话里。**
> 本文件是**运行时合同**:精要规则 + 约束 + 指针。完整详规在 `flow/规范/`。

## 目录地图(哪个文件夹放什么)
- 根级 `flow/` — 唯一控制层(项目"怎么跑"):`charter.md` 目标 / `plan.md` 计划=契约 / `进展.md` 进展日志(顶部=交接棒)/ `decisions.md` 决策日志 / `踩坑记录.md` 问题与经验库 / `tasks/` 任务卡 / `规范/` 方法论详规
- 根级 `docs/` — 集中内容层(项目"做出什么"):产品 / 架构 / `contracts/` 跨模块契约 / `modules/` 模块说明 / 评审和产出说明
- `apps/web/`、`apps/api/`、`apps/worker/` — 网页、HTTP服务、后台进程；`packages/domain/`、`packages/contracts/` — 领域基础与DTO。各模块有局部入口，仍共用根级控制层。
- `migrations/`、`scripts/`、`tests/` — 版本迁移、环境与运行管理、基础验证。运行入口见 `docs/本地运行.md`；实际结果见 `docs/validation/本地基础工程验证.md`。
- 线上部署见 `docs/部署说明.md`：`bash scripts/deploy-hk.sh` 在 Mac 构建后 rsync 到服务器（服务器不放源码）；`node scripts/pull-hk.mjs` 把线上数据拉回 Mac（加 `--apply` 才替换本机库）；`bash scripts/stats-hk.sh` 看访问与业务统计。
- `assets/t16/` — 现行藏宝阁：Blender 源、GLB 与布局/行走数据（由 `scripts/blender/build_t16.py` 导出），`textures/polyhaven/` 为入库的 CC0 贴图（`scripts/fetch-t16-textures.mjs` 下载）；`assets/t10/` 为旧二层阁的历史资产。运行验证在 `docs/validation/`。
- `DESIGN.md` — 古建筑场景、家具及交互的设计决策入口；具体方案按需放 `docs/design/`。
- **判据**:协调 / 推进总体项目的 → 根级 `flow/`;需要统一发现的知识和方案 → 根级 `docs/`;代码 → 对应子项目。默认不在子项目重复建 `flow/` 或 `docs/`

## 多子项目边界
- 前端、后端、落地页等共享同一仓库和总体目标时,共用根级 `flow/`、`docs/` 和 hook。
- 每个有独立职责的子项目只建局部规则入口,不复制总体计划、交接或文档体系。
- 已有 README、生成文档或必须紧贴代码维护的说明可以留在模块内,但要从根级 `docs/README.md` 建索引。
- 子目录有独立 `.git`、版本、发布或团队边界时,按独立项目处理;完整判断见 `flow/规范/多子项目结构.md`。

## 沟通与授权
- 每次面向用户回复先称呼“爸爸”；默认简体中文，代码、命令和技术标识保持英文。
- 先说明影响和结论，再给行动、待决策和必要证据；只保留帮助理解或复现的细节。
- 用户当前明确指令优先于 Skill、历史记忆和默认偏好；已授权的初始化及必要文档维护直接执行，不重复确认。
- 只有真正独立、能节省时间或提升质量的工作流才委派；共享状态和连续决策由主 Agent 处理。
- 网页控制台无 CLI/API 时使用已登录 Chrome；飞书优先 `lark-cli`。
- 2026-11-05 用户明令：构建、测试、数据库与浏览器验证只在用户 Mac 本机执行，禁止在云端容器跑；需要执行命令时在 Mac 终端运行。部署与线上检查可以在阿里云香港服务器上执行；开发阶段的单元测试和浏览器回归仍在 Mac 本机跑。
- 2026-11-10 用户确认的检查与提交节奏：
  - 每次改动后都跑单元测试 `npm test`；纯视觉调整没有对应测试时，用截图核对并说明原因。
  - 浏览器回归（`test:t10`、`test:t15`、`test:t08`）和跨模型评审，在用户要求提交 Git 前统一运行；改动明显涉及行走、镜头或展品时，提醒用户可提前跑对应那一项，由用户决定。
  - 未经用户明确要求不提交 Git；夜间等临时授权只在当次有效。

## 开工前必读
1. `flow/charter.md` — 目标 / 范围 / 约束 / 成功标准
2. `flow/plan.md` — 当前计划(**契约**,用户明确调整目标或范围即授权相应变更,先更新计划再执行)
3. `flow/进展.md` **顶部一条** — 上一棒交接棒(做了啥 / 产出路径 / 下一步)
4. 你被分配的任务卡:`flow/tasks/<...>.md`
5. 当前目录若有局部 `AGENTS.md`,同时遵守其中的职责边界和模块约束

## 开工时的需求理解

新任务、接手任务或目标实质变化时,读完必要上下文、实质执行前,用自己的话简短说明用户希望达到的结果、待解决的原始问题和必要范围。普通补充、进度询问或连续小改动不机械重复;明确需求后按已有授权继续,不另等确认。推断要标明,只有关键歧义影响结果、范围或授权时才澄清。收尾用“为什么”回应原始目标,结合产出和验证说明达成程度;详见 `flow/规范/工作流程.md` 的「需求理解与结果回应」。

## 收工前必做

以下检查和记录在最终回复前完成；先执行当前路径生效入口中的业务专项收工检查,不扩大本轮授权。Codex 在最终回复中直接展示任务结果与交接,不等待 Stop 续跑,不在结果后追加“无需更新”;本技能的 Codex Stop 仅静默放行。Claude Code 保留单次续跑兜底。

1. 在 `flow/进展.md` **最上面追加一条进展**(做了什么 / 为什么 / 怎么理解 / 产出 / 问题与解决 / 下一步),回复展示同一组事实。默认用单层 Markdown 列表、加粗字段名,列表与前后正文留空行;路径按当前客户端转成可点击链接,不把整条包进代码块或引用块,不重复贴相同摘要。用户明确格式优先;完整约定见 `flow/规范/工作流程.md` 的「交接输出约定」。
2. 决策追加 `flow/decisions.md`;问题 / 踩坑追加 `flow/踩坑记录.md`。
3. 运行与改动相称的检查（节奏见「沟通与授权」：每次单元测试，回归与评审在提交前）；低影响、可逆的文档改动不另写复述实现的测试。完成后清理本轮无用临时文件。
4. 文档自检:本轮若动了结构 / 方向 / 约定,主动提议更新本文件(见「文档维护」)。

## 核心约束(铁律)
- 审稿模型 ≠ 产出模型(交付前换另一个模型评审)。
- 产出落文件,不留在对话里。
- 先 plan 后 act,计划即契约;要改先改 `flow/plan.md`。
- 一会话一焦点。
- 单仓只保留一套总体控制层;模块任务通过任务卡和产出路径区分。
- 产物本身是真相唯一来源;文档只补"看产物看不出的为什么"。
- 解决问题从根本上解,不打补丁。
- 进展条 / 交接只带「指针 + 增量」,不重抄内容。

## 文档维护(精要)
出现新的设计哲学 / 心智模型 / 方向、结构或契约调整、长期约定、需持续参考的外部资料 → 已有用户授权的必要更新直接执行；涉及未授权的范围或关键业务取舍时，先列出具体修改点再确认。只沉淀"看产物看不出的为什么";就近写;保持精简。
完整规范:`flow/规范/文档维护SOP.md`;设计 / 创意类归 `DESIGN.md`(`flow/规范/DESIGN维护SOP.md`)。

## 详规索引
- 工作流程(五段循环 / 进展日志接力 / 评审):`flow/规范/工作流程.md`
- 文档自检 hook:`flow/规范/hook机制.md`

---
## 项目知识(durable,随项目积累 ↓)
<!-- 心智模型、关键决策的为什么、从踩坑提炼的禁区 / 约定、外部资料引用索引;按 文档维护SOP 维护。详细问题 / 踩坑日志在 flow/踩坑记录.md -->

## 项目边界与产品依据
- 当前按单一项目边界管理；T02 本地实施基线见 `docs/architecture/MVP技术方案.md`，合同见 `docs/contracts/数据与接口契约.md`，验证项未关闭前不宣称参数全部冻结。
- 2026-11-04 起先在 MacBook 本地跑通，云资源/区域/预算暂缓；最新范围增量见 `docs/product/2026-11-04-本地优先确认.md`，在对应事项上优先于此前补充。本地资产走私有 LocalFileStore，数据库保持 PostgreSQL，避免换用不同事务语义。2026-11-12 起公开上线：主站部署在阿里云香港轻量服务器（4 核 8 GB），走 https，不限制注册和生成总量；理由见 `flow/decisions.md`。线上域名 https://yafeng.fun，以服务器数据为准；配置在 `/etc/aholo/aholo.env`，数据在 `/var/lib/aholo/data`，每天 04:30 自动备份、保留 7 天；轻量服务器没有自动快照，大改前在控制台手动拍。SSH 用 `ssh aholo-hk`；Mac 开着 TAG 代理时必须走 `BindInterface en0`，`nc` 显示端口通、`dig` 查到 198.18.x.x 都是代理造成的假象。
- 当前产品基线：`docs/product/藏宝阁与个人小屋-MVP-PRD-v2.0.md` 与 `docs/product/2026-11-03-需求补充确认.md`；后者记录已确认增量并在相应事项上优先。基线不能标为已实现或已通过验收。
- T12 试玩规则见 `docs/product/2026-11-06-试玩功能调整.md`，对应事项优先。默认生成额度为每天 10 次，实际使用量及管理员当日覆盖继续由 PostgreSQL 结算。
- T13 展品收藏规则见 `docs/product/2026-11-07-展品收藏与背包改版.md` 与数据契约第 12 节。收藏读取当前获审公共名称和作者昵称，取消收藏原子清理本人小屋的对应摆放并撤销旧分享的该模型权限。
- F01～F13 全部属于 MVP；E01～E07 为工程待落实项，B01 需复核。后续任务引用这些稳定编号，避免另写冲突规则。
- 产品额度与提交日按北京时间（UTC+8）日界处理，与协作记录使用的用户本地时区分开。
- 生成成功以模型进入个人背包并可预览为准；模拟或第三方成功状态不能替代真实交付验收。
- PRD 引用的历史 `访谈/`、旧版和场景草稿尚未随工作空间提供；不得虚构来源核验结果。
- 文档导航及需求流转见 `docs/README.md`；设计方向见 `DESIGN.md`；具体功能规则回查 PRD。
- 本地PG为独立55432实例；数据和本机凭证在用户Application Support目录，项目.env被忽略。维护原有数据，不因测试覆盖原库。E2E检查worker缺失，运行前停止开发worker；测试只用独立临时库写fixture。
- T03 中国区技术接入基线见 `docs/contracts/Lux3D接入契约.md`，真实验证见 `docs/validation/Lux3D接入验证.md`。供方ID无损字符串，create不自动重发；陌生错误保留unknown，不能按相近历史记录自动认领任务。
- 中国区凭证可由服务端读取私有Lux3D配置，不把key/签名URL放前端或Git。T03资产保持独立验证库；T06正式链路已验收，主应用generationReady由真实配置、存储/数据库及启用生成的worker心跳决定。
- T04场景基线见 `docs/design/场景与交互方案.md`、`docs/validation/场景交互验证.md`；几何真相源为 `packages/contracts/src/scene.ts`。`/api/lab/t04`只用于独立本机文件实验，不能替代T07/T08正式账号、PG事务及token合同。
- 保存状态回调不能重置正在拖动的变换；网络丢响应保留原key/body，确定拒绝清旧请求并继续新草稿。具体回归见T04浏览器脚本。

## 沉浸式体验与建模方向
- 最新产品增量见 `docs/product/2026-11-04-沉浸场景与建模确认.md`，总体执行依据见 `docs/architecture/沉浸式MVP实施计划.md`：前台全视口游戏式3D、Agent用Blender MCP制作可上下楼二层古阁；先框架/完整功能，细节后补。
- 2026-11-05用户已明确启动T10；T10（A设计、B建筑框架、C全视口前台）已全部完成并经Mac真机验证；T06/T07/T08正式业务也已完成，T09 已完成 Mac 本地功能验收与独立复核。Blender/MCP实际状态和只读探针见环境记录，不把连接检查当成模型交付。
- 首页 `/` 为全屏藏宝阁，与 `/room` 共用背包及 `B` 快捷键，两处菜单均有账号设置。健康诊断入口为 `/api/v1/health/ready`。T16 起藏宝阁的模型与行走数据同源：`scripts/blender/build_t16.py` 一次导出 GLB 和 `assets/t16/pavilion-layout.json`（可走面、碰撞、跳跃顶、镜头遮挡、30 展位分档），`navigation.ts` 只跑规则不写几何，禁止手抄坐标；可走面视为实心体的顶面，行走和空中移动都不得从侧面进入。改建筑就改脚本重新导出（构件库 `t16_kit.py`、材质 `t16_materials.py`、摆件 `t16_props.py`；Lux3D 摆件原始下载不入库，由 `prep_t16_props.py` 产出减面副本和 manifest，天空图由 `scripts/prep-t16-sky.mjs` 产出（WebP）；天空和氛围在网页端 `sky.ts`、`atmosphere.ts`，不进 GLB；辉光是选择性的，只取 `engine.ts` 中 `BLOOM_SOURCES` 登记的光源材质，新的发光材质要在那里登记，不能靠调亮度阈值；导出前构件穿插与同向共面检查须为零，新装饰须带碰撞或镜头遮挡），再运行 `bake_t16.py` 重烘光照贴图（清单 `pavilion-lightmaps.json` 记录了 GLB 哈希，忘记重烘单元测试会失败；导出关口还有全量碰撞审计，人能碰到的构件必须有碰撞），再运行 `node scripts/compress-t16.mjs` 生成网页实际加载的 `assets/t16/runtime/`（摆件实例化、meshopt、KTX2；GLB 只带 128 px 预览贴图，原尺寸贴图在 `runtime/textures/`、光照贴图另有 `-preview` 小图，进场画面出现后才下载原尺寸、角色和展品，首屏量用 `node scripts/first-screen-bytes.mjs` 测；网页不读源 GLB，忘记重压单元测试同样会失败），然后跑 `npm test`，提交前再跑 `npm run test:t10` 与 `npm run test:t15`（含 GLB 射线对照、镜头穿模为零）；不要改用渲染网格做碰撞或镜头遮挡。
- T15 第三人称：默认第三人称，`V` 切回第一人称；三个可行走场景右上角都有「角色」按钮，`C` 打开共用选角框（`game/CharacterPicker.tsx`），操作提示统一用 `WALK_HINT`；角色和视角只存本机浏览器；规则见 `docs/product/2026-11-09-第三人称角色接入.md`，验证见 `docs/validation/T15第三人称验证.md`。运行版角色 GLB 和选角缩略图由 `npm run build:characters` 从 `assets/characters/<id>/` 生成。
- 云端容器只有软件WebGL（约1帧/秒），性能与实走结论以用户M5/Chrome为准。

## T09 本地验收
- AC01～AC51 的逐项证据见 `docs/validation/MVP验收结果.md`。主链路复用真实任务，恢复副本用于测试写入、并发和高DPR布置。真实十人试用与物理休眠中的在途恢复单独记录。

## T06 正式账号与生成
- T06实际证据见 `docs/validation/账号资产生成验证.md`；背包使用正式 session、额度、任务和资产 API，T11 将入口迁入小屋。T07 实现保存和分享，T08 实现投稿策展。
- worker真实create前必须持久dispatch_started与报价承诺；未知提交不重发，精确nonce证据恢复，失租/终态不可发布；失败原日唯一refund。运维只查原任务的工具为 `scripts/generation-diagnose.mjs`。
- 模型ready前必须真Chrome渲染及同SHA落存，工程资源预算见数据契约第8节；不能以GLB头或供方成功代替。私有APP_DATA_KEY生成一次跨进程复用，备份须保存实际配置key。

## T07 正式小屋与分享
- 正式入口`/room`和`/shared/:token`，几何/DTO在contracts的scene.ts与room.ts；新布局用真实资产UUID和各自bounds，禁止套用T04固定AssetId字典。验证见 `docs/validation/小屋分享验证.md`。
- 正式小屋摆放与庭院行走共用 `packages/contracts/src/room.ts` 的庭院尺寸，T04 实验边界仍独立。主人参观和分享使用相同的摆放碰撞盒与跳跃规则。
- 全视口3D与墨底金线HUD不变，物品库/列表是按需覆盖抽屉，不能用旧T04常驻侧栏挤压画布。
- 布局保存必须CAS/immutable版本/同键回执原子提交，锁序user→排序旧新assets→room。丢响应保留原key/body，旧ACK不得回弹当前拖动或误认后续草稿已保存。会话过期暂停写入，同账号重新登录后可继续确认原请求。
- 分享稳定token加密、grant256bit摘要/原版/epoch隔离，文件有grant头就不能回退cookie扩大权限；关闭/重开不复活旧grant。源删除后的完整布局/展陈清理由T08负责。
- T14 目录纳入全部开启分享的小屋，登录后可浏览。点赞按房间和访客账号唯一且不可撤销，使用会话及当前分享凭证，关分享后下榜并拒绝旧凭证写入。契约见数据契约第 13 节。
- 官方物品（界面名，接口与 source_type 仍为 furniture）源与 manifest 在 assets/furniture，构建/幂等导入用 scripts/build-furniture.mjs 和 seed-furniture.mjs；清单不再列出的系统物品会被风险删除并移出所有布局。系统来源记录不能登录，不替代正常管理员种子。
- T17 小屋：九宫格草地（台基为中格）加外圈木栅栏；建筑、庭院、行走和编辑器防穿模共用 `apps/web/src/room/layout.ts`，改几何先改这里；贴图复用 T16 的 CC0 集（`room/textures.ts`）。可穿行物品由资产 `walk_through` 决定。T19 物品间碰撞与叠放只在编辑器（`room/navigation.ts` 的 `supportUnder`/`ridersOf`/`itemConflict`）：中心落在占地不小于它的物品上方即叠放，上层随下层移动，与其他物品重叠整组弹回；服务端不校验重叠，旧布局照常可存。截图核对用 `node scripts/t17-room-shots.mjs`（临时库）。高度上限由 `roomPlacementCeiling` 按位置区分：压在台基上的物品以房梁 4.8 m 为顶，纯庭院的物品顶为三座房子高（20.6 m），屋檐算编辑器障碍。改了 `packages/contracts` 的导出，跑 `npm test` 前先 `npm run build:core`。

## T08 投稿、后台与展陈
- 实现入口 `apps/api/src/curation.ts`、`apps/web/src/admin/`、首页 `game/Game.tsx`/`engine.ts`；合同第10节，验证见 `docs/validation/后台展陈验证.md`。
- 会话复核用户行锁为FOR NO KEY UPDATE，同一行一个事务只UPDATE一次，避免外键KEY SHARE引发死锁；意外错误按requestId写服务端日志。
- 加引用（保存房间、审核、发布展位）必须先锁asset；删除（后台与 T18 本人删除共用 `riskDelete`）锁asset→房间→gallery并推进版本。会被本次写入改变的存在性检查放在写入体内（回执查找之后），不放 `authorize`，否则同键重放会变 404。过期草稿含已删模型返回409，展陈grant详情/文件只看该展品是否ready。
- 展陈槽n=布局标记T0n，展品用 `exhibitFit` 自动居中落台；不加手动高度/旋转/缩放。展品加载后以世界包围盒加入行走碰撞（`exhibitCollider`，人若被包住由 `freePlayer` 移到附近空位）；E 目标射线没命中时，按脚下同层、2.5 m 以内、40° 朝向且不隔墙选取（`TARGET_FACING`）。E 详情预览借用场景里已加载的同一模型（`engine.borrowExhibit`，共用资源，关闭时不释放），不重复下载展品文件，`test:t15` 断言这一点。浏览器回归 `npm run test:t08` 只用临时库。
- T20 模型三角面上限 35 万（`MODEL_TRIANGLE_LIMIT`），模型本身和按节点展开后各算一次；glTF 扩展只放行 `ALLOWED_MODEL_EXTENSIONS` 里四个材质参数扩展（高光、折射率、自发光强度、贴图变换），压缩及其他扩展仍拒绝。后台导入校验失败时抛 `ModelRejection`，中文原因在抛出处写好，worker 原样存进 `asset_imports.error_detail`，后台上传历史直接显示；Chrome、存储等环境异常重试 3 次后记为 `VALIDATOR_ERROR`，不算模型不合格。新加的校验规则必须给出能看懂的原因。契约第16节，截图核对用 `node scripts/t20-import-history-shots.mjs`（临时库）。
- T21 候选与展位页先选藏品：左侧候选列表默认选中首件、右侧预览，「安排展位」面板按 `pavilion-layout.json` 的档位分组；选已被占用的展位即替换，多处修改一次「保存并发布」；截图核对用 `node scripts/t21-gallery-shots.mjs`（临时库）。
