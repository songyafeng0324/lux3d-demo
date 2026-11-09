import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import layout from '../../../../assets/t16/pavilion-layout.json';
import { DEFAULT_DAILY_QUOTA, GALLERY_SLOT_COUNT, slotMarker, type PublicDetails, type RoomModel } from '@aholo/contracts';
import ModelPreview from '../game/ModelPreview.js';
import PasswordField, { credentialError } from '../game/PasswordField.js';
import { api, ApiError, fileUrl, type Me, type Page, type PublicFields } from '../game/backpack-api.js';
import '../game/game.css';
import '../game/backpack.css';
import './admin.css';

type Tab = 'review' | 'gallery' | 'assets' | 'users';
interface ReviewItem { id: string; assetId: string; status: string; submittedAt: string; reviewedAt: string | null; rejectionReason: string | null; publicSnapshot: PublicDetails | null; assetName: string | null; applicant: { id: string; username: string; currentNickname: string }; model: RoomModel | null; originalImageId: string | null }
interface Candidate { id: string; assetId: string; source: 'user' | 'official'; publicSnapshot: PublicDetails; slotNo: number | null; applicantUsername: string | null; createdAt: string; model: RoomModel }
interface AdminAsset { id: string; sourceType: 'personal' | 'furniture' | 'official_candidate'; name: string; description: string; owner: { id: string; username: string; nickname: string } | null; createdAt: string; modelFileId: string; originalImageId: string | null; publication: { state: 'none' | 'pending' | 'candidate'; candidateId?: string; slotNo?: number | null }; publicSnapshot: PublicDetails | null; editable: boolean }
interface AdminUser { id: string; username: string; nickname: string; role: string; createdAt: string }
interface UserDetail { user: AdminUser; quota: { day: string; total: number; used: number; available: number; adjusted: boolean }; counts: { tasks: number; succeeded: number; assets: number }; tasks: Array<{ id: string; status: string; submittedDay: string; createdAt: string; assetId: string | null; errorCode: string | null }>; assets: Array<{ id: string; name: string; createdAt: string }> }
type Pending = { path: string; method: string; body: Record<string, unknown> | FormData; key: string; label: string; done: (data: any) => void | Promise<void> };

const SOURCE = { personal: '用户个人', furniture: '官方家具', official_candidate: '公共藏品（官方）' } as const;
const STATUS: Record<string, string> = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回', deleted: '模型已删除' };
const OWNERSHIP = { museum: '博物馆', personal_collection: '个人收藏' } as const;
const PUBLIC_KEYS = ['name', 'description', 'era', 'material', 'ownershipType', 'holderName', 'location', 'officialUrl'] as const;
const slotInfo = new Map((layout.exhibitSlots as Array<{ id: string; label: string }>).map(s => [s.id, s]));
const slotName = (n: number) => `${slotInfo.get(slotMarker(n))?.label ?? '展位'} · ${n}`;
const time = (v: string | null) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—';

