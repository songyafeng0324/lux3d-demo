# Blender与MCP环境准备

2026-11-04（Asia/Tokyo）。范围为已批准的环境安装、配置和只读连通验证，**没有制作建筑、生成GLB或修改网页/导航业务**。

## 已完成

| 项目 | 实际状态 |
|---|---|
| Blender | 官方4.5.9 LTS，Apple Silicon；安装在 `~/Applications/Blender.app`，可执行版本检查通过 |
| 安装包校验 | SHA256与官方发布摘要一致：`e3a3d7aac381fb4e4d05197f99cd8899484d7e8bc4497c134066e6733f372238` |
| Python | 独立CPython3.12.14运行环境，不改项目Node依赖 |
| MCP适配器 | 社区 `mcp-for-blender==2.2.7`，MCP Python SDK1.30.0 |
| Blender插件 | 同包bundled addon，protocol15；已启用，启动Blender自动监听本机127.0.0.1:9876 |
| Codex配置 | 项目级 `.codex/config.toml`，保留已有hooks.json；不修改用户全局config.toml |
| MCP真实连通 | 完成initialize、tools/list和只读get_scene_info；9个工具可发现，execute_blender_code建模工具存在但未调用 |
| 场景状态 | 新安装Blender默认Cube/Camera/Light，共3个对象；没有创建项目模型或保存项目.blend |
| 调用证据 | `evidence/Blender-MCP环境.json`，实际返回与版本记录；未伪造工具或调用ID |

`mcpServer.version`由SDK返回为1.30.0，不应误当作社区包版本；实际包版本另列为2.2.7。MCP get_scene_info的内部实现会执行只读bpy查询代码；本轮未调用建模工具，没有增删对象。

## 位置与启动

- 应用：`~/Applications/Blender.app`
- 独立运行环境：`~/Library/Application Support/aholo-lux3d/blender-mcp/.venv/`
- Blender插件：`~/Library/Application Support/Blender/4.5/scripts/addons/blender_mcp.py`
- 环境探针：项目内 `scripts/blender/doctor.py`，只允许列工具和读场景，不含创建/修改/导出建模指令。
- MCP连接配置只在本项目生效。当前聊天未动态出现原生MCP工具时，独立MCP客户端已经验证连通；下次加载受信任项目后可读取配置。已写配置不等于声称本聊天工具菜单已热加载。

从项目根目录复查：

```bash
open -g -a "$HOME/Applications/Blender.app"
"$HOME/Library/Application Support/aholo-lux3d/blender-mcp/.venv/bin/python" scripts/blender/doctor.py
```

Blender关闭或电脑睡眠后桥接不持续运行；重新打开Blender再做只读检查。9876只监听127.0.0.1，不需要公网端口。当前环境准备未调用任何付费生成服务，第三方素材/生成集成未开启。

## 保持的执行边界

用户最新明确“先写好计划、准备好环境、先不动手”。因此T10-A/B/C与T06～T09均未启动；没有改默认路由、实现全屏HUD、添加导航算法或创建建筑。此前启动的两个实现工作流已中断，检查未新增apps/web/src/game、gallery.ts或对应测试，App.tsx与contracts导出保持原状。

不需要为文档和安装环境运行全套业务测试；本轮验证是官方摘要、实际可执行版本、插件启动、真实MCP工具发现及只读查询。详细实施顺序见 [沉浸式MVP实施计划](../architecture/沉浸式MVP实施计划.md)。

## 来源

- [Blender官方4.5发布目录](https://download.blender.org/release/Blender4.5/) 与 [4.5.9 SHA256](https://download.blender.org/release/Blender4.5/blender-4.5.9.sha256)。
- [MCP for Blender源码与安装说明](https://github.com/ahujasid/blender-mcp)，社区集成，与Blender官方产品区分。
- [OpenAI官方Codex MCP配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，项目级STDIO配置与配置加载规则。
