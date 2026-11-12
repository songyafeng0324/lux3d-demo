import { useCallback, useEffect, useRef, useState } from 'react';
import { PavilionEngine, type HudState } from './engine.js';
import type { ExhibitSlot } from './navigation.js';
import './game.css';
import Backpack from './Backpack.js';
import ModelPreview from './ModelPreview.js';
import CharacterPicker, { CharacterButton, CHARACTER_KEY, useAvatarPrefs, WALK_HINT } from './CharacterPicker.js';
import { api, ApiError, type Me } from './backpack-api.js';
import type { AvatarPrefs, CharacterId } from './avatar-prefs.js';
import type { ExhibitCollectionStatus, ExhibitDetail, GalleryExhibit, GalleryView } from '@aholo/contracts';

type Phase = 'loading' | 'failed' | 'intro' | 'play' | 'paused';
type Overlay = null | 'menu' | 'account' | 'backpack' | 'detail' | 'help' | 'character';
const FLOOR = { ground: '一层 · 大殿', stairs: '北殿 · 大楼梯', upper: '二层 · 展厅' } as const;

declare global { interface Window { __t10?: { engine: PavilionEngine; ui: () => { avatar: AvatarPrefs; phase: Phase; overlay: Overlay; detail: string | null; galleryVersion: number | null; exhibits: number; detailName: string | null } } } }
type DetailState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; data: ExhibitDetail };
const OWNERSHIP = { museum: '博物馆', personal_collection: '个人收藏' } as const;
const slotNoOf = (s: ExhibitSlot) => Number(s.id.slice(1));
const grantHeaders = (g: GalleryView['grant']) => ({ Authorization: 'Bearer ' + g.token, 'X-Snapshot-Grant': g.id });