export default function Admin() {
  const [me, setMe] = useState<Me | null>(null);
  const meRef = useRef(me); meRef.current = me;
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('review');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);

  const loadMe = useCallback(async () => {
    try { setMe(await api<Me>('/me', { cache: 'no-store' })); }
    catch (e) { setMe(null); if (!(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : '无法连接本地服务。'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadMe(); }, [loadMe]);

  /** Every write carries an idempotency key; an unconfirmed (network) result keeps the same key for a safe retry. */
  const execute = useCallback(async (action: Pending) => {
    setBusy(true); setError(''); setMessage(''); setPending(action);
    try {
      const headers: Record<string, string> = { 'Idempotency-Key': action.key };
      if (meRef.current) headers['X-CSRF-Token'] = meRef.current.csrfToken;
      if (!(action.body instanceof FormData)) headers['Content-Type'] = 'application/json';
      const data = await api(action.path, { method: action.method, headers, body: action.body instanceof FormData ? action.body : JSON.stringify(action.body) });
      setPending(null); setBusy(false); await action.done(data);
    } catch (e) {
      const definitive = e instanceof ApiError && e.status >= 400 && e.status < 500;
      if (definitive) setPending(null);
      if (e instanceof ApiError && e.status === 401) setMe(null);
      setError(e instanceof Error ? e.message : '操作未确认，请重试。');
      setBusy(false);
    }
  }, []);
  const write = useCallback((path: string, method: string, body: Pending['body'], label: string, done: Pending['done']) => {
    if (busy || pending) return;
    void execute({ path, method, body, label, key: crypto.randomUUID(), done });
  }, [busy, pending, execute]);
  const locked = busy || pending !== null;

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = new FormData(event.currentTarget);
    const username = String(d.get('username')), password = String(d.get('password'));
    const invalid = credentialError(username, password);
    if (invalid) { setError(invalid); return; }
    write('/auth/login', 'POST', { username, password }, '重试登录', async () => { await loadMe(); });
  }

  let body: ReactNode;
  if (loading) body = <p className="adm-muted" role="status">正在读取登录状态…</p>;
  else if (!me) body = <form className="bag-form adm-login" noValidate onSubmit={login}>
    <h2>管理员登录</h2>
    <label>用户名<input name="username" autoComplete="username" required disabled={locked} /></label>
    <PasswordField autoComplete="current-password" disabled={locked} />
    <button className="bag-primary" type="submit" disabled={locked}>登录</button>
    <p className="adm-muted">管理员由本机 seed:admin 预置；后台不提供注册、找回或重置密码。</p>
  </form>;
  else if (me.user.role !== 'admin') body = <div className="adm-empty"><h2>没有管理权限</h2><p>当前账号 {me.user.username} 是普通用户。管理后台仅限预置管理员使用。</p><a href="/">返回藏宝阁</a></div>;
  else {
    const props = { write, locked, revision, refresh, setMessage };
    body = <>
      <nav className="adm-tabs" aria-label="后台栏目">{([['review', '投稿审核'], ['gallery', '候选与展位'], ['assets', '资产与上传'], ['users', '用户与额度']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => { setTab(key); setError(''); setMessage(''); }}>{label}</button>)}</nav>
      {tab === 'review' && <ReviewTab {...props} />}
      {tab === 'gallery' && <GalleryTab {...props} />}
      {tab === 'assets' && <AssetsTab {...props} />}
      {tab === 'users' && <UsersTab {...props} />}
    </>;
  }
  return <div className="t10-game adm">
    <header className="adm-top">
      <div className="t10-place"><span className="t10-seal">藏</span><div><strong>藏宝阁 · 管理后台</strong><small>{me ? `${me.user.nickname} · ${me.user.username}` : '本地 MVP'}</small></div></div>
      <nav className="adm-links"><a href="/">藏宝阁</a><a href="/room">个人小屋</a>{me && <button type="button" disabled={locked} onClick={() => write('/auth/logout', 'POST', {}, '重试退出', () => { setMe(null); })}>退出</button>}</nav>
    </header>
    <main className="adm-main">
      {error && <div className="bag-notice error" role="alert">{error}</div>}
      {message && <div className="bag-notice" role="status">{message}</div>}
      {pending && !busy && <div className="bag-retry"><p>上次操作结果尚未确认，请先确认，避免重复提交。</p><button type="button" onClick={() => void execute(pending)}>{pending.label}</button><button type="button" className="bag-text-button" onClick={() => setPending(null)}>放弃确认</button></div>}
      {body}
    </main>
  </div>;
}

interface TabProps { write: (path: string, method: string, body: Pending['body'], label: string, done: Pending['done']) => void; locked: boolean; revision: number; refresh: () => void; setMessage: (m: string) => void }

function useLoad<T>(path: string | null, revision: number) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!path) { setData(null); return; }
    let live = true; setError('');
    api<T>(path, { cache: 'no-store' }).then(v => { if (live) setData(v); }).catch(e => { if (live) { setData(null); setError(e instanceof Error ? e.message : '读取失败'); } });
    return () => { live = false; };
  }, [path, revision]);
  return { data, error };
}

