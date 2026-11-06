import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import ModelPreview from './ModelPreview.js';
import AssetThumbnail, { type ThumbnailCache } from './AssetThumbnail.js';
import { api, ApiError, submissionLabel, type Asset, type GenerationTask, type Me, type Page, type Submission } from './backpack-api.js';
import './backpack.css';

type Tab = 'assets' | 'tasks' | 'submissions';
type Pending = { path: string; method: string; body: Record<string, unknown> | FormData; key: string; label: string; actorId?: string; success: (data: any) => Promise<void> | void };
const storageKey = 'aholo:pending-generation';
const taskLabel = { processing: '生成中', succeeded: '已入背包', failed: '生成失败' };
const failureLabel: Record<string, string> = {
  DELIVERY_DEADLINE: '未能在交付期限内完成，已返还原提交日次数。',
  PROVIDER_FAILED: '模型生成失败，已返还原提交日次数。',
  SUBMISSION_REJECTED: '生成请求未被接受，已返还原提交日次数。',
};
async function loadedPages<T>(path: string, count: number): Promise<Page<T>> {
  const result: Page<T> = { items: [], nextCursor: null };
  for (let page = 0; page < count; page++) {
    const cursor = result.nextCursor;
    const next = await api<Page<T>>(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    result.items.push(...next.items);
    result.nextCursor = next.nextCursor;
    if (!next.nextCursor) break;
  }
  return result;
}
function safeStoredGeneration(): { path: string; body: Record<string, unknown>; key: string; actorId: string } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    return value?.path === '/generation-tasks' && typeof value.body?.inputFileId === 'string' && typeof value.key === 'string' && typeof value.actorId === 'string' ? value : null;
  } catch { return null; }
}
function forgetGeneration() { try { sessionStorage.removeItem(storageKey); } catch { /* Browser storage can be disabled. */ } }
function rememberGeneration(pending: Pending) {
  try { sessionStorage.setItem(storageKey, JSON.stringify({ path: pending.path, body: pending.body, key: pending.key, actorId: pending.actorId })); } catch { /* The mounted drawer still retains this request. */ }
}

interface DrawerProps {
  open: boolean;
  close: () => void;
  kind?: 'backpack' | 'account';
  onAccountChange?: (profile: Me | null, ended?: boolean) => void;
  beforeLogin?: (username: string) => boolean;
  beforeSessionEnd?: () => boolean;
  thumbnailCache?: ThumbnailCache;
}

