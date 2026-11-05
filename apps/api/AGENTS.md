# API 模块入口

先读根级 [AGENTS.md](../../AGENTS.md)、[计划](../../flow/plan.md) 和进展顶部。

- 职责：Fastify API与打包Web静态入口；含health与显式开启的本机T04隔离实验服务。实验文件状态不得写入主业务库，不代替正式账号/PG事务。
- 命令：`npm run dev -w @aholo/api / npm run build -w @aholo/api`（从项目根执行）。
- 约束：默认回环绑定；健康输出仅已知依赖状态，不泄露磁盘、SQL或凭证。未来业务授权由API执行，不能只靠UI。
- 总体合同：`../../docs/contracts/数据与接口契约.md`；控制层与内容层共用根级 flow/docs，不在本目录重复建立。