function Facts({ s }: { s: PublicDetails | PublicFields }) {
  return <dl className="t10-exhibit-facts">
    <div><dt>年代</dt><dd>{s.era}</dd></div><div><dt>材质</dt><dd>{s.material}</dd></div>
    <div><dt>归属</dt><dd>{OWNERSHIP[s.ownershipType]}</dd></div><div><dt>收藏方</dt><dd>{s.holderName}</dd></div>
    <div><dt>所在地</dt><dd>{s.location}</dd></div><div><dt>官网</dt><dd>{s.officialUrl || '（未填写）'}</dd></div>
    {'sourceNickname' in s && <div><dt>署名</dt><dd>{s.sourceNickname}</dd></div>}
  </dl>;
}

function ReviewTab({ write, locked, revision, refresh, setMessage }: TabProps) {
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error } = useLoad<Page<ReviewItem>>(`/admin/submissions?status=${status}`, revision);
  const item = data?.items.find(i => i.id === selected) ?? null;
  const [reason, setReason] = useState('');
  useEffect(() => { setReason(''); }, [selected]);
  const decide = (decision: 'approve' | 'reject') => item?.publicSnapshot && write(`/admin/submissions/${item.id}/review`, 'POST', decision === 'approve' ? { decision } : { decision, reason }, decision === 'approve' ? '确认上次通过' : '确认上次驳回', () => {
    setMessage(decision === 'approve' ? `「${item.publicSnapshot!.name}」已通过，进入候选库（不会自动展出）。` : `已驳回「${item.publicSnapshot!.name}」，用户可看到原因并修改后重提。`); setSelected(null); refresh();
  });
  return <section className="adm-split">
    <div className="adm-list">
      <div className="adm-list-head"><h2>投稿审核</h2><select aria-label="状态筛选" value={status} onChange={e => { setStatus(e.target.value); setSelected(null); }}><option value="pending">待审核（最早优先）</option><option value="all">全部记录</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="withdrawn">已撤回</option></select></div>
      {error && <p className="adm-error">{error}</p>}
      {data && !data.items.length && <p className="adm-muted">{status === 'pending' ? '暂无待审核申请。' : '没有记录。'}</p>}
      {data?.items.map(i => <button type="button" key={i.id} className="adm-row" aria-pressed={selected === i.id} onClick={() => setSelected(i.id)}>
        <strong>{i.publicSnapshot?.name ?? '（已删除，资料已清除）'}</strong><span>{STATUS[i.status]} · {i.applicant.username}</span><small>{time(i.submittedAt)}</small></button>)}
    </div>
    <div className="adm-detail">
      {!item ? <p className="adm-muted">选择左侧申请查看本次模型、原图和提交资料。</p> : !item.publicSnapshot ? <p className="adm-muted">该模型已按风险规则删除，申请资料已清除。</p> : <>
        <div className="adm-detail-head"><div><h2>{item.publicSnapshot.name}</h2><p className="adm-muted">申请人 {item.applicant.username}（提交时昵称：{item.publicSnapshot.sourceNickname}；当前：{item.applicant.currentNickname}）· 提交于 {time(item.submittedAt)}</p></div><span className="adm-pill">{STATUS[item.status]}</span></div>
        <div className="adm-media">
          {item.model ? <ModelPreview fileId={item.model.modelFileId} name={item.publicSnapshot.name} /> : <p className="adm-muted">模型已删除。</p>}
          {item.originalImageId && <figure><img src={fileUrl(item.originalImageId)} alt="生成所用原图" /><figcaption>生成所用原图</figcaption></figure>}
        </div>
        <p className="adm-desc">简介：{item.publicSnapshot.description}</p>
        <Facts s={item.publicSnapshot} />
        {item.status === 'rejected' && <p className="adm-muted">驳回原因：{item.rejectionReason}</p>}
        {item.status === 'pending' && <div className="adm-actions">
          <button type="button" className="bag-primary" disabled={locked} onClick={() => decide('approve')}>通过，进入候选库</button>
          <label className="adm-reason">驳回原因（用户可见）<textarea value={reason} maxLength={500} rows={2} onChange={e => setReason(e.target.value)} disabled={locked} /></label>
          <button type="button" disabled={locked || !reason.trim()} onClick={() => decide('reject')}>驳回</button>
          <small className="adm-muted">只能通过或驳回，不能代改申请资料。</small>
        </div>}
      </>}
    </div>
  </section>;
}

