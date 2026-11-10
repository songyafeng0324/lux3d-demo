export interface User { id: string; username: string; nickname: string; role: 'user' | 'admin' }
export interface GenerationTask { id: string; status: 'processing' | 'succeeded' | 'failed'; submittedDay: string; createdAt: string; assetId: string | null; assetDeleted?: boolean; errorCode: string | null }
export interface Asset { id: string; name: string; description: string; modelFileId: string; originalImageId: string | null; createdAt: string; normalization: unknown; bounds: unknown; submissionApproved?: boolean }
export interface Me { user: User; roomId: string; quota: { day: string; total: number; used: number; available: number }; activeTask: GenerationTask | null; csrfToken: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', ...options }); }
  catch { throw new ApiError(0, 'NETWORK_ERROR', '网络中断，操作结果尚未确认，请重试。'); }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? 'REQUEST_FAILED', payload?.error?.message ?? '操作暂时无法完成，请稍后重试。');
  if (!payload || !Object.hasOwn(payload, 'data')) throw new ApiError(0, 'INVALID_RESPONSE', '未取得有效回执，请重试确认操作结果。');
  return payload.data as T;
}
export const fileUrl = (id: string) => `/api/v1/files/${encodeURIComponent(id)}/content`;
export interface PublicFields { name: string; description: string; era: string; material: string; ownershipType: 'personal_collection' | 'museum'; holderName: string; location: string; officialUrl: string }
export interface Submission { id: string; assetId: string; status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'deleted'; submittedAt: string; reviewedAt: string | null; rejectionReason: string | null; publicSnapshot: (PublicFields & { sourceNickname: string }) | null; assetName: string | null; candidateId: string | null; slotNo: number | null }
export const submissionLabel: Record<Submission['status'], string> = { pending: '待审核', approved: '已入候选', rejected: '已驳回', withdrawn: '已撤回', deleted: '模型已删除' };
