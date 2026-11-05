# T03 · Lux3D 中国区接入契约 v0.1

日期：2026-11-04。适用本地 MVP；当前已验证一次真实单图闭环和独立验证库入库。网站账号/背包/任务调度由 T06 集成，不把本探针当正式站内验收。

## 来源与实现选择

权威字段以当日 [Asset 单服务 OpenAPI](https://labs.aholo3d.cn/api-docs/specifications/services/asset/openapi.json) 和 [Lux3D 单服务 OpenAPI](https://labs.aholo3d.cn/api-docs/specifications/services/lux3d/openapi.json) 为准；URL/hash/版本保存在 `sources/T03-source-index.json`。SDK审查来源保存在 `sources/T03-sdk-source-index.json`。

官方 TypeScript asset1.3.0/lux3d1.9.0/core1.3.0 不自动重试create，但其 response.json/number 类型会将9007199254740993读成9007199254740992。本站因此使用小范围安全transport，Node24用JSON.parse的原始数字source保留int64为字符串。测试覆盖精度边界；不以解析后String转换补救。SDK的进程内waitFor也不替代持久任务恢复。

实现入口：`packages/domain/src/lux3d.ts`。固定中国区 `https://api.aholo3d.cn`，仅向该网关传 raw Authorization，无Bearer前缀、不跨redirect转发。服务端通过环境变量或私有 `~/.config/lux3d/credentials.json` 的 apiKeys.cn 读取凭证，不复制密钥到仓库/浏览器DTO；loadConfig只返回配置是否存在。

## 上传协议（已实测）

1. GET `/asset/v1/token`，取得ousToken、globalDomain、blockSize；blockSize是分片阈值，不是产品上传上限。
2. 对globalDomain使用ous-token-v2，不能转发网关API key。域名限制在可信Aholo/kujiale域，HTTPS、不带userinfo、不跨重定向。
3. 小文件multipart包含file/md5；大文件init为POST，md5/blocks/size/name放URL query，再按序multipart发送block/file。
4. status=5且有URL才上传成功；6/8为上传终态失败。查询故障或超时只报告上传未完成，不标模型生成失败。

服务端实测与公开schema的差异：single/init返回obsTaskId，schema写taskId，兼容二者；分片part成功可只有c=0/m、没有d，仅upload_part允许这种ACK。create/query等需要数据的响应不能随之放宽。

实测10,053字节PNG单文件上传成功；另用合法PNG的tEXt辅助块把文件扩到5,242,897字节，超过当时5,242,880阈值，1次init/2个part上传成功。早期.bin工程fixture被服务端以c=3“文件格式异常”拒绝；这说明不能把上传器当作任意扩展名接受器。没有将拒绝的上传误记成功或发起生成。

## 创建与查询

| 操作 | 合同 |
|---|---|
| POST `/lux3d/v1/generate/img-to-3d/task/create` | 本站只传img，显式version，faceCount安全整数10000～300000，outputFormat；不开放imgs或用户参数入口 |
| GET `/lux3d/v1/generate/task/get?taskid=` | ID精确十进制字符串；c=0只是查询成功，status=3才是供方成功 |
| GET `/lux3d/v1/generate/task/list` | page/pagesize、status和Unix毫秒时间范围；按明确ID恢复，不凭相近时间把另一任务认作本任务 |

单服务schema描述的面数默认300000与旧插件200000不同，因此显式参数，不能继承旧默认。当前本轮验证配置为G1-Turbo、50000目标面、GLB、PBR启用、尺寸预测关闭；这是本次用户批准的工程样本配置，不是所有未来生成都获付费批准。旧插件customSize字段不进入当前请求。

G1按ZIP/GLB、可选PLY固定槽读取；本地初始Turbo适配范围只支持GLB单输出。运行中即使有部分outputs也不能入库。NOT_REQUESTED、缺槽或非HTTPS内容都不能作为可用文件。实测产物位于指定腾讯COS主机，只有结果解析额外允许该精确主机，不把整个myqcloud域开放给输入或上传凭证。

## 重试、未知提交与截止策略

create每次调用仅发一次。HTTP401及已核实的参数拒绝c=-1/并发拒绝可标submission_rejected；未识别业务码、409/429、5xx、超时、成功但无可靠ID都标submission_unknown，不自动再create。GET失败仅query_error，不改变真实任务终态。客户端错误不包含原始body、签名URL或密钥。

官方历史列表缺输入hash/client reference，当前没有可验证的服务端幂等键；**不能可靠自动识别丢失ID的创建请求**。未知提交保留attempt、参数摘要和费用承诺，供方并发占用隔离；只接受晚到ID证据或供应商/原始调用记录确认，不能用“时间接近且只有一个结果”自动认领。不新增网站人工修复平台，运维对账走记录/诊断工具。

工程恢复策略函数见 `packages/domain/src/recovery.ts`：先保留已有终态；已持久入包且可预览的已验证交付先成功结算；未交付才应用截止时间。初始交付窗口为24小时、可配置，属于异常终结初值，不是承诺生成24小时或可用性SLA。到期未交付则终结失败；T06须用任务锁/唯一事件在事务中仅冲销原提交日一次。供方状态未知时，本站任务可结束而供方占用/费用承诺仍保留，不假定取消/退款。已失败后迟到的产物不复活、不重复扣次/返还。

`deliveryVerified` 必须表示完整持久资产、可用渲染和可访问的入库结果均成立；仅供方status3或下载完成不够。此函数给决定，T06负责实际事务和worker调度，当前未声称生产调度已完成。

## 临时链接与持久化

官方结果URL有效期2小时。本轮确实遇到旧URL403“Request has expired”，对同一个taskId重新查询后取得不同且可下载的签名URL，没有新建任务。此为本次实测恢复证据，不承诺服务永远续签。优先立即落盘，签名URL只保存在私有记录。

下载回执绑定原providerTaskId、attemptId、参数hash、原图SHA、quoteId、输出槽、字节数和产物SHA；渲染证据也绑定同SHA。隔离入库核对这些记录、真实报价与预算承诺；重放再核对任务ID和原图，不凭另一GLB的渲染截图造交付证据。

验证库固定本机55432的 `aholo_lux3d_t03_validation`，写入前在实际连接核验IP/端口/数据库名及探针marker。忽略应用DATABASE_URL的目标库主机；不覆盖用户主应用数据。存储在Application Support的t03/store目录，已验证重复入库不重复建资产。

## 输入策略与关闭边界

本轮真实PNG输入及自包含GLB通过；模型约8.9MB、48,964三角面，只有一个样本，不能把这些值写成网站允许上限。JPEG/WebP及损坏图片、体积/纹理资源策略由T06校验并补测试；古建/边界/性能由T04验证。源模型没有外部纹理依赖，离线预览已实测旋转缩放。

工具命令见 `docs/本地运行.md`。probe CLI提供status/upload/query/download/ingest，没有create命令；新生成继续按实际方案/报价及已有授权执行。

## T06 正式链路增量（2026-11-05）

正式worker复用上述中国区适配器，系统统一极速版、50000目标面、GLB、PBR开启、尺寸预测关闭。create前GET account/balance必须带source=1，再对精确参数POST pricing/openapi-quotes；quote_id/committed_credits在dispatch_started同事务持久化，未知提交不清费用承诺。报价采用账户权益前口径，不宣称逐任务实际结算。

恢复入口 `scripts/generation-diagnose.mjs list/evidence/reconcile` 只查询原任务与记录明确证据；证据文件须来自原create响应或供方确认并携带原attemptId/dispatchNonce，不按时间或列表唯一性自动匹配。即使本站已失败，明确原ID的终态可释放供方占用，但不复活任务或资产。

工程资源上限与正式渲染判据见数据契约第8节；实际生成与用户批次授权证据见 `../validation/账号资产生成验证.md`。本次用户额外明确批准1个瓷瓶测试，最多1积分；这不授权Agent追加付费候选。