function GalleryTab({ write, locked, revision, refresh, setMessage }: TabProps) {
  const gallery = useLoad<{ version: number; slots: Array<{ slotNo: number; candidateId: string | null }> }>('/admin/gallery', revision);
  const candidates = useLoad<Page<Candidate>>('/admin/candidates', revision);
  const [draft, setDraft] = useState<Array<string | null> | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'user' | 'official' | 'free'>('all');
  const draftVersion = useRef<number | null>(null);
  // Unrelated refreshes keep the unsaved arrangement; a new published version (or explicit reload) replaces it.
  useEffect(() => { if (gallery.data && draftVersion.current !== gallery.data.version) { draftVersion.current = gallery.data.version; setDraft(gallery.data.slots.map(s => s.candidateId)); } }, [gallery.data]);
  const byId = useMemo(() => new Map((candidates.data?.items ?? []).map(c => [c.id, c])), [candidates.data]);
  if (!draft || !gallery.data) return <p className="adm-muted">{gallery.error || candidates.error || '正在读取展位…'}</p>;
  const changed = draft.some((c, i) => c !== gallery.data!.slots[i].candidateId);
  const place = (slotIndex: number, candidateId: string | null) => setDraft(d => d!.map((c, i) => i === slotIndex ? candidateId : c === candidateId && candidateId ? null : c));
  const list = (candidates.data?.items ?? []).filter(c => filter === 'all' || (filter === 'free' ? !draft.includes(c.id) : c.source === filter));
  const save = () => write('/admin/gallery', 'PUT', { baseVersion: gallery.data!.version, slots: draft.map((candidateId, i) => ({ slotNo: i + 1, candidateId })) }, '确认上次发布', (r: { publishedVersion: number }) => {
    setMessage(`已发布展陈第 ${r.publishedVersion} 版。新进入或刷新的参观者看到新安排，已打开页面保持原展陈。`); refresh();
  });
  return <section className="adm-gallery">
    <div className="adm-list-head"><h2>30 个展位 <small>当前第 {gallery.data.version} 版 · 已安排 {draft.filter(Boolean).length}/{GALLERY_SLOT_COUNT}</small></h2>
      <div className="adm-actions-inline"><button type="button" disabled={locked} onClick={() => { draftVersion.current = null; refresh(); }}>载入最新安排</button><button type="button" disabled={locked || !changed} onClick={() => setDraft(gallery.data!.slots.map(s => s.candidateId))}>放弃修改</button><button type="button" className="bag-primary" disabled={locked || !changed} onClick={save}>保存并发布</button></div></div>
    <p className="adm-muted">点选展位，再从候选库选择藏品；系统自动居中并适配大小，没有手动高度/旋转/缩放。同一候选只占一个展位，可以留空。撤下或替换只解除展位关系，不删除模型或用户小屋摆放。</p>
    <div className="adm-slots">{draft.map((id, i) => { const c = id ? byId.get(id) : null; return <button type="button" key={i} className="adm-slot" aria-pressed={active === i} data-changed={id !== gallery.data!.slots[i].candidateId} onClick={() => setActive(i)}>
      <small>{slotName(i + 1)}</small><strong>{c ? c.publicSnapshot.name : id ? '（候选不可用）' : '空'}</strong>{c && <span>{c.source === 'official' ? '官方馆藏' : c.publicSnapshot.sourceNickname}</span>}</button>; })}</div>
    {active !== null && <div className="adm-picker">
      <div className="adm-list-head"><h3>展位 {slotName(active + 1)}</h3><div className="adm-actions-inline"><select aria-label="候选筛选" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">全部候选（{candidates.data?.items.length ?? 0}）</option><option value="free">未安排</option><option value="user">用户投稿</option><option value="official">官方录入</option></select>
        <button type="button" disabled={!draft[active]} onClick={() => place(active, null)}>撤下此位</button><button type="button" className="bag-text-button" onClick={() => setActive(null)}>收起</button></div></div>
      <div className="adm-cands">{list.map(c => { const at = draft.indexOf(c.id); return <button type="button" key={c.id} className="adm-cand" aria-pressed={draft[active] === c.id} onClick={() => place(active, c.id)}>
        <strong>{c.publicSnapshot.name}</strong><span>{c.source === 'official' ? '官方馆藏' : `投稿 · ${c.publicSnapshot.sourceNickname}`}</span><small>{at >= 0 ? `当前在展位 ${at + 1}${at === active ? '' : '，选择后移到此位'}` : '未安排'}</small></button>; })}
        {!list.length && <p className="adm-muted">没有符合条件的候选。</p>}</div>
    </div>}
  </section>;
}

