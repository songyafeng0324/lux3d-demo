import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { ApiEnvelope, ReadinessData } from '@aholo/contracts';

const SceneLab = lazy(() => import('./scene/SceneLab.js'));

const names = { database: '数据库', storage: '私有文件存储', worker: '后台进程' } as const;

export function App() {
  if (location.pathname === "/lab/t04") return <Suspense fallback={<p style={{padding:40}}>正在准备古建场景…</p>}><SceneLab /></Suspense>;
  return <Workbench />;
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
        <a className="brand" href="/" aria-label="藏宝阁与个人小屋首页"><span className="seal">藏</span><span>藏宝阁与个人小屋<small>LOCAL WORKSPACE</small></span></a>
        <span className="local-label"><span />本地开发</span>
      </header>
      <main>
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">从一件藏品，开始一个小世界</p>
          <h1 id="page-title">本地工作台<span>从基础环境开始。</span></h1>
          <p className="lead">这里检查本机服务的实际连接状态。生成模型、布置小屋与公共展陈将分阶段接入。</p>
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
                <p>{key === 'database' ? '保存账号、任务和房间记录' : key === 'storage' ? '在本机持久保存图片与模型' : '关闭网页后仍可保持后台进程'}</p>
              </article>
            ))}
          </div>
          <p className="checked-at">{health ? `最近检查 ${new Date(health.checkedAt).toLocaleString('zh-CN')}` : '状态由本地 API 实时读取'}</p>
        </section>

        <section className="next-section" aria-labelledby="next-title">
          <div><p className="eyebrow">NEXT CHAPTER</p><h2 id="next-title">下一步，接入真实体验。</h2></div>
          <p>当前为基础工程阶段。网站生成流程尚未接入，账号、背包、小屋编辑和展陈功能仍待实现。</p>
          <a href="/lab/t04" style={{display:"inline-block",marginBottom:16,color:"#486747"}}>进入 T04 场景交互验证 →</a>
          <div className="next-tags"><span>单图生成</span><span>个人小屋</span><span>公共藏宝阁</span></div>
          {health && <p className="configuration">Lux3D 配置：{health.generation.configured ? '已检测到本地配置，网站任务流程待接入' : '尚未配置'}。当前页面不会提交生成任务。</p>}
        </section>
      </main>
      <footer><span>藏宝阁与个人小屋</span><span>T05 · 本地基础工程</span></footer>
    </div>
  );
}