export default function Backpack({ open, close, kind = 'backpack', onAccountChange, beforeSessionEnd, beforeLogin, thumbnailCache }: DrawerProps) {
  const account = kind === 'account';
  const title = account ? '账号设置' : '背包';
  const closeLabel = '关闭' + title;
  const accountChanged = useRef(onAccountChange);
  accountChanged.current = onAccountChange;
  const active = useRef(open); active.current = open;
  const drawer = useRef<HTMLElement>(null);
  const [me, setMe] = useState<Me | null>(null);
  const meRef = useRef(me); meRef.current = me;
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('assets');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetCursor, setAssetCursor] = useState<string | null>(null);
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [openingAsset, setOpeningAsset] = useState(false);
  const selectionSequence = useRef(0);
  const pageDepth = useRef({ assets: 1, tasks: 1 });
  const listRevision = useRef({ assets: 0, tasks: 0 });
  const reloadSequence = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const inputFile = useRef<{ file: File; id: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const mounted = useRef(true);
  const setRequest = (value: Pending | null) => { pendingRef.current = value; setPending(value); };
  // Submissions for the open asset, and the user's full submission history (投稿 tab).
  const [assetSubs, setAssetSubs] = useState<Submission[] | null>(null);
  const [history, setHistory] = useState<Submission[]>([]);
  const [subsRevision, setSubsRevision] = useState(0);
  useEffect(() => {
    setAssetSubs(null);
    if (!me || !selected) return;
    let live = true;
    void api<Page<Submission>>(`/submissions?assetId=${encodeURIComponent(selected)}`).then(page => { if (live) setAssetSubs(page.items); }).catch(() => { if (live) setAssetSubs([]); });
    return () => { live = false; };
  }, [me?.user.id, selected, subsRevision]);
  useEffect(() => {
    if (!me || tab !== 'submissions' || !open) return;
    let live = true;
    void api<Page<Submission>>('/submissions').then(page => { if (live) setHistory(page.items); }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '投稿记录读取失败。'); });
    return () => { live = false; };
  }, [me?.user.id, tab, open, subsRevision]);

  const clearLists = useCallback(() => {
    pageDepth.current = { assets: 1, tasks: 1 };
    listRevision.current.assets++; listRevision.current.tasks++;
    selectionSequence.current++;
    setAssets([]); setTasks([]); setAssetCursor(null); setTaskCursor(null);
    setSelected(null); selectedRef.current = null; setSelectedAsset(null); setOpeningAsset(false);
    setAssetSubs(null); setHistory([]);
  }, []);
  const reload = useCallback(async (silent = false) => {
    const version = epoch.current;
    const sequence = ++reloadSequence.current;
    const revisions = { ...listRevision.current };
    const depth = { ...pageDepth.current };
    try {
      const profile = await api<Me>('/me');
      const sameActor = meRef.current?.user.id === profile.user.id;
      const [bag, history] = account ? [null, null] : await Promise.all([
        loadedPages<Asset>('/assets', sameActor ? depth.assets : 1),
        loadedPages<GenerationTask>('/generation-tasks', sameActor ? depth.tasks : 1),
      ]);
      const selectedId = sameActor ? selectedRef.current : null;
      let detail: Asset | null = null;
      let missingDetail = false;
      if (selectedId) {
        try { detail = await api<Asset>(`/assets/${encodeURIComponent(selectedId)}`); }
        catch (reason) { if (reason instanceof ApiError && reason.status === 404) missingDetail = true; else throw reason; }
      }
      if (!mounted.current || version !== epoch.current || sequence !== reloadSequence.current) return;
      if (!sameActor && meRef.current) {
        epoch.current++;
        clearLists();
        setFile(null); inputFile.current = null;
        if (fileInput.current) fileInput.current.value = '';
        if (pendingRef.current?.actorId && pendingRef.current.actorId !== profile.user.id) setRequest(null);
      }
      setMe(profile); meRef.current = profile;
      // A concurrent load-more changes the prefix this request originally read.
      if (bag && (!sameActor || revisions.assets === listRevision.current.assets)) { setAssets(bag.items); setAssetCursor(bag.nextCursor); }
      if (history && (!sameActor || revisions.tasks === listRevision.current.tasks)) { setTasks(history.items); setTaskCursor(history.nextCursor); }
      if (selectedId && selectedId === selectedRef.current) {
        if (missingDetail) { setSelected(null); selectedRef.current = null; setSelectedAsset(null); setError('该藏品已不可访问，请刷新背包。'); }
        else if (detail) setSelectedAsset(detail);
      }
      if (active.current && !sameActor) accountChanged.current?.(profile);
      setLoading(false);
      return profile;
    } catch (reason) {
      if (!mounted.current || version !== epoch.current || sequence !== reloadSequence.current) return;
      if (reason instanceof ApiError && reason.status === 401) {
        setMe(null); meRef.current = null; clearLists();
        if (active.current) accountChanged.current?.(null);
      } else if (!silent) setError(reason instanceof Error ? reason.message : '背包读取失败，请重试。');
    } finally { if (mounted.current && version === epoch.current && sequence === reloadSequence.current) setLoading(false); }
  }, [account, clearLists]);

  async function loadMore(kind: 'assets' | 'tasks') {
    const cursor = kind === 'assets' ? assetCursor : taskCursor;
    if (!cursor || loadingMoreRef.current) return;
    const version = epoch.current;
    loadingMoreRef.current = true; setLoadingMore(true);
    listRevision.current[kind]++;
    try {
      if (kind === 'assets') {
        const page = await api<Page<Asset>>(`/assets?cursor=${encodeURIComponent(cursor)}`);
        if (!mounted.current || version !== epoch.current) return;
        setAssets(items => [...items, ...page.items.filter(item => !items.some(existing => existing.id === item.id))]);
        setAssetCursor(page.nextCursor);
      } else {
        const page = await api<Page<GenerationTask>>(`/generation-tasks?cursor=${encodeURIComponent(cursor)}`);
        if (!mounted.current || version !== epoch.current) return;
        setTasks(items => [...items, ...page.items.filter(item => !items.some(existing => existing.id === item.id))]);
        setTaskCursor(page.nextCursor);
      }
      pageDepth.current[kind]++; listRevision.current[kind]++;
    } catch (reason) { if (mounted.current && version === epoch.current) setError(reason instanceof Error ? reason.message : '加载失败，请重试。'); }
    finally { loadingMoreRef.current = false; if (mounted.current) setLoadingMore(false); }
  }

  async function openAsset(id: string) {
    const version = epoch.current, sequence = ++selectionSequence.current;
    setTab('assets'); setSelected(id); selectedRef.current = id; setOpeningAsset(true); setError('');
    try {
      const detail = await api<Asset>(`/assets/${encodeURIComponent(id)}`);
      if (!mounted.current || version !== epoch.current || sequence !== selectionSequence.current || selectedRef.current !== id) return;
      setSelectedAsset(detail);
    } catch (reason) {
      if (!mounted.current || version !== epoch.current || sequence !== selectionSequence.current || selectedRef.current !== id) return;
      setSelected(null); selectedRef.current = null; setSelectedAsset(null);
      setError(reason instanceof Error ? reason.message : '藏品读取失败，请重试。');
    } finally { if (mounted.current && sequence === selectionSequence.current) setOpeningAsset(false); }
  }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    if (account || !open || !me) return;
    const timer = window.setInterval(() => {
      if (document.hidden || busyRef.current) return;
      if (meRef.current?.activeTask) { void reload(true); return; }
      if (open) {
        const version = epoch.current;
        void api<Me>('/me').then(profile => {
          if (!mounted.current || !active.current || version !== epoch.current) return;
          if (profile.user.id !== meRef.current?.user.id) { void reload(true); return; }
          setMe(profile); meRef.current = profile;
        }).catch(reason => { if (active.current && reason instanceof ApiError && reason.status === 401) void reload(true); });
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [account, me?.user.id, open, reload]);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void reload();
  }, [open, reload]);

  async function completedGeneration() {
    forgetGeneration();
    setFile(null); inputFile.current = null;
    if (fileInput.current) fileInput.current.value = '';
    setTab('tasks');
    setMessage('任务已受理，离开页面后仍会继续。模型可预览后会进入背包。');
    await reload();
  }
  useEffect(() => {
    if (account || !me || pendingRef.current) return;
    const stored = safeStoredGeneration();
    if (!stored || stored.actorId !== me.user.id) return;
    setRequest({ ...stored, method: 'POST', label: '确认上次生成提交', success: completedGeneration });
    setError('上次生成提交尚未取得回执，请确认原请求结果。');
  }, [account, me?.user.id]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    drawer.current?.querySelector<HTMLButtonElement>('.t10-drawer-head button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !drawer.current) return;
      const controls = [...drawer.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !drawer.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !drawer.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap, true);
    return () => { window.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus(); };
  }, [open, close]);

  async function execute(action: Pending) {
    if (busyRef.current || (action.actorId && action.actorId !== meRef.current?.user.id)) return;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    setRequest(action);
    if (action.path === '/generation-tasks') rememberGeneration(action);
    let succeeded = false;
    let result: unknown;
    try {
      const headers: Record<string, string> = { 'Idempotency-Key': action.key };
      if (meRef.current) headers['X-CSRF-Token'] = meRef.current.csrfToken;
      if (!(action.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      result = await api(action.path, { method: action.method, headers, body: action.body instanceof FormData ? action.body : JSON.stringify(action.body) });
      setRequest(null);
      if (action.path === '/generation-tasks') forgetGeneration();
      succeeded = true;
    } catch (reason) {
      const definitive = reason instanceof ApiError && reason.status >= 400 && reason.status < 500;
      if (definitive) { setRequest(null); if (action.path === '/generation-tasks') forgetGeneration(); }
      if (reason instanceof ApiError && reason.status === 401 && action.actorId) {
        epoch.current++; setMe(null); meRef.current = null; clearLists();
        if (active.current) accountChanged.current?.(null);
      }
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试确认。');
      if (definitive) void reload(true);
    } finally { busyRef.current = false; setBusy(false); }
    if (succeeded) {
      try { await action.success(result); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '操作已完成，请刷新查看。'); }
    }
  }
  function write(path: string, body: Record<string, unknown> | FormData, label: string, success: Pending['success'], method = 'POST') {
    if (busyRef.current || pendingRef.current) return;
    void execute({ path, method, body, label, key: crypto.randomUUID(), actorId: me?.user.id, success });
  }
  function onAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const username = String(values.get('username')), password = String(values.get('password'));
    if (authMode === 'register') {
      write('/auth/register', { username, nickname: String(values.get('nickname')), password, confirmPassword: String(values.get('confirmPassword')) }, '重试注册', async () => {
        setAuthMode('login'); setMessage('注册成功，请用刚才的账号和密码登录。');
      });
    } else {
      if (beforeLogin && !beforeLogin(username)) return;
      write('/auth/login', { username, password }, '重试登录', async () => {
        epoch.current++;
        const profile = await reload();
        if (profile) accountChanged.current?.(profile);
        setMessage('已登录。');
      });
    }
  }
  function submitGeneration() {
    if (!file || !me || pendingRef.current || busyRef.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024 || file.size === 0) { setError('请选择一张不超过 10 MiB 的 PNG、JPEG 或 WebP 图片。'); return; }
    const create = (id: string) => write('/generation-tasks', { inputFileId: id }, '确认原生成请求', completedGeneration);
    if (inputFile.current?.file === file) { create(inputFile.current.id); return; }
    const form = new FormData(); form.set('file', file);
    write('/uploads/images', form, '重试图片上传', async (result: { inputFileId: string }) => { inputFile.current = { file, id: result.inputFileId }; create(result.inputFileId); });
  }
  const locked = busy || pending !== null;
  const asset = selectedAsset?.id === selected ? selectedAsset : assets.find(item => item.id === selected);
  function endSession(message: string) {
    epoch.current++;
    setMe(null); meRef.current = null;
    clearLists(); setFile(null); inputFile.current = null;
    accountChanged.current?.(null, true);
    setMessage(message);
  }
  return <div className="personal-drawer-layer" hidden={!open} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <aside ref={drawer} className="t10-drawer bag-drawer" role="dialog" aria-modal="true" aria-label={title}>
    <div className="t10-drawer-head"><div><h2>{account ? title : '我的背包'}</h2><small>{me ? `${me.user.nickname} · ${me.user.username}` : account ? '登录或创建账号' : '收藏从一张图片开始'}</small></div><button type="button" aria-label={closeLabel} onClick={close}>×</button></div>
    <div className="bag-scroll">
      {error && <div className="bag-notice error" role="alert">{error}</div>}
      {message && <div className="bag-notice" role="status">{message}</div>}
      {pending && !busy && !loading && <div className="bag-retry"><p>请先确认上次操作结果，避免重复提交。</p><button type="button" onClick={() => void execute(pending)}>{pending.label}</button></div>}
      {loading ? <p className="bag-muted" role="status">正在读取{title}…</p> : !me ? <>
        <div className="bag-auth-tabs"><button type="button" disabled={locked} aria-pressed={authMode === 'login'} onClick={() => { setAuthMode('login'); setError(''); }}>登录</button><button type="button" disabled={locked} aria-pressed={authMode === 'register'} onClick={() => { setAuthMode('register'); setError(''); }}>注册</button></div>
        <form className="bag-form" onSubmit={onAuth} key={authMode}>
          <label>用户名<input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" disabled={locked} placeholder="3–32 位字母、数字或下划线" /></label>
          {authMode === 'register' && <label>昵称<input name="nickname" required maxLength={40} autoComplete="nickname" disabled={locked} /></label>}
          <label>密码<input name="password" type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} required minLength={12} maxLength={128} disabled={locked} placeholder="12–128 个字符" /></label>
          {authMode === 'register' && <label>确认密码<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={locked} /></label>}
          <button className="bag-primary" type="submit" disabled={locked}>{busy ? '正在处理…' : authMode === 'login' ? account ? '登录账号' : '登录并打开背包' : '创建账号'}</button>
        </form>
        {!account && <p className="bag-muted">登录后可查看个人藏品、上传图片生成模型。每天按北京时间恢复默认 3 次额度。</p>}
      </> : account ? <section className="bag-account">
        <form className="bag-form" key={me.user.nickname} onSubmit={event => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          write('/me', { nickname: String(values.get('nickname')) }, '重试修改昵称', async () => {
            const profile = await reload();
            if (profile) accountChanged.current?.(profile);
            setMessage('昵称已更新。');
          }, 'PATCH');
        }}>
          <h3>个人资料</h3><p className="bag-muted">用户名：{me.user.username}</p><label>昵称<input name="nickname" required maxLength={40} defaultValue={me.user.nickname} disabled={locked} /></label><button type="submit" disabled={locked}>保存昵称</button>
        </form>
        <form className="bag-form" onSubmit={event => {
          event.preventDefault();
          if (beforeSessionEnd && !beforeSessionEnd()) return;
          const values = new FormData(event.currentTarget);
          write('/me/password', { oldPassword: String(values.get('oldPassword')), newPassword: String(values.get('newPassword')), confirmPassword: String(values.get('confirmPassword')) }, '重试修改密码', () => endSession('密码已修改，请重新登录。'));
        }}>
          <h3>修改密码</h3><label>原密码<input name="oldPassword" type="password" autoComplete="current-password" required minLength={12} maxLength={128} disabled={locked} /></label><label>新密码<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={locked} /></label><label>确认新密码<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={locked} /></label><button type="submit" disabled={locked}>修改并重新登录</button>
        </form>
        <button type="button" disabled={locked} onClick={() => {
          if (beforeSessionEnd && !beforeSessionEnd()) return;
          write('/auth/logout', {}, '重试退出登录', () => endSession('已退出登录。'));
        }}>退出登录</button>
      </section> : <>
        <nav className="bag-tabs" aria-label="背包栏目">{(['assets', 'tasks', 'submissions'] as const).map(key => <button key={key} type="button" aria-pressed={tab === key} onClick={() => { setTab(key); setSelected(null); selectedRef.current = null; selectionSequence.current++; setOpeningAsset(false); }}>{key === 'assets' ? '藏品' : key === 'tasks' ? '生成任务' : '投稿'}</button>)}</nav>
        {(tab === 'assets' || tab === 'tasks') && <section className="bag-generation" aria-label="图片生成">
          <div className="bag-quota"><span>今日可用 <strong>{me.quota.available}</strong> / {me.quota.total}</span><small>{me.quota.day} · 北京时间</small></div>
          {me.activeTask ? <p className="bag-muted">已有任务生成中，可离开等待。完成前不能发起新任务。</p> : <>
            <label className="bag-file"><span className="bag-file-trigger">选择一张图片</span><input ref={fileInput} aria-label="选择生成图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked || me.quota.available === 0} onChange={event => { setFile(event.target.files?.[0] ?? null); inputFile.current = null; setError(''); }} /><span>{file?.name ?? 'PNG / JPEG / WebP · 不超过 10 MiB'}</span></label>
            <button type="button" className="bag-primary" disabled={locked || !file || me.quota.available === 0} onClick={submitGeneration}>{busy ? '正在提交…' : '生成模型 · 使用 1 次'}</button>
            {me.quota.available === 0 && <p className="bag-muted">今日次数已用完，北京时间 00:00 更新。</p>}
          </>}
        </section>}
        {tab === 'assets' && (selected && openingAsset && !asset ? <p className="bag-muted" role="status">正在读取藏品…</p> : asset ? <section className="bag-asset-detail" aria-label="藏品详情">
          <button type="button" className="bag-text-button" onClick={() => { setSelected(null); selectedRef.current = null; selectionSequence.current++; setOpeningAsset(false); }}>← 返回全部藏品</button>
          {open && <ModelPreview fileId={asset.modelFileId} name={asset.name} />}
          <form className="bag-form" key={`${asset.id}:${asset.name}:${asset.description}`} onSubmit={event => {
            event.preventDefault(); const data = new FormData(event.currentTarget);
            write(`/assets/${asset.id}`, { name: String(data.get('name')), description: String(data.get('description')) }, '重试保存藏品资料', async () => { await reload(); setMessage('藏品资料已保存。'); }, 'PATCH');
          }}>
            <label>名称<input name="name" defaultValue={asset.name} required maxLength={80} disabled={locked} /></label>
            <label>简介<textarea name="description" defaultValue={asset.description} maxLength={2000} rows={4} disabled={locked} /></label>
            <button type="submit" disabled={locked}>保存资料</button>
          </form>
          <SubmissionPanel asset={asset} subs={assetSubs} locked={locked}
            submit={fields => write(`/assets/${asset.id}/submissions`, fields, '确认上次投稿', async () => { setSubsRevision(v => v + 1); setMessage('已提交，等待管理员审核。审核期间可以撤回。'); })}
            withdraw={id => write(`/submissions/${id}/withdraw`, {}, '确认上次撤回', async () => { setSubsRevision(v => v + 1); setMessage('申请已撤回，可修改资料后重新提交。'); })} />
        </section> : <section className="bag-collection" aria-label="个人藏品">
          <div className="bag-section-heading"><h3>个人藏品 <small>{assets.length}</small></h3><button type="button" className="bag-text-button" disabled={busy} onClick={() => void reload()}>刷新</button></div>
          {assets.length ? <div className="bag-grid">{assets.map(item => <button type="button" className="bag-asset-card" key={item.id} onClick={() => void openAsset(item.id)}><AssetThumbnail asset={item} cache={thumbnailCache} /><strong className="asset-short-name" title={item.name}>{item.name}</strong></button>)}</div> : <div className="bag-empty"><span className="t10-seal">囊</span><p>背包还空着</p><small>上传图片生成第一件藏品，完成后将在这里出现。</small></div>}
          {assetCursor && <button type="button" disabled={busy || loadingMore} onClick={() => void loadMore('assets')}>加载更多藏品</button>}
        </section>)}
        {tab === 'tasks' && <section className="bag-task-list" aria-label="生成任务列表">
          <div className="bag-section-heading"><h3>生成任务</h3><button type="button" className="bag-text-button" disabled={busy} onClick={() => void reload()}>刷新</button></div>
          {!tasks.length && <p className="bag-muted">还没有生成记录。</p>}
          {tasks.map(task => <article className="bag-task" key={task.id}><div><strong>{taskLabel[task.status]}</strong><time>{new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</time></div><small>{task.status === 'processing' ? '正在制作并检查模型，完成后自动入包。' : task.status === 'succeeded' ? '模型已进入个人背包，可旋转、缩放查看。' : failureLabel[task.errorCode ?? ''] ?? '未完成模型交付，已返还原提交日次数。'}</small>{task.status === 'succeeded' && task.assetId && <button type="button" className="bag-text-button" onClick={() => void openAsset(task.assetId!)}>查看藏品 →</button>}</article>)}
          {taskCursor && <button type="button" disabled={busy || loadingMore} onClick={() => void loadMore('tasks')}>加载更多任务</button>}
        </section>}
        {tab === 'submissions' && <section className="bag-task-list" aria-label="投稿记录">
          <div className="bag-section-heading"><h3>投稿记录</h3><button type="button" className="bag-text-button" disabled={busy} onClick={() => setSubsRevision(v => v + 1)}>刷新</button></div>
          <p className="bag-muted">在藏品详情中补齐公共资料即可申请加入藏宝阁；通过后进入候选库，由管理员安排展位。</p>
          {!history.length && <p className="bag-muted">还没有投稿。</p>}
          {history.map(item => <article className="bag-task" key={item.id}><div><strong>{submissionLabel[item.status]}</strong><time>{new Date(item.submittedAt).toLocaleString('zh-CN', { hour12: false })}</time></div>
            <small>{item.publicSnapshot?.name ?? '（模型已按风险规则删除）'}{item.status === 'approved' ? (item.slotNo ? ` · 正在展位 ${item.slotNo} 公开展出` : ' · 等待安排展位') : ''}</small>
            {item.status === 'rejected' && <small className="bag-reason">驳回原因：{item.rejectionReason}</small>}
            {item.status !== 'deleted' && <button type="button" className="bag-text-button" onClick={() => void openAsset(item.assetId)}>查看藏品 →</button>}</article>)}
        </section>}
      </>}
    </div>
    {account && me?.user.role === 'admin' && <a className="t10-drawer-link" href="/admin">管理后台 →</a>}
    <small className="t10-drawer-foot">Esc 关闭{!account && ' · 藏品仅本人可见'}</small>
    </aside>
  </div>;
}