function PublicInputs({ initial, locked }: { initial?: Partial<PublicFields>; locked: boolean }) {
  return <>
    <label>名称<input name="name" required maxLength={80} defaultValue={initial?.name ?? ''} disabled={locked} /></label>
    <label>简介<textarea name="description" required maxLength={2000} rows={3} defaultValue={initial?.description ?? ''} disabled={locked} /></label>
    <div className="bag-form-row"><label>年代<input name="era" required maxLength={80} defaultValue={initial?.era ?? ''} placeholder="不清楚填“不详”" disabled={locked} /></label><label>材质<input name="material" required maxLength={80} defaultValue={initial?.material ?? ''} placeholder="不清楚填“不详”" disabled={locked} /></label></div>
    <div className="bag-form-row"><label>归属类型<select name="ownershipType" required defaultValue={initial?.ownershipType ?? ''} disabled={locked}><option value="" disabled>请选择</option><option value="museum">博物馆</option><option value="personal_collection">个人收藏</option></select></label><label>收藏方名称<input name="holderName" required maxLength={80} defaultValue={initial?.holderName ?? ''} disabled={locked} /></label></div>
    <div className="bag-form-row"><label>所在地<input name="location" required maxLength={200} defaultValue={initial?.location ?? ''} disabled={locked} /></label><label>官网（选填）<input name="officialUrl" type="url" maxLength={500} defaultValue={initial?.officialUrl ?? ''} disabled={locked} /></label></div>
  </>;
}
const formObject = (form: HTMLFormElement, keys: readonly string[]) => { const d = new FormData(form); return Object.fromEntries(keys.map(k => [k, String(d.get(k) ?? '')])); };

