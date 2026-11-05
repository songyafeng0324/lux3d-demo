import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { loadConfig, createPool, LocalFileStore } from '@aholo/domain';
import type { ApiEnvelope, ApiErrorEnvelope, ReadinessData } from '@aholo/contracts';
import { registerT04Lab } from './t04.js';

export async function buildApp(config = loadConfig()) {
  const pool = createPool(config.databaseUrl);
  const store = new LocalFileStore(config.dataDir);
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    disableRequestLogging: true,
  });

  // Failures remain visible through readiness; liveness is available for diagnosis.
  await store.initialize().catch(() => undefined);
  app.addHook('onClose', async () => { await pool.end(); });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.get('/api/v1/health/live', async (request): Promise<ApiEnvelope<{ status: 'ok'; service: string }>> => ({
    data: { status: 'ok', service: 'aholo-api' },
    requestId: request.id,
  }));

  app.get('/api/v1/health/ready', async (request, reply): Promise<ApiEnvelope<ReadinessData>> => {
    const [database, storage, worker] = await Promise.allSettled([
      pool.query('SELECT 1'),
      store.probe(),
      pool.query<{ alive: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM worker_heartbeats WHERE last_seen > now() - interval '10 seconds') AS alive",
      ),
    ]);
    const checks = {
      database: database.status === 'fulfilled' ? 'ok' : 'unavailable',
      storage: storage.status === 'fulfilled' ? 'ok' : 'unavailable',
      worker: worker.status === 'fulfilled' && worker.value.rows[0]?.alive ? 'ok' : 'unavailable',
    } as const;
    const ready = Object.values(checks).every((status) => status === 'ok');
    reply.code(ready ? 200 : 503);
    return {
      data: {
        ready,
        generationReady: false,
        checkedAt: new Date().toISOString(),
        checks,
        generation: { configured: config.lux3dConfigured, stage: 'pending_integration' },
      },
      requestId: request.id,
    };
  });

  if (process.env.AHOLO_T04_LAB === '1' && config.apiHost === '127.0.0.1') {
    await registerT04Lab(app, { stateDir: process.env.T04_LAB_STATE_DIR || undefined });
  }

  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const hasWebBuild = existsSync(new URL('../../web/dist/index.html', import.meta.url));
  if (hasWebBuild) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    let pathname = '';
    try { pathname = decodeURIComponent(request.url.split('?')[0] ?? '/'); } catch { /* Invalid URL remains a 404 JSON response. */ }
    const isApiPath = pathname === '/api' || pathname.startsWith('/api/');
    const wantsPage = request.headers.accept?.includes('text/html') === true;
    if (pathname && !isApiPath && !extname(pathname) && hasWebBuild && request.method === 'GET' && wantsPage) {
      return reply.sendFile('index.html');
    }
    const body: ApiErrorEnvelope = {
      error: { code: 'NOT_FOUND', message: '该接口或页面尚不可用' },
      requestId: request.id,
    };
    return reply.code(404).send(body);
  });
  app.setErrorHandler((_error, request, reply) => {
    const body: ApiErrorEnvelope = {
      error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' },
      requestId: request.id,
    };
    reply.code(500).send(body);
  });
  return app;
}
