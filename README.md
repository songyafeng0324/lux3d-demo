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

项目级Hook文件已安装；Codex最终回复前主动自检，Stop静默放行。Git本地main仓库已初始化，依赖由package-lock锁定；当前尚未提交，业务验收未完成。