function AssetsTab({ write, locked, revision, refresh, setMessage }: TabProps) {
  const [source, setSource] = useState(''), [q, setQ] = useState(''), [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const { data, error } = useLoad<Page<AdminAsset>>(`/admin/assets?${new URLSearchParams({ ...(source ? { source } : {}), ...(query ? { q: query } : {}) })}`, revision);
  const [extra, setExtra] = useState<AdminAsset[]>([]), [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { setExtra([]); setCursor(data?.nextCursor ?? null); }, [data]);
  const items = [...(data?.items ?? []), ...extra];
  const asset = items.find(a => a.id === selected) ?? null;
  useEffect(() => { setMode('view'); }, [selected]);
  const [uploadKind, setUploadKind] = useState<'furniture' | 'official_candidate'>('furniture');
  const [imports, setImports] = useState<Array<{ id: string; name: string; status: string; errorCode?: string | null }>>([]);
  useEffect(() => {
    if (!imports.some(i => i.status === 'processing')) return;
    const timer = setInterval(() => { for (const i of imports.filter(x => x.status === 'processing')) api<{ status: string; errorCode: string | null }>(`/admin/imports/${i.id}`).then(r => { if (r.status !== 'processing') { setImports(list => list.map(x => x.id === i.id ? { ...x, status: r.status, errorCode: r.errorCode } : x)); if (r.status === 'succeeded') refresh(); } }).catch(() => undefined); }, 2000);
    return () => clearInterval(timer);
  }, [imports, refresh]);
  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, d = new FormData(form), file = d.get('file');
    if (!(file instanceof File) || !/\.glb$/i.test(file.name)) { setMessage('请选择 .glb 模型文件。'); return; }
    const body = new FormData(); body.set('sourceType', uploadKind);
    for (const k of uploadKind === 'furniture' ? ['name', 'description'] : PUBLIC_KEYS) body.set(k, String(d.get(k) ?? ''));
    body.set('file', file);
    write('/admin/assets', 'POST', body, '确认上次上传', (r: { id: string }) => { setImports(list => [{ id: r.id, name: String(d.get('name')), status: 'processing' }, ...list]); setMessage('已受理，正在校验与渲染检查；通过后才会作为可用资产出现。'); form.reset(); });
  }
  async function more() { if (!cursor) return; const params = new URLSearchParams({ ...(source ? { source } : {}), ...(query ? { q: query } : {}), cursor }); const next = await api<Page<AdminAsset>>(`/admin/assets?${params}`); setExtra(x => [...x, ...next.items]); setCursor(next.nextCursor); }
  return <section className="adm-split">
    <div className="adm-list">
      <form className="bag-form adm-upload" onSubmit={upload}>
        <h2>上传现成模型</h2>
        <div className="adm-seg" role="radiogroup" aria-label="用途">{(['furniture', 'official_candidate'] as const).map(k => <button type="button" key={k} role="radio" aria-checked={uploadKind === k} onClick={() => setUploadKind(k)} disabled={locked}>{k === 'furniture' ? '官方家具' : '公共藏品'}</button>)}</div>
        <label>GLB 模型<input name="file" type="file" accept=".glb,model/gltf-binary" required disabled={locked} /></label>
        {uploadKind === 'furniture' ? <><label>名称<input name="name" required maxLength={80} disabled={locked} /></label><label>简介（选填）<textarea name="description" maxLength={2000} rows={2} disabled={locked} /></label></> : <PublicInputs locked={locked} key="official" />}
        <button type="submit" className="bag-primary" disabled={locked}>上传</button>
        <small className="adm-muted">{uploadKind === 'furniture' ? '家具成功后供所有用户布置，不需要文物资料。' : '公共藏品成功后直接进入候选库，署名“官方馆藏”，不自动展出、不进入家具。'}后台只接收现成模型，没有图片生成入口。</small>
        {imports.map(i => <p key={i.id} className={i.status === 'failed' ? 'adm-error' : 'adm-muted'}>「{i.name}」{i.status === 'processing' ? '校验中…' : i.status === 'succeeded' ? '已可用' : `未通过校验（${i.errorCode ?? '未知'}），不会成为可用资产`}</p>)}
      </form>
      <div className="adm-list-head"><h2>全部资产</h2></div>
      <form className="adm-filter" onSubmit={e => { e.preventDefault(); setQuery(q.trim()); }}>
        <select aria-label="来源" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option><option value="personal">用户个人</option><option value="furniture">官方家具</option><option value="official_candidate">公共藏品</option></select>
        <input aria-label="搜索" value={q} onChange={e => setQ(e.target.value)} placeholder="名称 / 用户名 / 昵称" /><button type="submit">搜索</button>
      </form>
      {error && <p className="adm-error">{error}</p>}
      {items.map(a => <button type="button" key={a.id} className="adm-row" aria-pressed={selected === a.id} onClick={() => setSelected(a.id)}>
        <strong>{a.name}</strong><span>{SOURCE[a.sourceType]}{a.owner ? ` · ${a.owner.username}` : ''}</span><small>{a.publication.state === 'pending' ? '待审核中' : a.publication.state === 'candidate' ? (a.publication.slotNo ? `候选 · 展位 ${a.publication.slotNo}` : '候选') : time(a.createdAt)}</small></button>)}
      {cursor && <button type="button" onClick={() => void more()}>加载更多</button>}
    </div>
    <div className="adm-detail">
      {!asset ? <p className="adm-muted">选择资产查看预览、维护自录资料，或执行风险删除。</p> : <>
        <div className="adm-detail-head"><div><h2>{asset.name}</h2><p className="adm-muted">{SOURCE[asset.sourceType]}{asset.owner ? ` · 归属 ${asset.owner.username}（${asset.owner.nickname}）` : ''} · {time(asset.createdAt)}</p></div></div>
        <ModelPreview fileId={asset.modelFileId} name={asset.name} />
        {mode === 'view' && <>
          <p className="adm-desc">简介：{asset.description || '（无简介）'}</p>
          {asset.publicSnapshot && <Facts s={asset.publicSnapshot} />}
          <div className="adm-actions-inline">
            {asset.editable ? <button type="button" disabled={locked} onClick={() => setMode('edit')}>编辑文字资料</button> : <small className="adm-muted">用户个人资产的名称、简介由本人维护，后台不代改。</small>}
            <button type="button" className="adm-danger" disabled={locked} onClick={() => setMode('delete')}>风险删除…</button>
          </div>
        </>}
        {mode === 'edit' && <form className="bag-form" onSubmit={e => { e.preventDefault(); const body = asset.sourceType === 'official_candidate' ? formObject(e.currentTarget, PUBLIC_KEYS) : formObject(e.currentTarget, ['name', 'description']);
          write(`/admin/assets/${asset.id}`, 'PATCH', body, '确认上次保存', (r: { galleryVersion: number | null }) => { setMessage(r.galleryVersion ? `资料已更新，并已发布展陈第 ${r.galleryVersion} 版。` : '资料已更新。'); setMode('view'); refresh(); }); }}>
          {asset.sourceType === 'official_candidate' ? <PublicInputs initial={asset.publicSnapshot ?? undefined} locked={locked} /> : <><label>名称<input name="name" required maxLength={80} defaultValue={asset.name} disabled={locked} /></label><label>简介<textarea name="description" maxLength={2000} rows={3} defaultValue={asset.description} disabled={locked} /></label></>}
          <small className="adm-muted">只能修改文字，不能替换模型文件；换模型请另行上传新资产，旧摆放与展位不会自动切换。</small>
          <div className="adm-actions-inline"><button type="submit" className="bag-primary" disabled={locked}>保存</button><button type="button" onClick={() => setMode('view')}>取消</button></div>
        </form>}
        {mode === 'delete' && <div className="adm-confirm" role="alert">
          <h3>确认按风险规则删除「{asset.name}」？</h3>
          <p>将同时清理：个人背包中的该模型、所有小屋里的对应摆放、待审申请与候选、所在公共展位。其他模型与布局保留。删除后没有占位，也不能恢复。已打开的分享页/藏宝阁保留已载入画面，新进入或刷新按删除后状态显示。</p>
          <div className="adm-actions-inline"><button type="button" className="adm-danger" disabled={locked} onClick={() => write(`/admin/assets/${asset.id}`, 'DELETE', {}, '确认上次删除', (r: { roomsUpdated: number; placementsRemoved: number; slotNo: number | null; candidateRemoved: boolean }) => {
            setMessage(`已删除。清理 ${r.roomsUpdated} 间小屋中的 ${r.placementsRemoved} 处摆放${r.candidateRemoved ? '，移出候选库' : ''}${r.slotNo ? `，展位 ${r.slotNo} 已清空并发布新展陈` : ''}。`); setSelected(null); refresh(); })}>确认删除</button><button type="button" onClick={() => setMode('view')}>取消</button></div>
        </div>}
      </>}
    </div>
  </section>;
}

