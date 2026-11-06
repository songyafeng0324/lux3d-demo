import { lazy, Suspense, useEffect } from 'react';

const SceneLab = lazy(() => import('./scene/SceneLab.js'));
const Game = lazy(() => import('./game/Game.js'));
const Room = lazy(() => import('./room/Room.js'));
const Admin = lazy(() => import('./admin/Admin.js'));
const loading = (text: string, dark = false) => <p style={{ margin: 0, padding: 40, minHeight: '100dvh', background: dark ? '#0f0c0a' : undefined, color: dark ? '#b9ab92' : undefined }}>{text}</p>;

function LegacyBackpackLink() {
  useEffect(() => { location.replace('/room?backpack=1'); }, []);
  return loading('正在打开个人小屋…');
}

export function App() {
  if (location.pathname === '/admin') return <Suspense fallback={loading('正在打开管理后台…', true)}><Admin /></Suspense>;
  if (location.pathname === '/room') return <Suspense fallback={loading('正在打开个人小屋…')}><Room /></Suspense>;
  const shared = location.pathname.match(/^\/shared\/([^/]+)\/?$/);
  if (shared) return <Suspense fallback={loading('正在打开分享小屋…')}><Room shareToken={shared[1]} /></Suspense>;
  if (location.pathname === "/lab/t04") return <Suspense fallback={loading('正在准备古建场景…')}><SceneLab /></Suspense>;
  if (location.pathname === '/' && new URLSearchParams(location.search).get('backpack') === '1') return <LegacyBackpackLink />;
  return <Suspense fallback={loading('正在打开藏宝阁…', true)}><Game /></Suspense>;
}
