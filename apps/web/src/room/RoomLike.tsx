import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomLikeView, RoomPopularity, SharedRoom } from '@aholo/contracts';
import { api, ApiError } from '../game/backpack-api.js';

const labels = { guest: '登录后可点赞', owner: '自己的小屋', liked: '已点赞', available: '点赞' };
const likePath = (room: SharedRoom) => '/snapshots/' + encodeURIComponent(room.grant.id) + '/room-like';
const grantHeaders = (room: SharedRoom) => ({
  Authorization: 'Bearer ' + room.grant.token,
  'X-Snapshot-Grant': room.grant.id,
});

export default function RoomLike({ room }: { room: SharedRoom }) {
  const [view, setView] = useState<RoomLikeView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ csrfToken: string; key: string } | null>(null);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const refreshAfterWrite = useRef(false);

  const refresh = useCallback(() => {
    if (writing.current) { refreshAfterWrite.current = true; return; }
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    void api<RoomLikeView>(likePath(room), { headers: grantHeaders(room), cache: 'no-store', signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.state !== 'available' || pending.current?.csrfToken !== result.csrfToken) pending.current = null;
        setView(result); setError('');
      })
      .catch(reason => { if (!controller.signal.aborted) { setView(null); setError(reason.message); } });
  }, [room]);

  useEffect(() => {
    const visible = () => { if (!document.hidden) refresh(); };
    refresh();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      reading.current?.abort();
      writing.current?.abort();
      writing.current = null;
      refreshAfterWrite.current = false;
    };
  }, [refresh]);

  async function like() {
    if (writing.current || view?.state !== 'available') return;
    reading.current?.abort();
    const controller = new AbortController();
    writing.current = controller;
    const { signal } = controller;
    setBusy(true); setError('');
    const { csrfToken } = view;
    if (pending.current?.csrfToken !== csrfToken) pending.current = { csrfToken, key: crypto.randomUUID() };
    try {
      const result = await api<RoomPopularity>(likePath(room), {
        method: 'PUT', signal,
        headers: { ...grantHeaders(room), 'X-CSRF-Token': csrfToken, 'Idempotency-Key': pending.current.key },
      });
      if (signal.aborted) return;
      pending.current = null;
      setView({ ...result, state: 'liked' });
    } catch (reason) {
      if (signal.aborted) return;
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        pending.current = null;
        refreshAfterWrite.current = true;
      } else setError(reason instanceof Error ? reason.message : '点赞未完成，请重试。');
    } finally {
      if (!signal.aborted) {
        writing.current = null;
        setBusy(false);
        if (refreshAfterWrite.current) { refreshAfterWrite.current = false; refresh(); }
      }
    }
  }

  return <aside className="room-like" aria-label="小屋人气">
    {view && <>
      <button type="button" className="room-like-button" data-state={view.state}
        disabled={busy || view.state !== 'available'} onClick={() => void like()}>
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 10v11H3V10zm0 10h11a2 2 0 0 0 2-1.6l1.4-7A2 2 0 0 0 19.5 9H15l.7-4.1A2.5 2.5 0 0 0 13.2 2L7 10" />
        </svg>
        <span>{busy ? '提交中…' : labels[view.state]}</span>
      </button>
      <span className="room-like-count" role="status">人气 <strong>{view.popularity}</strong></span>
    </>}
    {error && <small role="alert">{error}</small>}
    {error && !view && <button type="button" onClick={refresh}>重试读取人气</button>}
  </aside>;
}