function UsersTab({ write, locked, revision, refresh, setMessage }: TabProps) {
  const [q, setQ] = useState(''), [query, setQuery] = useState(''), [selected, setSelected] = useState<string | null>(null);
  const list = useLoad<Page<AdminUser>>(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`, revision);
  const detail = useLoad<UserDetail>(selected ? `/admin/users/${selected}` : null, revision);
  const d = detail.data;
  return <section className="adm-split">
    <div className="adm-list">
      <div className="adm-list-head"><h2>用户</h2></div>
      <form className="adm-filter" onSubmit={e => { e.preventDefault(); setQuery(q.trim()); }}><input aria-label="搜索用户" value={q} onChange={e => setQ(e.target.value)} placeholder="用户名 / 昵称" /><button type="submit">搜索</button></form>
      {list.error && <p className="adm-error">{list.error}</p>}
      {list.data?.items.map(u => <button type="button" key={u.id} className="adm-row" aria-pressed={selected === u.id} onClick={() => setSelected(u.id)}><strong>{u.username}</strong><span>{u.nickname}{u.role === 'admin' ? ' · 管理员' : ''}</span><small>注册于 {time(u.createdAt)}</small></button>)}
    </div>
    <div className="adm-detail">
      {!selected ? <p className="adm-muted">选择用户查看账号、次数、任务与资产，并调整当天总额度。</p> : !d ? <p className="adm-muted">{detail.error || '正在读取…'}</p> : <>
        <div className="adm-detail-head"><div><h2>{d.user.username}</h2><p className="adm-muted">昵称 {d.user.nickname} · 注册于 {time(d.user.createdAt)} · 任务 {d.counts.tasks}（成功 {d.counts.succeeded}）· 资产 {d.counts.assets}</p></div></div>
        <div className="adm-quota">
          <div><span>今日（{d.quota.day} 北京时间）</span><strong>{d.quota.available}</strong><small>可用 · 总额 {d.quota.total}{d.quota.adjusted ? '（已调整）' : '（默认）'} · 已用 {d.quota.used}</small></div>
          <form onSubmit={e => { e.preventDefault(); const total = Number(new FormData(e.currentTarget).get('total')); write(`/admin/users/${d.user.id}/quota`, 'PUT', { total }, '确认上次调额', (r: UserDetail['quota']) => { setMessage(`已把 ${d.user.username} 今天的总额度调为 ${r.total}，当前可用 ${r.available}。已用不清零，在途任务不受影响。`); refresh(); }); }}>
            <label>当天总额度<input name="total" type="number" min={0} max={1000} step={1} required defaultValue={d.quota.total} key={d.quota.total} disabled={locked} /></label><button type="submit" disabled={locked}>调整</button>
          </form>
          <small className="adm-muted">只影响今天。北京时间 00:00 恢复默认 {DEFAULT_DAILY_QUOTA} 次。不提供改资料、编辑小屋、停用账号或重置密码。</small>
        </div>
        <h3>最近任务</h3>
        {!d.tasks.length && <p className="adm-muted">没有生成任务。</p>}
        <div className="adm-table">{d.tasks.map(t => <div key={t.id}><span>{t.status === 'succeeded' ? '成功' : t.status === 'failed' ? '失败' : '处理中'}</span><span>{t.submittedDay}</span><span>{time(t.createdAt)}</span><span>{t.errorCode ?? ''}</span></div>)}</div>
        <h3>个人资产</h3>
        {!d.assets.length && <p className="adm-muted">没有个人资产。</p>}
        <div className="adm-table">{d.assets.map(a => <div key={a.id}><span>{a.name}</span><span>{time(a.createdAt)}</span></div>)}</div>
      </>}
    </div>
  </section>;
}
