import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { ApiEnvelope, ReadinessData } from '@aholo/contracts';

const SceneLab = lazy(() => import('./scene/SceneLab.js'));
const Game = lazy(() => import('./game/Game.js'));
const Room = lazy(() => import('./room/Room.js'));
const Admin = lazy(() => import('./admin/Admin.js'));
const loading = (text: string, dark = false) => <p style={{ margin: 0, padding: 40, minHeight: '100dvh', background: dark ? '#0f0c0a' : undefined, color: dark ? '#b9ab92' : undefined }}>{text}</p>;

const names = { database: '数据库', storage: '私有文件存储', worker: '后台进程' } as const;

export function App() {
  if (location.pathname === '/admin') return <Suspense fallback={loading('正在打开管理后台…', true)}><Admin /></Suspense>;
  if (location.pathname === '/room') return <Suspense fallback={loading('正在打开个人小屋…')}><Room /></Suspense>;
  const shared = location.pathname.match(/^\/shared\/([^/]+)\/?$/);
  if (shared) return <Suspense fallback={loading('正在打开分享小屋…')}><Room shareToken={shared[1]} /></Suspense>;
  if (location.pathname === "/lab/t04") return <Suspense fallback={loading('正在准备古建场景…')}><SceneLab /></Suspense>;
  if (location.pathname === '/workbench') return <Workbench />;
  return <Suspense fallback={loading('正在打开藏宝阁…', true)}><Game /></Suspense>;
}

function Workbench() {
  const [health, setHealth] = useState<ReadinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/v1/health/ready', { cache: 'no-store', signal });
      const body = await response.json() as ApiEnvelope<ReadinessData>;
      if (!body.data?.checks) throw new Error('invalid response');
      setHealth(body.data);
    } catch {
      if (signal?.aborted) return;
      setHealth(null);
      setError('暂时无法连接本地服务，请确认 API 已启动后重试。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const ready = health?.ready === true;
  return (
    <div className="workbench">
      <header className="topbar">
        <a className="brand" href="/workbench" aria-label="本地工作台"><span className="seal">藏</span><span>藏宝阁与个人小屋<small>LOCAL WORKSPACE</small></span></a>
        <span className="local-label"><span />本地开发</span>
      </header>
      <main>
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">从一件藏品，开始一个小世界</p>
          <h1 id="page-title">本地工作台<span>查看服务与生成状态。</span></h1>
          <p className="lead">这里检查本机数据库、私有存储、后台任务与生成入口的实时状态。</p>
        </section>

        <section className="status-panel" aria-labelledby="status-title">
          <div className="panel-heading">
            <div><p className="eyebrow">ENVIRONMENT</p><h2 id="status-title">运行状态</h2></div>
            <button type="button" disabled={loading} onClick={() => void refresh()}><span aria-hidden="true">↻</span>{loading ? '检查中' : '重新检查'}</button>
          </div>
          <div className={`summary ${ready ? 'healthy' : ''}`} role="status" aria-live="polite">
            <span className="status-dot" />
            <span>{loading ? '正在连接本地服务…' : error || (ready ? '基础服务可用' : '部分基础服务尚未就绪')}</span>
          </div>
          <div className="checks">
            {(Object.keys(names) as Array<keyof typeof names>).map((key, index) => (
              <article className="check" key={key}>
                <span className="check-number">0{index + 1}</span><h3>{names[key]}</h3>
                <span className={`pill ${health?.checks[key] === 'ok' ? 'ok' : ''}`}>
                  {loading ? '检查中' : health?.checks[key] === 'ok' ? '已连接' : health ? '待就绪' : '未连接'}
                </span>
                <p>{key === 'database' ? '保存账号、任务和房间记录' : key === 'storage' ? '在本机持久保存图片与模型' : '关闭网页后继续处理生成任务'}</p>
              </article>
            ))}
          </div>
          <p className="checked-at">{health ? `最近检查 ${new Date(health.checkedAt).toLocaleString('zh-CN')}` : '状态由本地 API 实时读取'}</p>
        </section>

        <section className="next-section" aria-labelledby="next-title">
          <div><p className="eyebrow">CREATE & COLLECT</p><h2 id="next-title">从图片到个人藏品。</h2></div>
          <p>账号、额度、图片生成与个人背包已接入。进入藏宝阁后按 B 打开背包，即可登录、提交图片并查看模型；前往个人小屋布置藏品并开启只读分享。投稿审核、30 展位策展与公共展陈已接入；管理员登录 /admin 管理。</p>
          <a href="/" style={{display:"inline-block",marginBottom:8,marginRight:20,color:"#486747"}}>进入藏宝阁与背包 →</a>
          <a href="/room" style={{display:"inline-block",marginBottom:16,marginRight:20,color:"#486747"}}>进入个人小屋 →</a>
          <a href="/admin" style={{display:"inline-block",marginBottom:16,color:"#486747"}}>管理后台 →</a>
          <div className="next-tags"><span>单图生成</span><span>个人小屋</span><span>公共藏宝阁</span></div>
          {health && <p className="configuration">Lux3D 配置：{health.generation.configured ? '已检测到服务端配置' : '尚未配置'}。生成入口：{health.generationReady ? '可用' : '未启用或暂未就绪'}。当前页面仅检查状态，生成请前往背包。</p>}
        </section>
      </main>
      <footer><span>藏宝阁与个人小屋</span><span>本地服务与生成状态</span></footer>
    </div>
  );
}
