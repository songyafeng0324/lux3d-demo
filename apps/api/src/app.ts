import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { loadConfig, createPool, LocalFileStore, BusinessError } from '@aholo/domain';
import type { ApiEnvelope, ApiErrorEnvelope, ReadinessData } from '@aholo/contracts';
import { registerT04Lab } from './t04.js';
import { registerBusinessRoutes } from './business.js';

export async function buildApp(config = loadConfig()) {
  const pool = createPool(config.databaseUrl);
  const store = new LocalFileStore(config.dataDir);
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    disableRequestLogging: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BusinessError) {
      const {currentVersion,fields}=error as BusinessError & {currentVersion?:number;fields?:string[]};
      return reply.code(error.status).send({error:{code:error.code,message:error.message,...(Number.isSafeInteger(currentVersion)?{currentVersion}: {}),...(Array.isArray(fields)?{fields}:{})},requestId:request.id});
    }
    const clientStatus = (error as {statusCode?:number}).statusCode;
    if (clientStatus && [400,413,415,422].includes(clientStatus)) {
      return reply.code(clientStatus).send({error:{code:clientStatus===413?'FILE_TOO_LARGE':'INVALID_INPUT',message:clientStatus===413?'文件过大':'请求内容不正确'},requestId:request.id});
    }
    // Unexpected failures are logged server-side with the requestId (never returned to the client).
    request.log.error({ err: error, requestId: request.id, route: request.routeOptions?.url }, 'unhandled request error');
    const body: ApiErrorEnvelope = {
      error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' },
      requestId: request.id,
    };
    reply.code(500).send(body);
  });

  // Failures remain visible through readiness; liveness is available for diagnosis.
  await store.initialize().catch(() => undefined);
  app.addHook('onClose', async () => { await pool.end(); });
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
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
      pool.query<{ alive: boolean; generation: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM worker_heartbeats WHERE last_seen > now() - interval '10 seconds') AS alive, EXISTS (SELECT 1 FROM worker_heartbeats WHERE generation_enabled AND last_seen > now() - interval '10 seconds') AS generation",
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
        generationReady: ready && config.generationEnabled && config.lux3dConfigured && worker.status === 'fulfilled' && worker.value.rows[0]?.generation === true,
        checkedAt: new Date().toISOString(),
        checks,
        generation: { configured: config.lux3dConfigured, stage: config.generationEnabled ? 'integrated' : 'disabled' },
      },
      requestId: request.id,
    };
  });

  await registerBusinessRoutes(app, { pool, store, config });

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

  return app;
}
