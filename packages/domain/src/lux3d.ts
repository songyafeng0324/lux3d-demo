import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CN_ORIGIN = 'https://api.aholo3d.cn';
const INT64_MAX = 9223372036854775807n;
type JsonObject = Record<string, unknown>;
type Version = 'G1' | 'G1-Turbo';
export type MeshFormat = 'zip' | 'glb' | 'ply';
export interface MeshProfile { version: Version; outputFormat: MeshFormat[] }
export interface ImageTaskParams extends MeshProfile {
  img: string;
  faceCount: number;
  enablePbr?: boolean;
  aiPredictSize?: boolean;
}
export interface Lux3dTask { taskId: string; status: 0 | 1 | 3 | 4 | 6; outputs?: Array<{ content?: string | null }> }
export interface TaskListParams { page?: number; pageSize?: number; status?: 0 | 1 | 3 | 4; starttime?: number; endtime?: number }
export interface TaskListResult {
  items: Array<{ taskId: string; status: Lux3dTask['status']; created?: number; lastModified?: number }>;
  total: number;
  page: number;
  pageSize: number;
}
export type Lux3dErrorCode = 'configuration_invalid' | 'input_invalid' | 'upload_error' | 'upload_pending'
  | 'submission_rejected' | 'submission_unknown' | 'query_error' | 'output_not_ready' | 'output_invalid';

