# Web 模块入口

先读根级 [AGENTS.md](../../AGENTS.md)、[计划](../../flow/plan.md) 和进展顶部。

- 职责：React/Vite 页面与场景交互入口；含本地健康工作台与/lab/t04场景实验；场景来源和边界见根级场景方案。实验不冒充正式账号/PG业务。
- 命令：`npm run dev -w @aholo/web / npm run build -w @aholo/web`（从项目根执行）。
- 约束：本地开发端口5173，/api代理至127.0.0.1:3001；页面不可读取私有磁盘、供应商密钥或用假状态声称业务完成。
- 总体合同：`../../docs/contracts/数据与接口契约.md`；控制层与内容层共用根级 flow/docs，不在本目录重复建立。
