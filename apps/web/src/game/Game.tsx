import { useCallback, useEffect, useRef, useState } from 'react';
import { PavilionEngine, type HudState } from './engine.js';
import type { ExhibitSlot } from './navigation.js';
import './game.css';
import Backpack from './Backpack.js';
import ModelPreview from './ModelPreview.js';
import { api, ApiError } from './backpack-api.js';
import type { ExhibitDetail, GalleryExhibit, GalleryView } from '@aholo/contracts';

type Phase = 'loading' | 'failed' | 'intro' | 'play' | 'paused';
type Overlay = null | 'menu' | 'account' | 'detail' | 'help';
const FLOOR = { ground: '一层 · 中庭', stairs: '楼梯 · 半层', upper: '二层 · 回廊' } as const;

declare global { interface Window { __t10?: { engine: PavilionEngine; ui: () => { phase: Phase; overlay: Overlay; detail: string | null; galleryVersion: number | null; exhibits: number; detailName: string | null } } } }
type DetailState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; data: ExhibitDetail };
const OWNERSHIP = { museum: '博物馆', personal_collection: '个人收藏' } as const;
const slotNoOf = (s: ExhibitSlot) => Number(s.id.slice(1));
const grantHeaders = (g: GalleryView['grant']) => ({ Authorization: 'Bearer ' + g.token, 'X-Snapshot-Grant': g.id });

function slotLabel(s: ExhibitSlot) {
  return `${s.floor === 0 ? '一层' : '二层'}${s.position[0] < 0 ? '西' : '东'}侧 · 展位 ${s.id}`;
}

