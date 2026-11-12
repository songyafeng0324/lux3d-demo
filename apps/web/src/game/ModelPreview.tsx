import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeResources } from '../scene/assets.js';
import { configurePreview, framePreview, parsePreviewModel, previewScene, readPreviewModel } from './model-preview-scene.js';

/**
 * `headers` carries a snapshot grant for public exhibits; without it the visitor's own login is used.
 * `file` previews a local GLB instead (the administrator's upload before it is sent).
 * `notice` is laid over the top of the preview (the public exhibit's AI-generated disclaimer).
 */
export default function ModelPreview({ fileId, file, name, headers, showHint = true, notice }: { fileId?: string; file?: Blob; name: string; headers?: Record<string, string>; showHint?: boolean; notice?: ReactNode }) {
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
    const scene = previewScene();
    const camera = new T.PerspectiveCamera(35, 1, .01, 10000);
    setFailed(false);
    setStatus('正在载入模型…');
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      configurePreview(renderer);
      renderer.domElement.setAttribute('aria-label', `${name}模型预览，拖动旋转，滚轮缩放`);
      element.appendChild(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      resize = new ResizeObserver(() => {
        if (!renderer) return;
        const w = element.clientWidth, h = element.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
      });
      resize.observe(element);
      renderer.setAnimationLoop(() => { controls?.update(); renderer?.render(scene, camera); });
      const options: RequestInit = headers
        ? { headers, credentials: 'omit', cache: 'no-store', signal: abort.signal }
        : { signal: abort.signal };
      const message = headers ? '展品模型已不可查看，请刷新藏宝阁。' : '模型读取失败，请刷新背包或重新登录。';
      const read = file ? file.arrayBuffer().then(bytes => parsePreviewModel(bytes)).catch(() => { throw new Error('无法在本机预览这个 GLB：文件可能损坏、引用了外部贴图，或使用了预览不支持的压缩格式。'); })
        : fileId ? readPreviewModel(fileId, options, message) : Promise.reject(new Error('没有可预览的模型。'));
      void read.then(model => {
        if (stopped) { disposeResources([model]); return; }
        loaded = model;
        const radius = framePreview(loaded, camera);
        scene.add(loaded);
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
  }, [fileId, file, name, headerKey]);
  return <div className="bag-preview-wrap">
    <div className="bag-preview" ref={host} />
    {notice}
    {status && <p className="bag-preview-status" role={failed ? 'alert' : 'status'}>{status}</p>}
    {!status && showHint && <small className="bag-preview-hint">拖动旋转 · 滚轮缩放</small>}
  </div>;
}
