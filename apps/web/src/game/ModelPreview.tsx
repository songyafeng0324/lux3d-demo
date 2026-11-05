import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeResources } from '../scene/assets.js';
import { fileUrl } from './backpack-api.js';

/** `headers` carries a snapshot grant for public exhibits; without it the visitor's own login is used. */
export default function ModelPreview({ fileId, name, headers }: { fileId: string; name: string; headers?: Record<string, string> }) {
  const headerKey = JSON.stringify(headers ?? null);
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在载入模型…');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let stopped = false;
    let renderer: T.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let resize: ResizeObserver | undefined;
    let loaded: T.Object3D | undefined;
    const abort = new AbortController();
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(35, 1, .01, 10000);
    setFailed(false);
    setStatus('正在载入模型…');
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3;
      renderer.domElement.setAttribute('aria-label', `${name}模型预览，拖动旋转，滚轮缩放`);
      element.appendChild(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      scene.add(new T.HemisphereLight(0xfff5e4, 0x6d7880, 2.8));
      const key = new T.DirectionalLight(0xffefda, 3.5);
      key.position.set(4, 6, 5);
      scene.add(key);
      const fill = new T.DirectionalLight(0xdbe6ff, 2);
      fill.position.set(-3, 2, -3);
      scene.add(fill);
      resize = new ResizeObserver(() => {
        if (!renderer) return;
        const w = element.clientWidth, h = element.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
      });
      resize.observe(element);
      renderer.setAnimationLoop(() => { controls?.update(); renderer?.render(scene, camera); });
      void fetch(fileUrl(fileId), headers ? { headers, credentials: 'omit', cache: 'no-store', signal: abort.signal } : { credentials: 'same-origin', signal: abort.signal }).then(async response => {
        if (!response.ok) throw new Error(headers ? '展品模型已不可查看，请刷新藏宝阁。' : '模型读取失败，请刷新背包或重新登录。');
        const bytes = await response.arrayBuffer();
        if (stopped) return;
        const gltf = await new GLTFLoader().parseAsync(bytes, '');
        if (stopped) { disposeResources([gltf.scene]); return; }
        loaded = gltf.scene;
        const bounds = new T.Box3().setFromObject(loaded);
        if (bounds.isEmpty()) throw new Error('模型没有可显示的几何。');
        const center = bounds.getCenter(new T.Vector3());
        const size = bounds.getSize(new T.Vector3());
        const radius = Math.max(size.x, size.y, size.z);
        if (!(radius > 0 && Number.isFinite(radius))) throw new Error('模型尺寸无效。');
        loaded.position.sub(center);
        scene.add(loaded);
        camera.near = radius / 1000;
        camera.far = radius * 100;
        camera.position.set(radius * 1.7, radius * .9, radius * 2.3);
        camera.updateProjectionMatrix();
        controls!.target.set(0, 0, 0);
        controls!.minDistance = radius * .35;
        controls!.maxDistance = radius * 8;
        controls!.update();
        setStatus('');
      }).catch(error => {
        if (!stopped) { setFailed(true); setStatus(error instanceof Error ? error.message : '模型暂时无法预览。'); }
      });
    } catch {
      setFailed(true);
      setStatus('浏览器暂时无法创建模型预览，请使用最新版 Chrome。');
    }
    return () => {
      stopped = true;
      abort.abort();
      resize?.disconnect();
      controls?.dispose();
      renderer?.setAnimationLoop(null);
      if (loaded) disposeResources([loaded]);
      renderer?.renderLists.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- headerKey is the stable form of headers
  }, [fileId, name, headerKey]);
  return <div className="bag-preview-wrap">
    <div className="bag-preview" ref={host} />
    {status && <p className="bag-preview-status" role={failed ? 'alert' : 'status'}>{status}</p>}
    {!status && <small className="bag-preview-hint">拖动旋转 · 滚轮缩放</small>}
  </div>;
}