export default function Game() {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<PavilionEngine | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [hud, setHud] = useState<HudState>({ floor: 'ground', target: null, fps: 0, calls: 0 });
  const [detail, setDetail] = useState<ExhibitSlot | null>(null);
  const [gallery, setGallery] = useState<GalleryView | null>(null);
  const [galleryNotice, setGalleryNotice] = useState('');
  const [detailState, setDetailState] = useState<DetailState | null>(null);
  const grant = useRef<GalleryView['grant'] | null>(null);
  const state = useRef({ phase, overlay, detail, gallery, detailState });
  state.current = { phase, overlay, detail, gallery, detailState };
  const exhibitAt = useCallback((slot: ExhibitSlot | null): GalleryExhibit | null => slot ? state.current.gallery?.slots.find(s => s.slotNo === slotNoOf(slot))?.exhibit ?? null : null, []);

  useEffect(() => {
    if (!host.current) return;
    let instance: PavilionEngine;
    try {
      instance = new PavilionEngine(host.current, {
        progress: setProgress,
        ready: () => { setPhase('intro'); void loadGallery(instance); },
        failed: message => { setError(message); setPhase('failed'); },
        hud: setHud,
        // Esc while walking: the browser releases the mouse; we pause until the visitor clicks back in.
        lockLost: () => { if (state.current.phase === 'play' && !state.current.overlay) { engine.current?.setEnabled(false); setPhase('paused'); } },
      });
    } catch (e) {
      setError(e instanceof Error && /WebGL/i.test(e.message) ? '此浏览器无法创建 WebGL 画布，请使用最新版 Chrome。' : String(e));
      setPhase('failed');
      return;
    }
    engine.current = instance;
    window.__t10 = { engine: instance, ui: () => ({ phase: state.current.phase, overlay: state.current.overlay, detail: state.current.detail?.id ?? null, galleryVersion: state.current.gallery?.version ?? null, exhibits: instance.exhibitCount(), detailName: state.current.detailState?.status === 'ready' ? state.current.detailState.data.name : null }) };
    let renewal: ReturnType<typeof setTimeout> | undefined, stopped = false, renewKey: string | null = null;
    /** Each entry or refresh reads the latest published version; an open page keeps its version (AC42). */
    async function loadGallery(target: PavilionEngine) {
      try {
        const view = await api<GalleryView>('/gallery', { cache: 'no-store', credentials: 'omit' });
        if (stopped) return;
        grant.current = view.grant; setGallery(view);
        const result = await target.setExhibits(view.slots, grantHeaders(view.grant));
        if (!stopped && result.failed) setGalleryNotice(`${result.failed} 件展品暂时无法载入，刷新后重试。`);
        scheduleRenew();
      } catch { if (!stopped) setGalleryNotice('展陈暂时无法读取，展位显示为空；刷新后重试。'); }
    }
    function scheduleRenew() {
      clearTimeout(renewal); const g = grant.current; if (!g || stopped) return;
      renewal = setTimeout(async () => {
        const current = grant.current; if (!current || stopped) return;
        renewKey ??= crypto.randomUUID();
        try {
          const result = await api<{ grant: GalleryView['grant'] }>('/snapshots/' + encodeURIComponent(current.id) + '/renew', { method: 'POST', credentials: 'omit', headers: { ...grantHeaders(current), 'Idempotency-Key': renewKey } });
          renewKey = null; if (!stopped) { grant.current = result.grant; scheduleRenew(); }
        } catch (e) {
          // Network loss keeps the same key for a safe retry; a definitive refusal keeps the loaded scene as is.
          if (e instanceof ApiError && (e.status === 403 || e.status === 404)) { renewKey = null; setGalleryNotice('展陈已更新或参观凭证过期，刷新后可看到最新展陈。'); }
          else if (!stopped) { renewal = setTimeout(scheduleRenew, 30000); }
        }
      }, Math.max(1000, Math.min(60 * 60 * 1000, Date.parse(g.expiresAt) - Date.now() - 5 * 60 * 1000)));
    }
    return () => { stopped = true; clearTimeout(renewal); instance.dispose(); engine.current = null; delete window.__t10; };
  }, []);

  const play = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setOverlay(null);
    setDetail(null);
    setPhase('play');
    engine.current?.setEnabled(true);
    engine.current?.requestLock();
  }, []);

  /** Any menu, drawer or detail takes input: stop walking and free the mouse. */
  const open = useCallback((next: Exclude<Overlay, null>, slot?: ExhibitSlot) => {
    engine.current?.setEnabled(false);
    if (slot) {
      setDetail(slot);
      const exhibit = exhibitAt(slot), g = grant.current;
      if (exhibit && g) {
        setDetailState({ status: 'loading' });
        void api<ExhibitDetail>(`/snapshots/${encodeURIComponent(g.id)}/details/${encodeURIComponent(exhibit.candidateId)}`, { credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer ' + g.token } })
          .then(data => { if (state.current.detail === slot) setDetailState({ status: 'ready', data }); })
          .catch(e => { if (state.current.detail === slot) setDetailState({ status: 'failed', message: e instanceof ApiError && e.status === 404 ? '这件藏品已不再公开展示，刷新后可看到最新展陈。' : '详情暂时无法读取，请稍后重试。' }); });
      } else setDetailState(null);
    }
    setOverlay(next);
  }, [exhibitAt]);
  /** Closing returns to a paused state; the visitor clicks to re-lock, so nobody walks by accident. */
  const close = useCallback(() => {
    setOverlay(null);
    setDetail(null);
    setDetailState(null);
    setPhase(p => (p === 'play' || p === 'paused' ? 'paused' : p));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select')) return;
      if (e.repeat) return;
      const { phase: p, overlay: o } = state.current;
      if (p !== 'play' && p !== 'paused') return;
      if (e.code === 'Escape') { if (o) { e.preventDefault(); close(); } return; }
      if (e.code === 'KeyM') { e.preventDefault(); if (o === 'menu') close(); else if (!o) open('menu'); return; }
      if (e.code === 'KeyE' && p === 'play' && !o) {
        const target = engine.current?.debugState().target;
        if (target) { e.preventDefault(); open('detail', target); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const walking = phase === 'play' && !overlay;
  const targetExhibit = exhibitAt(hud.target);
  const shown = gallery?.slots.filter(s => s.exhibit).length ?? 0;
  const detailExhibit = exhibitAt(detail);
  return (
    <div className="t10-game" data-phase={phase} data-overlay={overlay ?? ''}>
      <div className="t10-canvas" ref={host} onClick={() => { if (phase === 'paused' && !overlay) play(); }} />

      {(phase === 'play' || phase === 'paused') && <>
        <header className="t10-hud-top">
          <div className="t10-place">
            <span className="t10-seal">藏</span>
            <div><strong>藏宝阁</strong><small data-testid="floor">{FLOOR[hud.floor]}</small></div>
          </div>
          <nav className="t10-actions" aria-label="游戏菜单">
            <button type="button" onClick={() => open('menu')}>菜单<kbd>M</kbd></button>
          </nav>
        </header>
        {walking && <span className="t10-crosshair" aria-hidden="true" />}
        {walking && hud.target && <div className="t10-prompt" role="status"><kbd>E</kbd>{targetExhibit ? <>查看 <b>{targetExhibit.name}</b><small>{slotLabel(hud.target)}</small></> : <>查看 {slotLabel(hud.target)}</>}</div>}
        {galleryNotice && !overlay && <div className="t10-notice" role="status">{galleryNotice}</div>}
        <footer className="t10-hud-bottom">
          <span>WASD 行走 · Shift 快走 · 空格跳跃 · 鼠标环顾 · Esc 释放鼠标</span>
          <span className="t10-meta">{gallery ? `展出 ${shown} / 30` : '展陈读取中'} · {hud.fps} FPS</span>
        </footer>
      </>}

      {phase === 'loading' && <div className="t10-screen" role="status">
        <span className="t10-seal big">藏</span>
        <h1>藏宝阁</h1>
        <div className="t10-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        <p>正在载入古阁 · {Math.round(progress * 100)}%</p>
      </div>}

      {phase === 'failed' && <div className="t10-screen" role="alert">
        <span className="t10-seal big">藏</span>
        <h1>古阁暂时无法打开</h1>
        <p>{error || '载入失败'}</p>
        <button type="button" className="t10-primary" onClick={() => location.reload()}>重新载入</button>
      </div>}

      {phase === 'intro' && <div className="t10-screen veil">
        <span className="t10-seal big">藏</span>
        <h1>藏宝阁</h1>
        <p className="t10-sub">二层古阁 · 三十展位</p>
        <button type="button" className="t10-primary" onClick={play} autoFocus>进入藏宝阁</button>
        <p className="t10-hint">点击后锁定鼠标环顾 · WASD 行走 · 空格跳跃 · 北侧楼梯可上二层</p>
        <p className="desktop-input-hint">请使用配有键盘和鼠标的电脑操作 3D 场景。</p>
      </div>}

      {phase === 'paused' && !overlay && <div className="t10-paused">
        <strong>已暂停</strong><span>点击画面继续参观 · M 打开菜单</span>
      </div>}

      {overlay === 'menu' && <div className="t10-modal-backdrop" onClick={close}>
        <section className="t10-menu" role="dialog" aria-modal="true" aria-label="菜单" onClick={e => e.stopPropagation()}>
          <h2>菜单</h2>
          <button type="button" autoFocus onClick={play}>继续参观</button>
          <button type="button" onClick={() => { engine.current?.resetToEntry(); play(); }}>回到入口</button>
          <button type="button" onClick={() => setOverlay('help')}>操作说明</button>
          <a href="/room">个人小屋</a>
          <button type="button" onClick={() => open('account')}>账号设置</button>
          <small>Esc 关闭</small>
        </section>
      </div>}

      {overlay === 'help' && <div className="t10-modal-backdrop" onClick={close}>
        <section className="t10-menu" role="dialog" aria-modal="true" aria-label="操作说明" onClick={e => e.stopPropagation()}>
          <h2>操作说明</h2>
          <dl className="t10-keys">
            <div><dt>W A S D / 方向键</dt><dd>行走</dd></div>
            <div><dt>Shift</dt><dd>快走</dd></div>
            <div><dt>鼠标</dt><dd>环顾（点击画面锁定）</dd></div>
            <div><dt>E</dt><dd>对准展台时查看</dd></div>
            <div><dt>M</dt><dd>菜单</dd></div>
            <div><dt>Esc</dt><dd>关闭浮层 / 释放鼠标</dd></div>
          </dl>
          <p>楼梯在大厅北侧：从右侧上楼，在半层平台折返，左侧上到二层。</p>
          <button type="button" autoFocus onClick={play}>继续参观</button>
        </section>
      </div>}

      <Backpack kind="account" open={overlay === 'account'} close={close} />

      {overlay === 'detail' && detail && <div className="t10-modal-backdrop" onClick={close}>
        <section className={`t10-detail${detailExhibit ? ' t10-exhibit' : ''}`} role="dialog" aria-modal="true" aria-label={detailExhibit ? `${detailExhibit.name}详情` : `展位 ${detail.id}`} onClick={e => e.stopPropagation()}>
          <div className="t10-drawer-head"><p>{slotLabel(detail)}</p><button type="button" aria-label="关闭详情" autoFocus onClick={close}>×</button></div>
          {!detailExhibit ? <>
            <h2>虚位以待</h2>
            <p>此展位尚未陈列藏品。用户投稿经审核、管理员安排展位后，会在这里公开展出。</p>
            <small>Esc 关闭后点击画面继续</small>
          </> : detailState?.status === 'ready' ? <ExhibitInfo data={detailState.data} headers={grant.current ? grantHeaders(grant.current) : undefined} />
            : detailState?.status === 'failed' ? <><h2>{detailExhibit.name}</h2><p role="alert">{detailState.message}</p></>
            : <><h2>{detailExhibit.name}</h2><p role="status">正在读取藏品资料…</p></>}
        </section>
      </div>}
    </div>
  );
}

/** Public exhibit detail: PRD 7.5 fields, source attribution apart from the holder, independent rotate/zoom preview. */
function ExhibitInfo({ data, headers }: { data: ExhibitDetail; headers?: Record<string, string> }) {
  const url = /^https?:\/\//i.test(data.officialUrl) ? data.officialUrl : '';
  return <div className="t10-exhibit-body">
    <ModelPreview fileId={data.model.modelFileId} name={data.name} headers={headers} />
    <div className="t10-exhibit-text">
      <h2>{data.name}</h2>
      <p className="t10-exhibit-source">{data.sourceNickname === '官方馆藏' ? '官方馆藏' : `投稿 · ${data.sourceNickname}`}</p>
      <p className="t10-exhibit-desc">{data.description}</p>
      <dl className="t10-exhibit-facts">
        <div><dt>年代</dt><dd>{data.era}</dd></div>
        <div><dt>材质</dt><dd>{data.material}</dd></div>
        <div><dt>归属</dt><dd>{OWNERSHIP[data.ownershipType]}</dd></div>
        <div><dt>收藏方</dt><dd>{data.holderName}</dd></div>
        <div><dt>所在地</dt><dd>{data.location}</dd></div>
        {url && <div><dt>官网</dt><dd><a href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a></dd></div>}
      </dl>
      <small>拖动旋转 · 滚轮缩放 · Esc 关闭后点击画面继续</small>
    </div>
  </div>;
}
