import { loadConfig } from '@aholo/domain';
import { buildApp } from './app.js';

const config = loadConfig();
const app = await buildApp(config);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
} catch {
  console.error('API 启动失败，请检查本地端口和配置。');
  await close();
  process.exitCode = 1;
}
