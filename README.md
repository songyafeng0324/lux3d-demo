# 藏宝阁与个人小屋

用于项目开发与需求管理。T05本地基础工程、T03真实单图接入、T04场景技术样本已验证；T10已交付二层古阁建筑框架（T10-B）和全屏第一人称参观前台（T10-C）。账号、生成、小屋、投稿等正式业务将在T06～T08接入。

## 从这里开始
当前在MacBook本地开发，云资源、区域和预算暂缓。完整启动、停止、管理员种子、测试和备份步骤见 [本地运行说明](docs/本地运行.md)。

1. 根目录执行 `npm ci`、`npm run local:setup`、`npm run dev`，打开 [localhost:5173](http://localhost:5173/) 即进入全屏藏宝阁；在藏宝阁菜单打开个人小屋，在小屋打开背包。服务状态见 [健康接口](http://localhost:5173/api/v1/health/ready)。
2. 用 [T02 技术方案](docs/architecture/MVP技术方案.md)、[数据/API 契约](docs/contracts/数据与接口契约.md) 和 [验收计划](docs/validation/MVP验收计划.md) 指导实现。
3. 打开 [T04场景验证页](http://localhost:5173/lab/t04)，体验家具和真实模型编辑、自动保存、第一人称及30展位。正式业务按T06～T09推进。

T10进度见 [沉浸式MVP实施计划](docs/architecture/沉浸式MVP实施计划.md)、[T10-B建筑框架验证](docs/validation/T10-B建筑框架验证.md) 与 [T10-C游戏前台验证](docs/validation/T10-C游戏前台验证.md)。下一步按计划进入T06正式账号与生成。

## 导航
- [PRD v2.0](docs/product/藏宝阁与个人小屋-MVP-PRD-v2.0.md)
- [文档索引与需求流转](docs/README.md)
- [协作约定](AGENTS.md)（`CLAUDE.md` 为同源软链）
- [进展与交接](flow/进展.md)
- [设计方向](DESIGN.md)

`flow/` 是唯一控制层，`docs/` 是集中内容层。代码按 apps/web、apps/api、apps/worker 与 packages/domain、packages/contracts 分工，共用根级协作入口。

## 开源说明与许可证
- 代码以 [MIT 许可证](LICENSE) 开源。线上体验：https://yafeng.fun 。
- `.env`、数据库与凭证不在仓库内；复制 `.env.example` 后运行 `npm run local:setup` 生成本机私有配置，生成功能需要自己的 Lux3D API key。
- 第三方素材：`assets/t16/textures/polyhaven/` 为 Poly Haven 的 CC0 贴图；Lux3D 生成的模型与 `assets/characters/` 下的角色形象（含动漫形象）不属于 MIT 授权范围，版权归各自权利人所有，仅用于参赛演示与学习。权利人如有异议，请通过 Issue 联系，将及时移除。
- 六角色离线预览（`assets/characters/six-character-preview/`，225 MB）未入库，各角色 GLB 已在 `assets/characters/<id>/`。