function slotLabel(s: ExhibitSlot) {
  return `${s.label ?? (s.floor === 0 ? '一层' : '二层')} · 展位 ${s.id}`;
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
  const [avatar, setAvatar, avatarFellBack] = useAvatarPrefs();
  const [avatarNotice, setAvatarNotice] = useState('');
  const avatarRef = useRef(avatar);
  avatarRef.current = avatar;
  const grant = useRef<GalleryView['grant'] | null>(null);
  const returnToExhibit = useRef(false);
  /** Reloads the published gallery (used after the visitor deleted one of their own exhibits). */
  const reloadGallery = useRef<() => void>(() => {});
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
        avatarFailed: message => { avatarFellBack(); setAvatarNotice(`${message}，已切换为第一人称。`); },
      });
      instance.setAvatar(avatarRef.current);
    } catch (e) {
      setError(e instanceof Error && /WebGL/i.test(e.message) ? '此浏览器无法创建 WebGL 画布，请使用最新版 Chrome。' : String(e));
      setPhase('failed');
      return;
    }
    engine.current = instance;
    window.__t10 = { engine: instance, ui: () => ({ avatar: avatarRef.current, phase: state.current.phase, overlay: state.current.overlay, detail: state.current.detail?.id ?? null, galleryVersion: state.current.gallery?.version ?? null, exhibits: instance.exhibitCount(), detailName: state.current.detailState?.status === 'ready' ? state.current.detailState.data.name : null }) };
    let renewal: ReturnType<typeof setTimeout> | undefined, stopped = false, renewKey: string | null = null, gallerySeq = 0;
    reloadGallery.current = () => { if (!stopped) void loadGallery(instance); };
    /** Each entry or refresh reads the latest published version; an open page keeps its version (AC42). */
    async function loadGallery(target: PavilionEngine) {
      // A later reload (e.g. after the owner deletes an exhibit) supersedes a slower earlier one.
      const seq = ++gallerySeq;
      try {
        const view = await api<GalleryView>('/gallery', { cache: 'no-store', credentials: 'omit' });
        if (stopped || seq !== gallerySeq) return;
        grant.current = view.grant; setGallery(view);
        const result = await target.setExhibits(view.slots, grantHeaders(view.grant));
        if (!stopped && result.failed) setGalleryNotice(`${result.failed} 件展品暂时无法载入，刷新后重试。`);
        scheduleRenew();
      } catch { if (!stopped && seq === gallerySeq) setGalleryNotice('展陈暂时无法读取，展位显示为空；刷新后重试。'); }
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

  /** Preference changes apply live; a failed load keeps the saved choice for the next visit. */
  const changeAvatar = useCallback((next: AvatarPrefs) => {
    setAvatar(next); setAvatarNotice('');
    engine.current?.setAvatar(next);
  }, [setAvatar]);

  const play = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setOverlay(null);
    setDetail(null);
    setPhase('play');
    engine.current?.setEnabled(true);
    engine.current?.requestLock();
  }, []);
  /** One click in the picker: show that character (third person) and go straight back to walking. */
  const pickCharacter = useCallback((character: CharacterId) => {
    changeAvatar({ character, view: 'third' });
    play();
  }, [changeAvatar, play]);

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
    returnToExhibit.current = false;
    setOverlay(null);
    setDetail(null);
    setDetailState(null);
    setPhase(p => (p === 'play' || p === 'paused' ? 'paused' : p));
  }, []);
  const loginForExhibit = useCallback(() => {
    returnToExhibit.current = true;
    open('account');
  }, [open]);
  const closeAccount = useCallback(() => {
    if (returnToExhibit.current) {
      returnToExhibit.current = false;
      setOverlay('detail');
    } else close();
  }, [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]')) return;
      if (e.repeat || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      const { phase: p, overlay: o } = state.current;
      if (p !== 'play' && p !== 'paused') return;
      if (e.code === 'Escape') { if (o) { e.preventDefault(); close(); } return; }
      if (e.code === 'KeyM') { e.preventDefault(); if (o === 'menu') close(); else if (!o) open('menu'); return; }
      if (e.code === 'KeyB' && !o) { e.preventDefault(); open('backpack'); return; }
      if (e.code === CHARACTER_KEY && !o && !e.shiftKey) { e.preventDefault(); open('character'); return; }
      if (e.code === 'KeyV' && !o && !e.shiftKey) { e.preventDefault(); const a = avatarRef.current; changeAvatar({ ...a, view: a.view === 'third' ? 'first' : 'third' }); return; }
      if (e.code === 'KeyE' && p === 'play' && !o) {
        const target = engine.current?.debugState().target;
        if (target) { e.preventDefault(); open('detail', target); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, changeAvatar]);

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
            <CharacterButton onClick={() => open('character')} />
            <button type="button" aria-keyshortcuts="B" onClick={() => open('backpack')}>背包<kbd aria-hidden="true">B</kbd></button>
            <button type="button" onClick={() => open('menu')}>菜单<kbd>M</kbd></button>
          </nav>
        </header>
        {walking && <span className="t10-crosshair" aria-hidden="true" />}
        {walking && hud.target && <div className="t10-prompt" role="status"><kbd>E</kbd>{targetExhibit ? <>查看 <b>{targetExhibit.name}</b><small>{slotLabel(hud.target)}</small></> : <>查看 {slotLabel(hud.target)}</>}</div>}
        {galleryNotice && !overlay && <div className="t10-notice" role="status">{galleryNotice}</div>}
        {avatarNotice && !overlay && <div className="t10-notice" role="status">{avatarNotice}</div>}
        <footer className="t10-hud-bottom">
          <span>{WALK_HINT}</span>
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
        <p className="t10-sub">通高天井 · 三十展位 · 北殿大楼梯可上二层</p>
        <button type="button" className="t10-primary" onClick={play} autoFocus>进入藏宝阁</button>
        <p className="t10-hint">{WALK_HINT}</p>
        <p className="desktop-input-hint">请使用配有键盘和鼠标的电脑操作 3D 场景。</p>
      </div>}

      {phase === 'paused' && !overlay && <div className="t10-paused">
        <strong>已暂停</strong><span>点击画面继续参观 · C 选择角色 · B 打开背包 · M 打开菜单</span>
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
            <div><dt>V</dt><dd>切换第三人称 / 第一人称</dd></div>
            <div><dt>C</dt><dd>选择角色</dd></div>
            <div><dt>B</dt><dd>打开背包</dd></div>
            <div><dt>M</dt><dd>菜单</dd></div>
            <div><dt>Esc</dt><dd>关闭浮层 / 释放鼠标</dd></div>
          </dl>
          <p>大楼梯在北殿：沿长毯向北，中间石阶上到月洞门平台，再从左右两侧的楼梯折回上二层。</p>
          <button type="button" autoFocus onClick={play}>继续参观</button>
        </section>
      </div>}

      <Backpack kind="account" open={overlay === 'account'} close={closeAccount} onAccountChange={profile => {
        if (profile && returnToExhibit.current) closeAccount();
      }} />
      <Backpack open={overlay === 'backpack'} close={close} onAssetDeleted={(_, result) => { if (result.galleryVersion !== null) reloadGallery.current(); }} />
      {overlay === 'character' && <CharacterPicker prefs={avatar} pick={pickCharacter} close={close} />}

      {overlay === 'detail' && detail && <div className="t10-modal-backdrop" onClick={close}>
        <section className={`t10-detail${detailExhibit ? ' t10-exhibit' : ''}`} role="dialog" aria-modal="true" aria-label={detailExhibit ? `${detailExhibit.name}详情` : `展位 ${detail.id}`} onClick={e => e.stopPropagation()}>
          <div className="t10-drawer-head"><p>{slotLabel(detail)}</p><button type="button" aria-label="关闭详情" autoFocus onClick={close}>×</button></div>
          {!detailExhibit ? <>
            <h2>虚位以待</h2>
            <p>此展位尚未陈列藏品。用户投稿经审核、管理员安排展位后，会在这里公开展出。</p>
            <small>Esc 关闭后点击画面继续</small>
          </> : detailState?.status === 'ready' ? <ExhibitInfo data={detailState.data} headers={grant.current ? grantHeaders(grant.current) : undefined} login={loginForExhibit} />
            : detailState?.status === 'failed' ? <><h2>{detailExhibit.name}</h2><p role="alert">{detailState.message}</p></>
            : <><h2>{detailExhibit.name}</h2><p role="status">正在读取藏品资料…</p></>}
        </section>
      </div>}
    </div>
  );
}

