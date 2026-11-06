import { useEffect, useRef, useState } from 'react';
import type { SharedRoomListing } from '@aholo/contracts';
import { api } from '../game/backpack-api.js';

export default function RoomDirectory({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<SharedRoomListing[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: SharedRoomListing[] }>('/rooms/discover', { cache: 'no-store', signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setItems(result.items); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [attempt]);

  return <dialog ref={dialog} className="room-directory" aria-labelledby="room-directory-title"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section>
      <header className="t10-drawer-head">
        <div><h2 id="room-directory-title">逛一逛</h2><p>访问已开启分享的小屋</p></div>
        <button type="button" aria-label="关闭逛一逛" onClick={close}>×</button>
      </header>
      <div className="room-directory-content">
        {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => { setError(''); setAttempt(attempt + 1); }}>重试</button></div>
          : items === null ? <p role="status">正在读取小屋…</p>
          : items.length === 0 ? <p role="status">还没有开启分享的小屋。</p>
          : <table>
            <thead><tr><th scope="col">作者昵称</th><th scope="col">小屋名</th><th scope="col">人气值</th><th scope="col">操作</th></tr></thead>
            <tbody>{items.map(item => <tr key={item.id}>
              <td>{item.ownerNickname}</td><td>{item.name}</td><td>{item.popularity}</td>
              <td><a href={item.shareUrl} aria-label={`访问 ${item.name}`}>访问</a></td>
            </tr>)}</tbody>
          </table>}
      </div>
    </section>
  </dialog>;
}