/** PRD 7.6: apply from the asset detail with the full public data; one pending or candidate per model. */
function SubmissionPanel({ asset, subs, locked, submit, withdraw }: { asset: Asset; subs: Submission[] | null; locked: boolean; submit: (fields: Record<string, unknown>) => void; withdraw: (id: string) => void }) {
  if (!subs) return <section className="bag-submit"><h3>申请加入藏宝阁</h3><p className="bag-muted" role="status">正在读取投稿状态…</p></section>;
  const latest = subs[0];
  if (latest?.status === 'pending') return <section className="bag-submit"><h3>申请加入藏宝阁</h3>
    <p className="bag-muted">「{latest.publicSnapshot?.name}」待审核 · 提交于 {new Date(latest.submittedAt).toLocaleString('zh-CN', { hour12: false })}。审核前可以撤回。</p>
    <button type="button" disabled={locked} onClick={() => withdraw(latest.id)}>撤回申请</button></section>;
  if (latest?.status === 'approved') return <section className="bag-submit"><h3>申请加入藏宝阁</h3>
    <p className="bag-muted">已通过审核进入候选库{latest.slotNo ? `，正在展位 ${latest.slotNo} 公开展出` : '，等待管理员安排展位'}。公共资料保留提交时的内容与署名。</p></section>;
  const prior = latest && (latest.status === 'rejected' || latest.status === 'withdrawn') ? latest.publicSnapshot : null;
  return <section className="bag-submit"><h3>申请加入藏宝阁</h3>
    {latest?.status === 'rejected' && <div className="bag-notice error" role="status">上次申请已驳回：{latest.rejectionReason}。可修改资料后用同一模型重新申请。</div>}
    <p className="bag-muted">面向古玩、文物方向。除官网外均为必填，年代或材质不清楚可填“不详”。提交后署名为当前昵称，之后改昵称不影响已提交资料。</p>
    <form className="bag-form" key={`${asset.id}:${latest?.id ?? 'new'}`} onSubmit={event => {
      event.preventDefault(); const d = new FormData(event.currentTarget);
      submit(Object.fromEntries(['name', 'description', 'era', 'material', 'ownershipType', 'holderName', 'location', 'officialUrl'].map(k => [k, String(d.get(k) ?? '')])));
    }}>
      <label>公共名称<input name="name" required maxLength={80} defaultValue={prior?.name ?? asset.name} disabled={locked} /></label>
      <label>简介<textarea name="description" required maxLength={2000} rows={3} defaultValue={prior?.description ?? asset.description} disabled={locked} /></label>
      <div className="bag-form-row"><label>年代<input name="era" required maxLength={80} defaultValue={prior?.era ?? ''} placeholder="如：明代；不清楚填“不详”" disabled={locked} /></label>
        <label>材质<input name="material" required maxLength={80} defaultValue={prior?.material ?? ''} placeholder="如：瓷；不清楚填“不详”" disabled={locked} /></label></div>
      <label>归属类型<select name="ownershipType" required defaultValue={prior?.ownershipType ?? ''} disabled={locked}><option value="" disabled>请选择</option><option value="personal_collection">个人收藏</option><option value="museum">博物馆</option></select></label>
      <label>收藏方名称<input name="holderName" required maxLength={80} defaultValue={prior?.holderName ?? ''} placeholder="收藏者或博物馆名称" disabled={locked} /></label>
      <label>所在地<input name="location" required maxLength={200} defaultValue={prior?.location ?? ''} placeholder="城市 / 地区即可" disabled={locked} /></label>
      <label>官网（选填）<input name="officialUrl" type="url" maxLength={500} defaultValue={prior?.officialUrl ?? ''} placeholder="https://" disabled={locked} /></label>
      <button type="submit" className="bag-primary" disabled={locked}>提交审核</button>
    </form>
  </section>;
}
