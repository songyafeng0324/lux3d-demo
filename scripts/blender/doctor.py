"""Read-only Blender MCP environment check. Never executes modeling code."""
import asyncio
import hashlib
import json
import os
import subprocess
from importlib.metadata import version
from pathlib import Path
from datetime import datetime, timezone
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path.home() / 'Library/Application Support/aholo-lux3d/blender-mcp'
SERVER = ROOT / '.venv/bin/mcp-for-blender'
EVIDENCE = Path(__file__).resolve().parents[2] / 'docs/validation/evidence/Blender-MCP环境.json'

async def main():
    env = dict(os.environ)
    env['BLENDER_MCP_DISABLE_TELEMETRY'] = '1'
    params = StdioServerParameters(command=str(SERVER), args=['--host', '127.0.0.1', '--port', '9876'], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            listed = await session.list_tools()
            schema = next((t for t in listed.tools if t.name == 'get_scene_info'), None)
            if schema is None:
                raise RuntimeError('Read-only scene-info tool unavailable')
            required = schema.inputSchema.get('required', [])
            args = {}
            for name in required:
                if name != 'user_prompt':
                    raise RuntimeError('Unexpected required read-only argument: ' + name)
                args[name] = 'Read-only environment connectivity check. Do not create or modify any object.'
            result = await session.call_tool(schema.name, args)
            if result.isError:
                raise RuntimeError('Blender read-only scene check failed')
            content = [item.text for item in result.content if getattr(item, 'type', None) == 'text']
            if not content:
                raise RuntimeError('Empty scene-info response')
            parsed = []
            for item in content:
                try:
                    parsed.append(json.loads(item))
                except json.JSONDecodeError:
                    if item.lstrip().lower().startswith(('error:', 'error getting')):
                        raise RuntimeError('Scene-info response reports an error')
                    parsed.append({'text': item})
            # Preserve the real schema and response locally; no simulated call IDs.
            (ROOT / 'read-only-tool-schema.json').write_text(json.dumps(schema.model_dump(), ensure_ascii=False, indent=2))
            (ROOT / 'read-only-response.json').write_text(json.dumps(parsed, ensure_ascii=False, indent=2))
            report = {
                'checkedAt': datetime.now(timezone.utc).isoformat(),
                'result': 'PASS',
                'transport': 'MCP stdio -> local Blender addon TCP 127.0.0.1:9876',
                'mcpServer': initialized.serverInfo.model_dump(),
                'blenderVersion': subprocess.check_output([str(Path.home() / 'Applications/Blender.app/Contents/MacOS/Blender'), '--version'], text=True).splitlines()[0],
                'mcpPackageVersion': version('mcp-for-blender'),
                'mcpSdkVersion': version('mcp'),
                'toolCount': len(listed.tools),
                'availableTools': [tool.name for tool in listed.tools],
                'modelingToolAvailable': any(tool.name == 'execute_blender_code' for tool in listed.tools),
                'readOnlyTool': schema.name,
                'readOnlyArguments': args,
                'sceneResponse': parsed,
                'modelingExecuted': False,
                'applicationCodeChanged': False,
            }
            EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
            EVIDENCE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'result': 'PASS', 'tools': len(listed.tools), 'readOnlyTool': schema.name, 'modelingExecuted': False}))

if __name__ == '__main__':
    asyncio.run(main())
