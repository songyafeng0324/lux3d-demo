# 藏宝阁与个人小屋

用于项目开发与需求管理。T05本地基础工程已跑通，网页/API/worker、PostgreSQL和私有存储可运行。T03已验证真实单图和隔离入库，T04场景编辑、保存和性能技术样本也已验证，正式业务功能将在后续任务接入。

## 从这里开始
当前在MacBook本地开发，云资源、区域和预算暂缓。完整启动、停止、管理员种子、测试和备份步骤见 [本地运行说明](docs/本地运行.md)。

1. 根目录执行 `npm ci`、`npm run local:setup`、`npm run dev`，打开 [localhost:5173](http://localhost:5173/)。
2. 用 [T02 技术方案](docs/architecture/MVP技术方案.md)、[数据/API 契约](docs/contracts/数据与接口契约.md) 和 [验收计划](docs/validation/MVP验收计划.md) 指导实现。
3. 打开 [T04场景验证页](http://localhost:5173/lab/t04)，体验家具和真实模型编辑、自动保存、第一人称及30展位。正式业务按T06～T09推进。

当前按用户要求只准备计划与环境，实施尚未启动。详见 [沉浸式MVP实施计划](docs/architecture/沉浸式MVP实施计划.md) 和 [Blender/MCP环境记录](docs/validation/Blender与MCP环境准备.md)。

用户明确开始后，可按以下入口接续：

> 开始 T10，先做游戏式全屏3D与Blender MCP二层古阁框架，再按计划接入全部MVP功能。

## 导航
- [PRD v2.0](docs/product/藏宝阁与个人小屋-MVP-PRD-v2.0.md)
- [文档索引与需求流转](docs/README.md)
- [协作约定](AGENTS.md)（`CLAUDE.md` 为同源软链）
- [进展与交接](flow/进展.md)
- [设计方向](DESIGN.md)

`flow/` 是唯一控制层，`docs/` 是集中内容层。代码按 apps/web、apps/api、apps/worker 与 packages/domain、packages/contracts 分工，共用根级协作入口。

项目级Hook文件已安装；Codex最终回复前主动自检，Stop静默放行。Git本地main仓库已初始化，依赖由package-lock锁定；当前尚未提交，业务验收未完成。
