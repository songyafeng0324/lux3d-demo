import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateRoomLayout, type Bounds, type PersonalRoom, type RoomModel, type RoomPlacement, type SharedRoom } from '@aholo/contracts';
import { api, ApiError, type Asset, type Me, type Page } from '../game/backpack-api.js';
import Backpack from '../game/Backpack.js';
import AssetThumbnail, { type ThumbnailCache } from '../game/AssetThumbnail.js';
import '../game/game.css';
import { RoomEngine, type RoomMode, type RoomTool } from './engine.js';
import { PersonalRoomSave, type RoomSaveState } from './save.js';
import '../scene/scene.css';
import './room.css';
interface CatalogAsset extends Asset { sourceType?: string; normalization: RoomModel['normalization']; bounds: Bounds }
const labels = { loading: '正在读取布置', loadFailed: '读取失败', saved: '已自动保存', dirty: '有修改待保存', saving: '正在保存…', failed: '保存未确认', rejected: '布置未通过校验', conflict: '房间版本冲突' };
async function allAssets(path: string): Promise<CatalogAsset[]> {
  const items: CatalogAsset[] = []; let cursor: string | null = null; const seen = new Set<string>();
  do { const page: Page<CatalogAsset> = await api<Page<CatalogAsset>>(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')); items.push(...page.items); cursor = page.nextCursor; if (cursor && seen.has(cursor)) throw new Error('物品分页读取失败，请重试。'); if (cursor) seen.add(cursor); } while (cursor);
  return items;
}
const modelOf = (asset: CatalogAsset): RoomModel => ({ id: asset.id, modelFileId: asset.modelFileId, normalization: asset.normalization, bounds: asset.bounds });
declare global { interface Window { __room?: { engine: RoomEngine; save: PersonalRoomSave | null; edit: (name: string, placements: RoomPlacement[]) => void; add: (id: string) => Promise<void>; replace: (placements: RoomPlacement[]) => void; snapshot: () => PersonalRoom | SharedRoom | null } } }
export default function Room({ shareToken }: { shareToken?: string }) {
  const visitor = Boolean(shareToken);
  const host = useRef<HTMLDivElement>(null), engine = useRef<RoomEngine | null>(null), saver = useRef<PersonalRoomSave | null>(null);
  const layoutActor = useRef<Me['user'] | null>(null);
  const profile = useRef<Me | null>(null), snapshot = useRef<SharedRoom | null>(null);
  const [room, setRoom] = useState<PersonalRoom | SharedRoom | null>(null);
  const current = useRef(room); current.current = room;
  const [save, setSave] = useState<RoomSaveState>({ status: 'loading', version: 0, sequence: 0, message: '' });
  const [owner, setOwner] = useState<Me | null>(null);
  const thumbnailCache = useMemo<ThumbnailCache>(() => new Map(), [owner?.user.id]);
  const [catalog, setCatalog] = useState<CatalogAsset[]>([]);
  const catalogById = useMemo(() => new Map(catalog.map(asset => [asset.id, asset])), [catalog]);
  const catalogSequence = useRef(0);
  const [furniture, setFurniture] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<RoomMode>(visitor ? 'share' : 'edit');
  const [tool, setTool] = useState<RoomTool>('translate'), [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'catalog' | 'objects'>('catalog');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overlay, setOverlay] = useState<'menu' | 'account' | 'backpack' | null>(() =>
    !shareToken && new URLSearchParams(location.search).get('backpack') === '1' ? 'backpack' : null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState(''), [loadError, setLoadError] = useState(''), [loginRequired, setLoginRequired] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false), [shareBusy, setShareBusy] = useState(false), [reloadKey, setReloadKey] = useState(0);
  const sharePending = useRef<{ key: string; enabled: boolean } | null>(null);
  const [hasSharePending, setHasSharePending] = useState(false), [shareNote, setShareNote] = useState('');
  const refreshCatalog = useCallback(async (instance: RoomEngine) => {
    const sequence = ++catalogSequence.current;
    const [personal, official] = await Promise.all([allAssets('/assets'), allAssets('/furniture')]);
    if (engine.current !== instance || sequence !== catalogSequence.current) return;
    const rows = [...personal, ...official];
    instance.setCatalog(rows.map(modelOf));
    setCatalog(rows);
    setFurniture(new Set(official.map(asset => asset.id)));
  }, []);

  function accountChanged(value: Me | null, ended = false) {
    const prior = layoutActor.current;
    const sessionRestored = Boolean(value && !profile.current && prior?.id === value.user.id);
    if (!value && !ended) {
      // A temporary 401 must keep the original draft and pending save receipt.
      profile.current = null;
      setOwner(null);
      catalogSequence.current++;
      setDrawerOpen(false); setLoginRequired(true);
      return;
    }
    if (value && prior?.id === value.user.id) {
      profile.current = value;
      setOwner(value);
      setLoginRequired(false);
      if (sessionRestored && !saver.current?.current) setReloadKey(key => key + 1);
      return;
    }
    // Stop old writes before making a different user's CSRF token available.
    saver.current?.dispose(); saver.current = null;
    layoutActor.current = value?.user ?? null;
    profile.current = value;
    setOwner(value);
    catalogSequence.current++;
    setCatalog([]); setFurniture(new Set());
    setRoom(null); current.current = null;
    setDrawerOpen(false); setNotice(''); setShareNote('');
    setLoadingModel(false); setShareBusy(false);
    sharePending.current = null; setHasSharePending(false);
    setReloadKey(key => key + 1);
  }
  const allowSessionEnd = () => !saver.current?.unsaved || confirm('小屋还有未保存的修改，结束当前会话会丢失本页草稿。继续吗？');
  const allowLogin = (username: string) => layoutActor.current?.username.toLowerCase() === username.trim().toLowerCase() || allowSessionEnd();

  function openOverlay(next: 'menu' | 'account' | 'backpack') {
    if (engine.current?.transform.dragging) return;
    if (document.pointerLockElement === engine.current?.renderer.domElement) document.exitPointerLock();
    setDrawerOpen(false);
    setOverlay(next);
  }

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    const instance = engine.current;
    if (overlay === 'backpack' && instance && profile.current) {
      void refreshCatalog(instance).catch(error => {
        if (engine.current === instance) setNotice(error instanceof Error ? error.message : '物品库刷新失败。');
      });
    }
    if (overlay === 'menu' || overlay === 'account') menuButton.current?.focus();
  }, [overlay, refreshCatalog]);

  function openCatalog() {
    setDrawerOpen(true);
    const instance = engine.current;
    if (instance && profile.current) {
      void refreshCatalog(instance).catch(error => {
        if (engine.current === instance) setNotice(error instanceof Error ? error.message : '物品库刷新失败。');
      });
    }
  }
  const edit = (name: string, placements: RoomPlacement[]) => {
    if (!profile.current || !saver.current?.canEdit) return;
    saver.current.edit(name, placements);
  };
  const add = async (assetId: string) => {
    const instance = engine.current;
    if (!instance || !profile.current || !saver.current?.canEdit || !current.current || loadingModel) return;
    setLoadingModel(true);
    try {
      await instance.ensureModel(assetId);
      if (instance !== engine.current || !profile.current || !current.current) return;
      const n = current.current.placements.length;
      const placement: RoomPlacement = { id: crypto.randomUUID(), assetId, position: [((n % 5) - 2) * 1.5, 0, (Math.floor(n / 5) % 3 - 1) * 1.5], rotation: [0, 0, 0], scale: 1 };
      if (validateRoomLayout(current.current.name, [placement], instance.bounds)) placement.position = [0, 0, 0];
      const error = validateRoomLayout(current.current.name, [placement], instance.bounds);
      if (error) throw new Error('这个模型当前尺寸无法放入小屋。');
      edit(current.current.name, [...current.current.placements, placement]); instance.select(placement.id);
      setNotice('已添加一件独立摆放，可用移动、旋转、等比缩放工具布置。');
    } catch (error) { if (instance === engine.current) setNotice(error instanceof Error ? error.message : '添加失败，请重试。'); }
    finally { if (instance === engine.current) setLoadingModel(false); }
  };
  const latest = useRef({ edit, add }); latest.current = { edit, add };

  useEffect(() => {
    if (!host.current) return;
    let stopped = false, renewal: ReturnType<typeof setTimeout> | undefined;
    let renewalPending: { key: string; grantId: string } | null = null;
    setLoadError(''); setLoginRequired(false); setMode(visitor ? 'share' : 'edit'); setTool('translate'); setRoom(null); current.current = null; setSave({ status: 'loading', version: 0, sequence: 0, message: '' });
    let instance: RoomEngine;
    try {
      instance = new RoomEngine(host.current, { select: setSelected, edit: placement => { const value = current.current; if (value) latest.current.edit(value.name, value.placements.map(p => p.id === placement.id ? placement : p)); }, notice: setNotice }, (): Record<string, string> => { const grant = snapshot.current?.grant; return visitor && grant ? { Authorization: 'Bearer ' + grant.token, 'X-Snapshot-Grant': grant.id } : {}; }, visitor);
    } catch { setLoadError('浏览器暂时无法创建小屋场景，请使用最新版 Chrome。'); return; }
    engine.current = instance;
    const prepare = async (value: PersonalRoom) => {
      instance.setCatalog(value.assets);
      const used = new Set(value.placements.map(p => p.assetId));
      await instance.loadModels(value.assets.filter(asset => used.has(asset.id)));
    };
    if (visitor) {
      const loadShared = async () => {
        try {
          const value = await api<SharedRoom>('/shared-rooms/' + encodeURIComponent(shareToken!), { cache: 'no-store' });
          if (stopped) return; snapshot.current = value;
          if (value.sceneVersion !== 'courtyard-v1' || !Array.isArray(value.placements) || !Array.isArray(value.assets)) throw new Error('分享内容格式无效。');
          const used = new Set(value.placements.map(placement => placement.assetId));
          await instance.loadModels(value.assets.filter(asset => used.has(asset.id)));
          if (stopped) return;
          instance.setPlacements(value.placements); setRoom(value); current.current = value; setSave({ status: 'saved', version: value.version, sequence: 0, message: '' });
          const renew = async () => {
            const grant = snapshot.current?.grant; if (!grant || stopped) return;
            try {
              renewalPending ??= { key: crypto.randomUUID(), grantId: grant.id };
              const result = await api<{ grant: SharedRoom['grant'] }>('/snapshots/' + encodeURIComponent(grant.id) + '/renew', { method: 'POST', headers: { Authorization: 'Bearer ' + grant.token, 'X-Snapshot-Grant': grant.id, 'Idempotency-Key': renewalPending.key } });
              if (!stopped && snapshot.current) { renewalPending = null; snapshot.current.grant = result.grant; scheduleRenew(); }
            } catch (error) {
              if (stopped) return;
              setNotice('分享授权暂时无法续期。已载入画面保留，重新进入前请确认分享仍开启。');
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) renewalPending = null;
              else renewal = setTimeout(() => void renew(), 30000);
            }
          };
          const scheduleRenew = () => { const expiry = Date.parse(snapshot.current!.grant.expiresAt); renewal = setTimeout(() => void renew(), Math.max(1000, Math.min(60 * 60 * 1000, expiry - Date.now() - 5 * 60 * 1000))); };
          scheduleRenew();
        } catch (error) { if (!stopped) setLoadError(error instanceof ApiError && [403, 404].includes(error.status) ? '此分享链接不可访问，可能已关闭或不存在。' : error instanceof Error ? error.message : '分享小屋暂时无法读取。'); }
      };
      void loadShared();
    } else {
      const controller = new PersonalRoomSave(() => profile.current?.csrfToken ?? '', prepare, (value, state) => {
        if (stopped) return;
        if (value && value.placements !== current.current?.placements) instance.setPlacements(value.placements);
        current.current = value; setRoom(value); setSave(state);
      }, () => accountChanged(null));
      saver.current = controller;
      void (async () => {
        try {
          const value = await api<Me>('/me');
          if (stopped) return;
          layoutActor.current = value.user;
          profile.current = value;
          setOwner(value);
          await refreshCatalog(instance);
          if (!stopped) await controller.load();
        } catch (error) {
          if (stopped) return;
          if (error instanceof ApiError && error.status === 401) {
            profile.current = null; setOwner(null); setLoginRequired(true);
            setCatalog([]); setFurniture(new Set());
          }
          setLoadError(error instanceof Error ? error.message : '小屋暂时无法读取。');
        }
      })();
    }
    window.__room = { engine: instance, save: saver.current, edit: (name, placements) => latest.current.edit(name, placements), add: id => latest.current.add(id), replace: placements => { const value = current.current; if (value) latest.current.edit(value.name, placements); }, snapshot: () => current.current };
    return () => { stopped = true; clearTimeout(renewal); saver.current?.dispose(); saver.current = null; instance.dispose(); engine.current = null; snapshot.current = null; delete window.__room; };
  }, [visitor, shareToken, reloadKey, refreshCatalog]);

  useEffect(() => {
    if (overlay !== 'menu') return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeOverlay(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [overlay, closeOverlay]);

  useEffect(() => {
    if (!drawerOpen || visitor || mode !== 'edit') return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setDrawerOpen(false); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [drawerOpen, visitor, mode]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (saver.current?.unsaved) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => { const anchor = (event.target as HTMLElement)?.closest('a[href]'); if (anchor && (anchor as HTMLAnchorElement).target !== '_blank' && !event.metaKey && !event.ctrlKey && saver.current?.unsaved && !confirm('小屋还有未保存的修改，离开将丢失本页草稿。仍然离开吗？')) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload); document.addEventListener('click', navigate);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', navigate); };
  }, []);

  async function toggleShare() {
    const controller = saver.current;
    const value = controller?.current; if (!profile.current || !controller || !value || shareBusy) return;
    const request = sharePending.current ?? { key: crypto.randomUUID(), enabled: !value.shareEnabled };
    sharePending.current = request; setHasSharePending(true); setShareBusy(true); setShareNote('');
    try {
      const result = await api<{ enabled: boolean; shareUrl: string }>('/rooms/me/share', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-CSRF-Token': profile.current?.csrfToken ?? '' }, body: JSON.stringify({ enabled: request.enabled }) });
      if (saver.current !== controller) return;
      sharePending.current = null; setHasSharePending(false); controller.updateShare(result.enabled, result.shareUrl);
      setShareNote(result.enabled ? '分享已开启，新访客仅看到服务端已确认布局。' : '分享已关闭，新进入与文件请求将被拒绝。');
    } catch (error) { if (error instanceof ApiError && error.status >= 400 && error.status < 500) { sharePending.current = null; setHasSharePending(false); } setShareNote(error instanceof Error ? error.message : '分享操作未确认，请重试原请求。'); }
    finally { setShareBusy(false); }
  }
  function changeMode(next: RoomMode) { if (engine.current?.debug().moving) return; setMode(next); engine.current?.setMode(next); }
  const active = room?.placements.find(p => p.id === selected);
  const nameOf = (id: string) => catalogById.get(id)?.name ?? '个人藏品';
  const ownerRoom = !visitor ? room as PersonalRoom | null : null;
  const canEdit = Boolean(owner && saver.current?.canEdit) && !loadingModel;
  return <div className={'scene-app room-app' + (visitor ? ' room-visitor' : '') + (drawerOpen && mode === 'edit' ? ' room-drawer-open' : '')}>
    <header className="scene-header">
      <a className="brand" href="/"><span className="seal">藏</span><span>个人小屋<small>MY LITTLE COLLECTION</small></span></a>
      <span className="room-identity">{visitor ? '只读参观' : owner?.user.nickname ?? '我的空间'}</span>
      {visitor ? <a className="service-link" href="/">返回藏宝阁</a> : <nav className="room-header-actions" aria-label="小屋菜单">
        {mode === 'edit' && !drawerOpen && <button type="button" onClick={openCatalog}>打开物品库</button>}
        <button type="button" onClick={() => openOverlay('backpack')}>背包</button>
        <button type="button" ref={menuButton} onClick={() => openOverlay('menu')}>菜单</button>
      </nav>}
    </header>
    <div className="scene-navigation"><div className="room-heading"><p>{visitor ? (room as SharedRoom | null)?.ownerNickname ?? '分享的小屋' : '布置你的小世界'}</p>{visitor || mode !== 'edit' ? <h1>{room?.name ?? '个人小屋'}</h1> : <input aria-label="房间名称" value={room?.name ?? ''} disabled={!canEdit} maxLength={80} onChange={event => edit(event.target.value, room?.placements ?? [])} />}</div>{!visitor && <nav aria-label="小屋模式"><button className={mode === 'edit' ? 'active' : ''} onClick={() => changeMode('edit')}>布置小屋</button><button className={mode === 'visit' ? 'active' : ''} onClick={() => changeMode('visit')}>第一人称参观</button></nav>}<div className={'save-state ' + save.status} role="status">{visitor ? '只读快照 · 版本 ' + (room?.version ?? '—') : labels[save.status]}{!visitor && <small>v{save.version}</small>}</div></div>
    <main className="scene-workspace">
      {!visitor && mode === 'edit' && drawerOpen && <aside className="scene-sidebar" aria-label="物品抽屉">
        <div className="room-drawer-head"><strong>物品与摆放</strong><button type="button" aria-label="关闭物品抽屉" onClick={() => setDrawerOpen(false)}>×</button></div>
        <div className="sidebar-tabs">
          <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>物品库 <small>{catalog.length}</small></button>
          <button className={tab === 'objects' ? 'active' : ''} onClick={() => setTab('objects')}>房间物品 <small>{room?.placements.length ?? 0}</small></button>
        </div>
        {tab === 'catalog' ? <div className="room-catalog">
          <p className="sidebar-note">每次添加均为独立摆放。名称和简介在背包维护。</p>
          {[false, true].map(official => <section key={String(official)}>
            <h2 className="group-label">{official ? '官方家具' : '个人背包'}</h2>
            <div className="room-asset-grid">{catalog.filter(asset => furniture.has(asset.id) === official).map(asset => <button type="button" className="room-asset-card" key={asset.id} disabled={!canEdit} onClick={() => void add(asset.id)}>
              <AssetThumbnail asset={asset} cache={thumbnailCache} />
              <span className="asset-short-name" title={asset.name}>{asset.name}</span>
              <span className="room-asset-add" aria-hidden="true">＋</span>
            </button>)}</div>
          </section>)}
          {catalog.length === 0 && <p className="sidebar-note">物品库还空着，先去背包生成一件藏品。</p>}
        </div> : <div className="placement-list"><div className="room-asset-grid">
          {room?.placements.map((placement, index) => {
            const asset = catalogById.get(placement.assetId);
            const name = nameOf(placement.assetId);
            return <div className={'room-placement-card' + (selected === placement.id ? ' selected' : '')} key={placement.id}>
              <button type="button" className="room-asset-card" disabled={!canEdit} aria-label={`${name}，摆放 ${index + 1}`} onClick={() => engine.current?.select(placement.id)}>
                <AssetThumbnail asset={asset} cache={thumbnailCache} />
                <span className="asset-short-name" title={name}>{name}</span>
              </button>
              <div className="room-placement-actions"><small>#{index + 1}</small>
                <button type="button" aria-label={'定位摆放' + (index + 1)} disabled={!canEdit} onClick={() => engine.current?.focus(placement.id)}>⌖</button>
                <button type="button" aria-label={'移除摆放' + (index + 1)} disabled={!canEdit} onClick={() => edit(room.name, room.placements.filter(p => p.id !== placement.id))}>×</button>
              </div>
            </div>;
          })}
        </div></div>}
        <div className="sidebar-bottom"><button type="button" onClick={() => openOverlay('backpack')}>打开个人背包 →</button></div>
      </aside>}
      <section className="scene-stage" aria-label="个人小屋三维空间"><div className="scene-canvas" ref={host} />
        {(loginRequired || loadError || save.status === 'loadFailed' || save.status === 'loading') && <div className="scene-blocked"><div><p>{loadError || save.message || (loginRequired ? '请登录后继续使用小屋。' : '正在读取小屋与模型…')}</p>{loginRequired ? <button type="button" onClick={() => openOverlay('account')}>登录后进入自己的小屋 →</button> : save.status !== 'loading' || loadError ? <button type="button" onClick={() => { if (saver.current && !loadError) void saver.current.load(); else setReloadKey(key => key + 1); }}>重试读取</button> : null}</div></div>}
        <div className="stage-label"><span className="stage-live" />{mode === 'edit' ? '斜俯视布置' : '第一人称参观'}<small>{visitor ? '仅展示主人已摆放并确认的物品' : '固定建筑与摆放物品分离'}</small><small className="desktop-input-hint">请使用配有键盘和鼠标的电脑操作 3D 场景。</small></div>
        {mode === 'edit' && <div className="scene-tools" role="toolbar" aria-label="变换工具">{([['translate', '↔', '移动'], ['rotate', '⟳', '旋转'], ['scale', '⤢', '等比缩放']] as const).map(([value, icon, label]) => <button type="button" key={value} disabled={!canEdit} aria-label={label} aria-pressed={tool === value} className={tool === value ? 'active' : ''} onClick={() => { setTool(value); engine.current?.setTool(value); }}><span>{icon}</span>{label}</button>)}<span className="tool-divider" /><button type="button" onClick={() => engine.current?.home()}>⌂ 全景</button></div>}
        {mode !== 'edit' && <><div className="visit-actions"><button type="button" onClick={() => engine.current?.home()}>↶ 回到入口</button><span>点击场景锁定鼠标 · WASD / 方向键行走 · Esc 释放</span></div><span className="crosshair" aria-hidden="true">＋</span></>}
        {mode === 'edit' && active && <div className="selection-card"><AssetThumbnail asset={catalogById.get(active.assetId)} cache={thumbnailCache} /><div><strong>{nameOf(active.assetId)}</strong><small>移动、旋转或等比缩放</small></div><button type="button" onClick={() => engine.current?.focus(active.id)}>定位</button><button type="button" aria-label="移除选中摆放" disabled={!canEdit} onClick={() => edit(room!.name, room!.placements.filter(p => p.id !== active.id))}>移除</button></div>}
        {mode === 'edit' && !active && room?.placements.length === 0 && <div className="empty-room"><span>从一件物品开始</span><p>从左侧添加模型或家具<br />通过三轴控件布置小屋</p></div>}
        {notice && <div className="scene-notice" role="alert">{notice}<button type="button" aria-label="收起提示" onClick={() => setNotice('')}>×</button></div>}
        <div className="stage-footer"><span>{mode === 'edit' ? '拖动三轴控件 · 滚轮缩放视角 · 鼠标拖动环绕' : '点击锁定鼠标后行走 · 参观不改变布局'}</span><span>共 {room?.placements.length ?? 0} 件摆放</span></div>
      </section>
    </main>
    {!visitor && <footer className="lab-bottom room-bottom"><p>{save.message || '完整布局在服务端确认后才标为已保存。'}{saver.current?.unsaved && <strong> 本页有未保存修改，分享页只展示服务端已确认布局。</strong>}</p><div>{owner && save.status === 'failed' && <button type="button" onClick={() => void saver.current?.flush()}>重试保存</button>}{owner && save.status === 'conflict' && <button type="button" onClick={() => { if (confirm('载入将放弃本页未保存修改，使用服务端已确认布局。')) void saver.current?.load(); }}>载入已确认版本</button>}<button type="button" disabled={!owner || !ownerRoom || shareBusy || save.status === 'loadFailed' || save.status === 'loading'} onClick={() => void toggleShare()}>{shareBusy ? '正在处理…' : hasSharePending ? '确认上次分享操作' : ownerRoom?.shareEnabled ? '关闭分享' : '开启分享'}</button></div></footer>}
    {!visitor && owner && ownerRoom?.shareUrl && <div className="room-share-panel"><span>{ownerRoom.shareEnabled ? '分享已开启' : '分享已关闭，重新开启沿用此链接'} · 服务端已确认布局</span><a href={ownerRoom.shareUrl} target="_blank" rel="noreferrer">{ownerRoom.shareUrl}</a><button type="button" onClick={() => void navigator.clipboard.writeText(new URL(ownerRoom.shareUrl!, location.origin).href).then(() => setShareNote('分享链接已复制。')).catch(() => setShareNote('复制未完成，可直接选中链接复制。'))}>复制链接</button>{shareNote && <small role="status">{shareNote}</small>}</div>}
    {!visitor && !ownerRoom?.shareUrl && shareNote && <p className="room-share-note" role="status">{shareNote}</p>}
    {!visitor && <>
      {overlay === 'menu' && <div className="t10-modal-backdrop room-menu-layer" onClick={closeOverlay}>
        <section className="t10-menu" role="dialog" aria-modal="true" aria-label="菜单" onClick={event => event.stopPropagation()}>
          <h2>菜单</h2>
          <button type="button" autoFocus onClick={() => openOverlay('account')}>账号设置</button>
          <a href="/">返回藏宝阁</a>
          <button type="button" onClick={closeOverlay}>继续小屋</button>
          <small>Esc 关闭</small>
        </section>
      </div>}
      <Backpack kind="account" open={overlay === 'account'} close={closeOverlay} onAccountChange={accountChanged}
        beforeSessionEnd={allowSessionEnd} beforeLogin={allowLogin} />
      <Backpack key={owner?.user.id ?? 'guest'} open={overlay === 'backpack'} close={closeOverlay} onAccountChange={accountChanged} beforeLogin={allowLogin} thumbnailCache={thumbnailCache} />
    </>}
  </div>;
}