// Errors deliberately carry no response bodies, request URLs, keys, or signed links.
export class Lux3dTransportError extends Error {
  constructor(readonly code: Lux3dErrorCode, readonly operation: string, readonly httpStatus?: number) {
    super(`Lux3D ${operation}: ${code}`);
    this.name = 'Lux3dTransportError';
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
  return value as JsonObject;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('integer');
  return value;
}
function taskId(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/.test(text) || BigInt(text) > INT64_MAX) throw new Error('id');
  return text;
}
function uploadIdentifier(raw: JsonObject): string {
  // Live OUS uses obsTaskId, while the published schema calls it taskId.
  const value=raw.taskId ?? raw.obsTaskId;
  if(typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u0020]/.test(value))return value;
  return taskId(value);
}
function state(value: unknown): Lux3dTask['status'] {
  if (![0, 1, 3, 4, 6].includes(value as number)) throw new Error('status');
  return value as Lux3dTask['status'];
}
function safeJson(text: string): unknown {
  // Node 24 supplies primitive source text before IEEE-754 rounding. Do not use
  // Response.json(): a rounded task ID can accidentally query the wrong task.
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?[0-9]+$/.test(context.source)) throw new Error('unsafe integer');
      return context.source;
    }
    return value;
  });
}
function trustedUrl(value: unknown, originOnly = false, result = false): URL {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('url');
  const url = new URL(value);
  const trusted = ['kujiale.com', 'aholo3d.cn'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    || (result && url.hostname === 'tx-qhsmodel-1258830046.cos.ap-shanghai.myqcloud.com');
  if (url.protocol !== 'https:' || !trusted || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('url');
  if (originOnly && (url.pathname !== '/' || url.search)) throw new Error('origin');
  return url;
}
function validateProfile(profile: MeshProfile): void {
  if (profile.version !== 'G1' && profile.version !== 'G1-Turbo') throw new Error('version');
  if (!Array.isArray(profile.outputFormat) || !profile.outputFormat.length || new Set(profile.outputFormat).size !== profile.outputFormat.length
    || profile.outputFormat.some((format) => !['zip', 'glb', 'ply'].includes(format))) throw new Error('formats');
  // This MVP's Turbo contract deliberately narrows the provider's broader API.
  if (profile.version === 'G1-Turbo' && (profile.outputFormat.length !== 1 || profile.outputFormat[0] !== 'glb')) throw new Error('turbo formats');
}

export class Lux3dCnClient {
  #apiKey: string;
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (typeof options.apiKey !== 'string' || !options.apiKey || /\s/.test(options.apiKey) || /^bearer/i.test(options.apiKey)) {
      throw new Lux3dTransportError('configuration_invalid', 'configure');
    }
    const timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw new Lux3dTransportError('configuration_invalid', 'configure');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = timeout;
  }

  async #request(url: URL, init: RequestInit, operation: string, create = false): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const defaultCode = create ? 'submission_unknown' : operation.startsWith('upload') ? 'upload_error' : 'query_error';
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
          if (!response.ok) {
            // Only the documented gateway authentication rejection establishes
            // non-acceptance here. 409/429 and unfamiliar gateway errors do not.
            const code = create && response.status === 401 ? 'submission_rejected' : defaultCode;
            throw new Lux3dTransportError(code, operation, response.status);
          }
          const body = await response.text();
          if (body.length > 4 * 1024 * 1024) throw new Error('response too large');
          return safeJson(body);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Lux3dTransportError(defaultCode, operation)); }, this.#timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof Lux3dTransportError) throw error;
      throw new Lux3dTransportError(defaultCode, operation);
    } finally { if (timer) clearTimeout(timer); }
  }

  #authorization(): HeadersInit { return { Authorization: this.#apiKey }; }
  #envelope(value: unknown, operation: string, create = false): unknown {
    const code = create ? 'submission_unknown' : operation.startsWith('upload') ? 'upload_error' : 'query_error';
    try {
      const body = object(value);
      if (typeof body.c !== 'string' || !body.c || (!Object.hasOwn(body, 'd')&&operation!=='upload_part')) throw new Error('envelope');
      if (body.c !== '0') {
        const confirmedRejection=create&&['-1','GENERATION_CONCURRENCY_LIMIT_EXCEEDED'].includes(body.c);
        throw new Lux3dTransportError(confirmedRejection?'submission_rejected':code, operation);
      }
      if (body.f !== undefined && body.f !== null) throw new Error('inconsistent success');
      return body.d;
    } catch (error) {
      if (error instanceof Lux3dTransportError) throw error;
      throw new Lux3dTransportError(code, operation);
    }
  }

  async quoteImageTask(params: ImageTaskParams): Promise<{quoteId:string;credits:number;expiresAt:string}> {
    validateProfile(params);
    const account=object(this.#envelope(await this.#request(new URL('/lux3d/v1/account/balance?source=1',CN_ORIGIN),{headers:this.#authorization()},'account'),'account'));
    if(typeof account.uniqueId!=='string'||typeof account.uniqueIdExpiresAt!=='string'||Date.parse(account.uniqueIdExpiresAt)<=Date.now())throw new Lux3dTransportError('query_error','quote');
    const body={source:1,uniqueId:account.uniqueId,items:{'1':{endpoint:{method:'POST',path:'/lux3d/v1/generate/img-to-3d/task/create'},parameters:{pathParameters:'{}',queryParameters:'{}',body:JSON.stringify(params)}}}};
    const q=object(this.#envelope(await this.#request(new URL('/lux3d/v1/pricing/openapi-quotes',CN_ORIGIN),{method:'POST',headers:{...this.#authorization(),'Content-Type':'application/json'},body:JSON.stringify(body)},'quote'),'quote'));
    const credits=integer(q.estimatedCreditsTotal,0),details=object(q.details);
    if(q.source!==1||q.uniqueId!==account.uniqueId||q.pricingScope!=='BEFORE_ACCOUNT_BENEFITS'||typeof q.quoteId!=='string'||!/^quote_[a-zA-Z0-9_-]+$/.test(q.quoteId)||typeof q.expiresAt!=='string'||!Number.isFinite(Date.parse(q.expiresAt))||Date.parse(q.expiresAt)<=Date.now()||Object.keys(details).length!==1||details['1']!==credits)throw new Lux3dTransportError('query_error','quote');
    return {quoteId:q.quoteId,credits,expiresAt:q.expiresAt};
  }

  async createImageTask(params: ImageTaskParams): Promise<string> {
    let body: string;
    try {
      validateProfile(params);
      const raw = params as unknown as JsonObject;
      if ('imgs' in raw || Object.keys(raw).some((key) => !['img', 'version', 'faceCount', 'outputFormat', 'enablePbr', 'aiPredictSize'].includes(key))) throw new Error('single image only');
      const img = trustedUrl(params.img).href;
      integer(params.faceCount, 10000, 300000);
      if (params.enablePbr !== undefined && typeof params.enablePbr !== 'boolean') throw new Error('pbr');
      if (params.aiPredictSize !== undefined && typeof params.aiPredictSize !== 'boolean') throw new Error('size');
      body = JSON.stringify({ ...params, img });
    } catch { throw new Lux3dTransportError('input_invalid', 'create'); }
    const response = await this.#request(new URL('/lux3d/v1/generate/img-to-3d/task/create', CN_ORIGIN), {
      method: 'POST', headers: { ...this.#authorization(), 'Content-Type': 'application/json' }, body,
    }, 'create', true);
    const data = this.#envelope(response, 'create', true);
    try { return taskId(data); } catch { throw new Lux3dTransportError('submission_unknown', 'create'); }
  }

  async getTask(id: string): Promise<Lux3dTask> {
    let validatedId: string;
    try { validatedId = taskId(id); } catch { throw new Lux3dTransportError('input_invalid', 'get_task'); }
    const url = new URL('/lux3d/v1/generate/task/get', CN_ORIGIN);
    url.searchParams.set('taskid', validatedId);
    const data = this.#envelope(await this.#request(url, { headers: this.#authorization() }, 'get_task'), 'get_task');
    try {
      const raw = object(data);
      const result: Lux3dTask = { taskId: taskId(raw.taskId), status: state(raw.status) };
      if (result.taskId !== validatedId) throw new Error('task mismatch');
      if (raw.outputs !== undefined) {
        if (!Array.isArray(raw.outputs)) throw new Error('outputs');
        result.outputs = raw.outputs.map((item) => {
          const output = object(item);
          if (output.content !== undefined && output.content !== null && typeof output.content !== 'string') throw new Error('content');
          return { content: output.content as string | null | undefined };
        });
      }
      return result;
    } catch { throw new Lux3dTransportError('query_error', 'get_task'); }
  }

  async listTasks(params: TaskListParams = {}): Promise<TaskListResult> {
    const url = new URL('/lux3d/v1/generate/task/list', CN_ORIGIN);
    try {
      if (Object.keys(params).some((key) => !['page', 'pageSize', 'status', 'starttime', 'endtime'].includes(key))) throw new Error('params');
      url.searchParams.set('page', String(integer(params.page ?? 1, 1)));
      url.searchParams.set('pagesize', String(integer(params.pageSize ?? 20, 1, 100)));
      if (params.status !== undefined) {
        if (![0, 1, 3, 4].includes(params.status)) throw new Error('filter');
        url.searchParams.set('status', String(params.status));
      }
      for (const key of ['starttime', 'endtime'] as const) if (params[key] !== undefined) url.searchParams.set(key, String(integer(params[key], 0)));
      if (params.starttime !== undefined && params.endtime !== undefined && params.endtime <= params.starttime) throw new Error('time bounds');
    } catch { throw new Lux3dTransportError('input_invalid', 'list_tasks'); }
    const data = this.#envelope(await this.#request(url, { headers: this.#authorization() }, 'list_tasks'), 'list_tasks');
    try {
      const raw = object(data);
      if (!Array.isArray(raw.items)) throw new Error('items');
      return {
        items: raw.items.map((item) => {
          const row = object(item);
          return { taskId: taskId(row.taskId), status: state(row.status),
            ...(row.created !== undefined ? { created: integer(row.created, 0) } : {}),
            ...(row.lastModified !== undefined ? { lastModified: integer(row.lastModified, 0) } : {}) };
        }),
        total: integer(raw.total, 0), page: integer(raw.page, 1), pageSize: integer(raw.pageSize, 1, 100),
      };
    } catch { throw new Lux3dTransportError('query_error', 'list_tasks'); }
  }

  parseMeshOutputs(result: Lux3dTask, profile: MeshProfile): Array<{ format: MeshFormat; url: string }> {
    if (result.status !== 3) throw new Lux3dTransportError('output_not_ready', 'parse_outputs');
    try {
      validateProfile(profile);
      const expected: MeshFormat[] = profile.version === 'G1' ? ['zip', 'glb', ...(profile.outputFormat.includes('ply') ? ['ply' as const] : [])] : ['glb'];
      if (!Array.isArray(result.outputs) || result.outputs.length !== expected.length) throw new Error('slots');
      return expected.map((format, index) => ({ format, url: trustedUrl(result.outputs![index]?.content, false, true).href }));
    } catch { throw new Lux3dTransportError('output_invalid', 'parse_outputs'); }
  }

  async uploadFile(filePath: string): Promise<{ url: string; taskId: string; md5: string; byteSize: number }> {
    let bytes: Buffer;
    try {
      const file = await open(filePath, 'r');
      try { if (!(await file.stat()).isFile()) throw new Error('not a file'); bytes = await file.readFile(); } finally { await file.close(); }
      if (!bytes.length) throw new Error('empty file');
    } catch { throw new Lux3dTransportError('input_invalid', 'upload_file'); }
    const operation = 'upload_file';
    try {
      const token = object(await this.#request(new URL('/asset/v1/token', CN_ORIGIN), { headers: this.#authorization() }, 'upload_token'));
      const origin = trustedUrl(token.globalDomain, true).origin;
      if (typeof token.ousToken !== 'string' || !token.ousToken || /\s/.test(token.ousToken)) throw new Error('token');
      const blockSize = integer(token.blockSize, 1);
      const headers = { 'ous-token-v2': token.ousToken };
      const md5 = createHash('md5').update(bytes).digest('hex');
      const filename = basename(filePath);
      let uploadId: string;
      if (bytes.length <= blockSize) {
        const form = new FormData(); form.set('md5', md5); form.set('file', new Blob([new Uint8Array(bytes)]), filename);
        const data = object(this.#envelope(await this.#request(new URL('/ous/api/v2/single/upload', origin), { method: 'POST', headers, body: form }, operation), operation));
        uploadId = uploadIdentifier(data);
      } else {
        const blocks = Math.ceil(bytes.length / blockSize);
        const init = new URL('/ous/api/v2/block/upload/init', origin);
        for (const [key, value] of Object.entries({ md5, blocks, size: bytes.length, name: filename })) init.searchParams.set(key, String(value));
        const data = object(this.#envelope(await this.#request(init, { method: 'POST', headers }, operation), operation));
        uploadId = uploadIdentifier(data);
        if (data.deduplicated !== true) {
          const missing = data.lackBlocks == null ? Array.from({ length: blocks }, (_value, index) => index + 1) : this.#missingBlocks(data.lackBlocks, blocks);
          for (const block of missing) {
            const form = new FormData(); form.set('block', String(block));
            form.set('file', new Blob([new Uint8Array(bytes.subarray((block - 1) * blockSize, Math.min(block * blockSize, bytes.length)))]), filename);
            this.#envelope(await this.#request(new URL('/ous/api/v2/block/upload/part', origin), { method: 'POST', headers, body: form }, 'upload_part'), 'upload_part');
          }
        }
      }
      const deadline = Date.now() + this.#timeoutMs;
      while (true) {
        const data = object(this.#envelope(await this.#request(new URL('/ous/api/v2/upload/status', origin), { headers }, 'upload_status'), 'upload_status'));
        if (data.status === 5) return { url: trustedUrl(data.url).href, taskId: uploadId, md5, byteSize: bytes.length };
        if (data.status === 6 || data.status === 8) throw new Lux3dTransportError('upload_error', 'upload_status');
        integer(data.status, 0, 8);
        if (Date.now() >= deadline) throw new Lux3dTransportError('upload_pending', 'upload_status');
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      if (error instanceof Lux3dTransportError) throw error;
      throw new Lux3dTransportError('upload_error', operation);
    }
  }

  #missingBlocks(value: unknown, blocks: number): number[] {
    if (!Array.isArray(value) || value.length > blocks) throw new Error('missing blocks');
    const missing = new Set<number>();
    for (const range of value) {
      if (typeof range !== 'string' || !/^[1-9][0-9]*(?:-[1-9][0-9]*)?$/.test(range)) throw new Error('block range');
      const [startText, endText = startText] = range.split('-');
      const start = integer(Number(startText), 1, blocks); const end = integer(Number(endText), start, blocks);
      for (let block = start; block <= end; block++) missing.add(block);
    }
    return [...missing].sort((left, right) => left - right);
  }
}
