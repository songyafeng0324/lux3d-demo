# Worker 模块入口

先读根级 [AGENTS.md](../../AGENTS.md)、[计划](../../flow/plan.md) 和进展顶部。

- 职责：持久生成/导入队列、心跳和恢复；遵守T03未知提交不重发及T06租约/原日退款/渲染交付合同。
- 命令：`npm run dev -w @aholo/worker / npm run build -w @aholo/worker`（从项目根执行）。
- 约束：不得把心跳正常写成任务处理已实现；真实生成与未知提交恢复须遵守根合同和T03证据。
- 总体合同：`../../docs/contracts/数据与接口契约.md`；控制层与内容层共用根级 flow/docs，不在本目录重复建立。
