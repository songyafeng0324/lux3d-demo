export type CheckStatus = 'ok' | 'unavailable';
export * from './scene.js';

export interface ReadinessData {
  ready: boolean;
  generationReady: false;
  checkedAt: string;
  checks: {
    database: CheckStatus;
    storage: CheckStatus;
    worker: CheckStatus;
  };
  generation: {
    configured: boolean;
    stage: 'pending_integration';
  };
}

export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorEnvelope {
  error: { code: string; message: string };
  requestId: string;
}
