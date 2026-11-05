# domain 模块约定

根规则见 ../../AGENTS.md；总体计划和交接仍在根 flow/，合同在根 docs/contracts/。

- 本模块只处理配置、数据库事务、私有存储和领域基础能力，不依赖 React 或 Lux3D 插件缓存。
- `npm run build -w @aholo/domain` 构建；从根目录 `npm test` 和 `npm run test:integration` 验证。
- 文件操作必须校验固定根身份、目录与对象键；提交重试使用稳定对象键和预期摘要，不能覆盖不同内容。
- 业务写入及未来供方dispatch都要遵守 MAINTENANCE_LOCK；不能绕过备份维护协议。
- seedAdmin 只创建不存在的管理员，不提升已有普通用户角色，不重置已有密码。
