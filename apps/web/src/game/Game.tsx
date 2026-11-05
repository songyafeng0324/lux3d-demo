import { useCallback, useEffect, useRef, useState } from 'react';
import { PavilionEngine, type HudState } from './engine.js';
import type { ExhibitSlot } from './navigation.js';
import './game.css';

type Phase = 'loading' | 'failed' | 'intro' | 'play' | 'paused';
type Overlay = null | 'menu' | 'bag' | 'detail' | 'help';
const FLOOR = { ground: '一层 · 中庭', stairs: '楼梯 · 半层', upper: '二层 · 回廊' } as const;

declare global { interface Window { __t10?: { engine: PavilionEngine; ui: () => { phase: Phase; overlay: Overlay; detail: string | null } } } }

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
  const state = useRef({ phase, overlay, detail });
  state.current = { phase, overlay, detail };

  useEffect(() => {
    if (!host.current) return;
    let instance: PavilionEngine;
    try {
      instance = new PavilionEngine(host.current, {
        progress: setProgress,
        ready: () => setPhase('intro'),
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
    window.__t10 = { engine: instance, ui: () => ({ phase: state.current.phase, overlay: state.current.overlay, detail: state.current.detail?.id ?? null }) };
    return () => { instance.dispose(); engine.current = null; delete window.__t10; };
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
    if (slot) setDetail(slot);
    setOverlay(next);
  }, []);
  /** Closing returns to a paused state; the visitor clicks to re-lock, so nobody walks by accident. */
  const close = useCallback(() => {
    setOverlay(null);
    setDetail(null);
    setPhase(p => (p === 'play' || p === 'paused' ? 'paused' : p));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select')) return;
      if (e.repeat) return;
      const { phase: p, overlay: o } = state.current;
      if (p !== 'play' && p !== 'paused') return;
      if (e.code === 'Escape') { if (o) { e.preventDefault(); close(); } return; }
      if (e.code === 'KeyB') { e.preventDefault(); if (o === 'bag') close(); else if (!o) open('bag'); return; }
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
            <button type="button" onClick={() => open('bag')}>背包<kbd>B</kbd></button>
            <button type="button" onClick={() => open('menu')}>菜单<kbd>M</kbd></button>
          </nav>
        </header>
        {walking && <span className="t10-crosshair" aria-hidden="true" />}
        {walking && hud.target && <div className="t10-prompt" role="status"><kbd>E</kbd>查看 {slotLabel(hud.target)}</div>}
        <footer className="t10-hud-bottom">
          <span>WASD 行走 · Shift 快走 · 鼠标环顾 · Esc 释放鼠标</span>
          <span className="t10-meta">建筑框架 · 展位暂空 · {hud.fps} FPS</span>
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
        <p className="t10-hint">点击后锁定鼠标环顾 · WASD 行走 · 北侧楼梯可上二层</p>
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
          <a href="/lab/t04">个人小屋（试验版）</a>
          <a href="/workbench">本地工作台</a>
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
            <div><dt>B</dt><dd>背包</dd></div>
            <div><dt>M</dt><dd>菜单</dd></div>
            <div><dt>Esc</dt><dd>关闭浮层 / 释放鼠标</dd></div>
          </dl>
          <p>楼梯在大厅北侧：从右侧上楼，在半层平台折返，左侧上到二层。</p>
          <button type="button" autoFocus onClick={play}>继续参观</button>
        </section>
      </div>}

      {overlay === 'bag' && <aside className="t10-drawer" role="dialog" aria-modal="true" aria-label="背包">
        <div className="t10-drawer-head"><h2>背包</h2><button type="button" aria-label="关闭背包" autoFocus onClick={close}>×</button></div>
        <div className="t10-empty">
          <span className="t10-seal">囊</span>
          <p>背包还空着</p>
          <small>登录、上传图片生成藏品与个人背包即将开放。这里不展示模拟数据。</small>
        </div>
        <a className="t10-drawer-link" href="/lab/t04">前往个人小屋（试验版）→</a>
        <small className="t10-drawer-foot">B / Esc 关闭</small>
      </aside>}

      {overlay === 'detail' && detail && <div className="t10-modal-backdrop" onClick={close}>
        <section className="t10-detail" role="dialog" aria-modal="true" aria-label={`展位 ${detail.id}`} onClick={e => e.stopPropagation()}>
          <div className="t10-drawer-head"><p>{slotLabel(detail)}</p><button type="button" aria-label="关闭详情" autoFocus onClick={close}>×</button></div>
          <h2>虚位以待</h2>
          <p>此展位尚未陈列藏品。用户投稿经审核与策展后，会在这里公开展出。</p>
          <small>投稿与展陈即将开放 · Esc 关闭后点击画面继续</small>
        </section>
      </div>}
    </div>
  );
}