/** Public exhibit detail: PRD 7.5 fields, source attribution apart from the holder, independent rotate/zoom preview. */
function ExhibitInfo({ data, headers, login }: { data: ExhibitDetail; headers?: Record<string, string>; login: () => void }) {
  const url = /^https?:\/\//i.test(data.officialUrl) ? data.officialUrl : '';
  return <div className="t10-exhibit-body">
    <ModelPreview fileId={data.model.modelFileId} name={data.name} headers={headers} notice={
      <p className="t10-ai-notice" role="note"><span>AI 生成</span>与实物可能有偏差，仅供观赏</p>
    } />
    <div className="t10-exhibit-text">
      <div className="t10-exhibit-title"><h2>{data.name}</h2>{headers && <CollectExhibit key={data.candidateId} candidateId={data.candidateId} headers={headers} login={login} />}</div>
      <p className="t10-exhibit-source">{data.source === 'official' ? '官方馆藏' : `作者：${data.sourceNickname}`}</p>
      <p className="t10-exhibit-desc">简介：{data.description}</p>
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

function CollectExhibit({ candidateId, headers, login }: { candidateId: string; headers: Record<string, string>; login: () => void }) {
  const path = `/gallery/exhibits/${encodeURIComponent(candidateId)}/collection`;
  const [status, setStatus] = useState<ExhibitCollectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ actorId: string; key: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void api<{ status: ExhibitCollectionStatus }>(path, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setStatus(result.status);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (!(reason instanceof ApiError && reason.status === 401)) setError('暂时无法读取收藏状态，可以点击重试。');
      setStatus('available');
    });
    return () => controller.abort();
  }, [path]);

  async function collect() {
    const signal = lifetime.current?.signal;
    if (busy || status !== 'available' || !signal || signal.aborted) return;
    setBusy(true); setError('');
    try {
      const profile = await api<Me>('/me', { signal });
      if (signal.aborted) return;
      if (pending.current?.actorId !== profile.user.id) pending.current = { actorId: profile.user.id, key: crypto.randomUUID() };
      const result = await api<{ status: ExhibitCollectionStatus }>(path, { method: 'POST', signal, headers: {
        ...headers, 'X-CSRF-Token': profile.csrfToken, 'Idempotency-Key': pending.current.key,
      } });
      if (!signal.aborted) { pending.current = null; setStatus(result.status); }
    } catch (reason) {
      if (signal.aborted) return;
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) pending.current = null;
      if (reason instanceof ApiError && reason.status === 401) { login(); return; }
      if (reason instanceof ApiError && reason.code === 'EXHIBIT_UNAVAILABLE') setStatus('unavailable');
      setError(reason instanceof Error ? reason.message : '收藏失败，请重试。');
    } finally { if (!signal.aborted) setBusy(false); }
  }
  const label = status === 'collected' ? '已收藏' : status === 'owned' ? '已在我的藏品' : status === 'unavailable' ? '暂不可收藏' : '添加到我的藏品';
  return <div className="t10-exhibit-collect"><button type="button" disabled={busy || status !== 'available'} onClick={() => void collect()}>{busy ? '正在添加…' : label}</button>{error && <p role="alert">{error}</p>}</div>;
}
