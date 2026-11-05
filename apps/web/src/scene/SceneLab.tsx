import {useEffect,useRef,useState} from 'react';
import type {AssetId,Placement} from '@aholo/contracts';
import {validateLayout} from '@aholo/contracts';
import {SceneEngine,ModelPreview,lifecycle,type Mode,type Tool,type Metrics} from './engine.js';
import {RoomSave,initEditor,editorHeaders,editorFetch,type Layout,type SaveState} from './save.js';
import './scene.css';
const names:Record<AssetId,string>={table:'明式长案',chair:'靠背木椅',cabinet:'双门陈列柜',vase:'青花测试模型'};
const glyphs:Record<AssetId,string>={table:'案',chair:'椅',cabinet:'柜',vase:'瓷'};
const descriptions:Record<AssetId,string>={table:'本地制作 · 木质家具',chair:'本地制作 · 木质家具',cabinet:'本地制作 · 木质家具',vase:'T03 真实生成 · 48,964 面'};
const statusText={loading:'正在读取布置',loadFailed:'读取失败',rejected:'布置未通过校验',saved:'已自动保存',dirty:'有修改待保存',saving:'正在保存…',failed:'保存未确认',conflict:'房间版本冲突'};
interface DebugApi {engine:SceneEngine;save:RoomSave;add:(id:AssetId)=>void;replace:(p:Placement[])=>void;openDetail:(n:number)=>void;closeDetail:()=>void;remount:()=>void;lifecycle:typeof lifecycle}
declare global{interface Window{__t04?:DebugApi}}
function getRoom(){const query=new URLSearchParams(location.search).get('room');if(query&&/^[0-9a-f-]{36}$/i.test(query))return query;let value=localStorage.getItem('aholo.t04.room');if(!value){value=crypto.randomUUID();localStorage.setItem('aholo.t04.room',value);}return value;}
export default function SceneLab(){
 const host=useRef<HTMLDivElement>(null),previewHost=useRef<HTMLDivElement>(null),engine=useRef<SceneEngine|null>(null),saver=useRef<RoomSave|null>(null);const [roomId]=useState(getRoom);const [grant]=useState(()=>new URLSearchParams(location.search).get('grant'));const [shareToken]=useState(()=>new URLSearchParams(location.search).get('share'));const isVisitor=Boolean(grant||shareToken);
 const [mountVersion,setMountVersion]=useState(0);
 const [layout,setLayout]=useState<Layout>({version:0,sceneVersion:'courtyard-v1',name:'听雨小筑',placements:[]}),[save,setSave]=useState<SaveState>({status:'loading',version:0,sequence:0,message:''});
 const [mode,setMode]=useState<Mode>(isVisitor?'share':'edit'),[selected,setSelected]=useState<string|null>(null),[tool,setTool]=useState<Tool>('translate'),[notice,setNotice]=useState(''),[metrics,setMetrics]=useState<Metrics|null>(null),[ready,setReady]=useState(false),[tab,setTab]=useState<'catalog'|'objects'>('catalog'),[target,setTarget]=useState<number|null>(null),[detail,setDetail]=useState<number|null>(null),[shared,setShared]=useState(false),[shareUrl,setShareUrl]=useState(''),[loadError,setLoadError]=useState(false);
 const latest=useRef(layout);latest.current=layout;
 const edit=(name:string,placements:Placement[])=>{if(!saver.current?.canEdit)return;saver.current.edit(name,placements);engine.current?.setPlacements(placements);};
 const add=(assetId:AssetId)=>{
  if(assetId==='vase'&&!engine.current?.templates.has('vase'))return;
  const n=latest.current.placements.length;const p:Placement={id:crypto.randomUUID(),assetId,position:[((n%5)-2)*1.5,0,(Math.floor(n/5)%3-1)*1.5],rotation:[0,0,0],scale:1};const placements=[...latest.current.placements,p];edit(latest.current.name,placements);engine.current?.select(p.id);setNotice('已添加一件独立摆放。同一模型可以重复添加。');
 };
 const openDetail=(n:number)=>{engine.current?.pauseForDetail(true);setDetail(n);};const closeDetail=()=>{setDetail(null);engine.current?.pauseForDetail(false);};
 useEffect(()=>{
  if(!host.current)return;let active=true;let scene:SceneEngine|undefined;
  const controller=new RoomSave(roomId,(value,state)=>{if(!active)return;latest.current=value;setLayout({...value});setSave(state);if(state.status==='saved'){setShared(Boolean(value.shareEnabled));}engine.current?.setPlacements(value.placements);});saver.current=controller;
  void (async()=>{
   let snapshot:Layout|undefined;let activeGrant=grant;
   if(isVisitor){const url=shareToken?`/api/lab/t04/entry/${encodeURIComponent(shareToken)}`:`/api/lab/t04/snapshot/${encodeURIComponent(grant!)}`;const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error();const data=(await r.json()).data;snapshot=data;activeGrant=data.grant||grant;}
   else await initEditor();
   if(!active||!host.current)return;
   const modelUrl=isVisitor?(snapshot?.placements.some(p=>p.assetId==='vase')?`/api/lab/t04/model?grant=${encodeURIComponent(activeGrant!)}`:''):'/api/lab/t04/model';
   setMode(isVisitor?'share':'edit');scene=new SceneEngine(host.current,{select:setSelected,edit:p=>{const value=latest.current;controller.edit(value.name,value.placements.map(v=>v.id===p.id?p:v));},notice:setNotice,metrics:setMetrics,target:setTarget,detail:openDetail,ready:setReady},modelUrl,isVisitor?{}:editorHeaders());engine.current=scene;
   if(isVisitor&&snapshot){latest.current=snapshot;setLayout(snapshot);scene.setPlacements(snapshot.placements);scene.setMode('share');setSave({status:'saved',version:snapshot.version,sequence:0,message:''});}
   else{await controller.load();if(active)window.__t04={engine:scene,save:controller,add:id=>add(id),replace:placements=>edit(latest.current.name,placements),openDetail,closeDetail,remount:()=>setMountVersion(v=>v+1),lifecycle};}
  })().catch(()=>{if(active){setLoadError(true);setNotice(isVisitor?'此验证分享无法访问，分享可能已关闭。':'场景验证服务无法连接，请重试。');}});
  const leaving=(e:BeforeUnloadEvent)=>{if(controller.unsaved){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',leaving);
  return()=>{active=false;window.removeEventListener('beforeunload',leaving);controller.dispose();scene?.dispose();engine.current=null;delete window.__t04;};
 },[roomId,grant,shareToken,mountVersion]);
 useEffect(()=>{const root=previewHost.current,template=engine.current?.templates.get('vase');if(detail===null||!root||!template)return;const view=new ModelPreview(root,template);const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')closeDetail();};window.addEventListener('keydown',escape);return()=>{view.dispose();window.removeEventListener('keydown',escape);};},[detail]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),6000);return()=>clearTimeout(timer);},[notice]);
 const changeMode=(next:Mode)=>{closeDetail();engine.current?.setMode(next);setMode(next);setTarget(null);};
 async function toggleShare(){
  try{const r=await editorFetch('/api/lab/t04/share',{method:'PUT',headers:{...editorHeaders(),'Content-Type':'application/json'},body:JSON.stringify({roomId,enabled:!shared})});if(!r.ok)throw Error();const {data}=await r.json();setShared(data.enabled);if(saver.current){saver.current.current.shareEnabled=data.enabled;saver.current.current.shareToken=data.shareToken;}if(data.enabled){setShareUrl(`${location.origin}/lab/t04?share=${encodeURIComponent(data.shareToken)}`);}else{setShareUrl('');setNotice('分享已关闭。旧页已加载内容可保留，新进入与新资源读取会被拒绝。');}}
  catch{setNotice('验证分享操作失败，请稍后重试。');}
 }
 const active=layout.placements.find(p=>p.id===selected);
 return <div className="scene-app">
  <header className="scene-header"><a className="brand" href="/workbench" onClick={e=>{if(saver.current?.unsaved&&!confirm('布置尚未全部保存。离开会丢失未确认修改，仍要离开吗？'))e.preventDefault();}}><span className="seal">藏</span><span>藏宝阁<small>一物一世界</small></span></a><div className="chapter"><span>空间实验</span><b>T04</b><small>独立验证数据</small></div><a className="service-link" href="/workbench">本地工作台 ↗</a></header>
  <div className="scene-navigation"><div className="room-heading"><p>私人空间 · 固定古建样本</p>{isVisitor?<h1>{layout.name}</h1>:<input aria-label="房间名称" value={layout.name} maxLength={80} onChange={e=>{const value=e.target.value;if(value.trim())edit(value,layout.placements);}}/>}</div><nav aria-label="场景模式">{!isVisitor&&<><button className={mode==='edit'?'active':''} onClick={()=>changeMode('edit')}>布置小屋</button><button className={mode==='visit'?'active':''} onClick={()=>changeMode('visit')}>走进小屋</button><button className={mode==='gallery'?'active':''} onClick={()=>changeMode('gallery')}>藏宝阁 · 30展位</button></>}{isVisitor&&<span className="readonly">只读参观</span>}</nav><div className={`save-state ${save.status}`} role="status" data-testid="save-status"><span className="status-dot"/>{isVisitor?(loadError?'无法读取分享':save.status==='saved'?'已确认版本快照':'正在读取快照'):statusText[save.status]}<small>{save.status==='saved'||!isVisitor?`V${save.version}`:'—'}</small></div></div>
  <main className={`scene-workspace ${mode!=='edit'?'visiting':''}`}>
   {mode==='edit'&&!isVisitor&&<aside className="scene-sidebar"><div className="sidebar-tabs"><button className={tab==='catalog'?'active':''} onClick={()=>setTab('catalog')}>物品库</button><button className={tab==='objects'?'active':''} onClick={()=>setTab('objects')}>房间物品 <small>{layout.placements.length}</small></button></div>
    {tab==='catalog'?<><p className="sidebar-note">选一件，布置自己的小世界。</p><p className="group-label">基础家具 <span>本地制作</span></p><div className="catalog-grid">{(['table','chair','cabinet'] as const).map(id=><button className={`asset-card ${id}`} key={id} onClick={()=>add(id)} disabled={!saver.current?.canEdit} aria-label={`添加${names[id]}`}><div className="asset-illustration"><i/><i/><i/><i/></div><span>{names[id]}</span><small>＋ 添加</small></button>)}</div><p className="group-label">真实模型 <span>T03 样本</span></p><button className="real-asset" onClick={()=>add('vase')} disabled={!ready||!saver.current?.canEdit}><span className="ceramic">瓷</span><span>青花测试模型<small>{ready?'48,964 面 · 原始 GLB':'正在加载真实模型…'}</small></span><b>＋</b></button><p className="sample-note">本次模型形状偏离瓷瓶输入，仅用于接入与场景验证。</p></>:<div className="placement-list">{layout.placements.length===0?<p className="sidebar-note">房间还空着。从物品库添加第一件。</p>:layout.placements.map((p,i)=><div className={`placement-row ${selected===p.id?'selected':''}`} key={p.id}><button onClick={()=>engine.current?.select(p.id)}><span>{glyphs[p.assetId]}</span><div>{names[p.assetId]}<small>摆放 {String(i+1).padStart(2,'0')}</small></div></button><button title="定位物品" aria-label={`定位摆放${i+1}`} onClick={()=>engine.current?.focus(p.id)}>⌖</button><button title="移除本次摆放" aria-label={`移除摆放${i+1}`} onClick={()=>edit(layout.name,layout.placements.filter(v=>v.id!==p.id))}>×</button></div>)}</div>}
    <div className="sidebar-bottom"><span>⌘</span><p>每次添加都是独立摆放<br/>移除不会删除原始模型</p></div></aside>}
   <section className="scene-stage" aria-label="古建三维空间">
    <div className="scene-canvas" ref={host} data-testid="scene-canvas"/>
    {loadError&&<div className="scene-blocked"><div>{isVisitor?'此分享验证入口已失效':'场景验证服务暂不可用'}<button onClick={()=>location.reload()}>重新载入</button></div></div>}
    <div className="stage-label"><span className="stage-live"/>{mode==='gallery'?'藏宝阁 / 展位适配样本':mode==='edit'?'听雨小筑 / 斜俯视布置':'听雨小筑 / 第一人称参观'}<small>{mode==='gallery'?'30个展位均复用同一真实模型，不代表已发布藏品':'固定建筑与可编辑物品分离'}</small></div>
    {mode==='edit'&&<div className="scene-tools" role="toolbar" aria-label="变换工具">{([['translate','↔','移动'],['rotate','⟳','旋转'],['scale','⤢','等比缩放']] as const).map(([value,icon,label])=><button key={value} aria-label={label} aria-pressed={tool===value} className={tool===value?'active':''} onClick={()=>{setTool(value);engine.current?.setTool(value);}}><span>{icon}</span>{label}</button>)}<span className="tool-divider"/><button onClick={()=>engine.current?.home()}>⌂ 全景</button></div>}
    {mode!=='edit'&&<div className="visit-actions"><button onClick={()=>engine.current?.home()}>↶ 回到入口</button><span>点击场景环顾 · WASD / 方向键行走 · Esc 释放</span></div>}
    {mode==='edit'&&active&&<div className="selection-card"><span className="selection-icon">{glyphs[active.assetId]}</span><div><strong>{names[active.assetId]}</strong><small>{descriptions[active.assetId]}</small></div><button onClick={()=>engine.current?.focus(active.id)} title="定位">⌖</button><button onClick={()=>edit(layout.name,layout.placements.filter(p=>p.id!==active.id))} aria-label="移除选中摆放">移除</button></div>}
    {mode==='edit'&&!active&&layout.placements.length===0&&<div className="empty-room"><span>从一件物品开始</span><p>从左侧添加家具或真实模型<br/>在场景中拖动三轴控件布置</p></div>}
    {mode!=='edit'&&<span className="crosshair" aria-hidden="true">＋</span>}
    {mode==='gallery'&&target!==null&&detail===null&&<div className="exhibit-prompt"><kbd>E</kbd><span>查看展位 {String(target).padStart(2,'0')} 的测试藏品</span></div>}
    {notice&&<div className="scene-notice" role="alert">{notice}</div>}
    <div className="stage-footer"><span>{mode==='edit'?'拖动三轴控件 · 滚轮缩放视角 · 鼠标拖动环绕':'参观模式不改变已保存布局'}</span><span>{metrics?`${Math.round(metrics.fps)} FPS · ${metrics.calls} 次绘制`:'正在准备场景'}<i/>本地场景验证</span></div>
   </section>
  </main>
  <footer className="lab-bottom"><p>{save.message||'布置只在服务端确认后标为已保存。这里使用独立验证数据。'}</p><div>{save.status==='loadFailed'&&<button onClick={()=>void initEditor().then(()=>saver.current?.load()).catch(()=>setNotice('本地服务仍不可用'))}>重试读取</button>}{save.status==='failed'&&<button onClick={()=>void saver.current?.flush()}>重试保存</button>}{save.status==='conflict'&&<button onClick={()=>{if(confirm('重新载入将放弃本页未保存修改，使用服务端已确认布局。'))void saver.current?.load();}}>载入已确认版本</button>}{!isVisitor&&<button className="share-lab" onClick={()=>void toggleShare()} disabled={!shared&&save.status!=='saved'}>{shared?'关闭验证分享':'创建验证快照'}</button>}</div></footer>
  {shareUrl&&<div className="share-banner"><span>仅共享已确认布局：</span><a href={shareUrl} target="_blank" rel="noreferrer">打开只读验证页 ↗</a><button aria-label="收起链接" onClick={()=>setShareUrl('')}>×</button></div>}
  {detail!==null&&<div className="detail-backdrop"><section className="exhibit-detail" role="dialog" aria-modal="true" aria-label="测试藏品详情"><div className="detail-head"><p>展位 {String(detail).padStart(2,'0')} · 独立模型预览</p><button autoFocus aria-label="关闭详情" onClick={closeDetail}>×</button></div><div className="detail-model" ref={previewHost}/><div className="detail-copy"><p className="eyebrow">真实生成 / 接入样本</p><h2>青花测试模型</h2><p>T03 由单张图片生成。当前外形与输入有偏差，保留用于场景适配和性能测试。</p><dl><div><dt>年代</dt><dd>不详（测试资料）</dd></div><div><dt>材质</dt><dd>不详（测试资料）</dd></div><div><dt>收藏方</dt><dd>本地技术验证</dd></div><div><dt>来源</dt><dd>T03 实际生成任务 4639946</dd></div></dl><small>拖动旋转 · 滚轮缩放 · Esc 关闭后继续参观</small></div></section></div>}
 </div>;
}
