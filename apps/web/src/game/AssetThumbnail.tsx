import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import { disposeResources } from '../scene/assets.js';
import { fileUrl, type Asset } from './backpack-api.js';
import { configurePreview, framePreview, previewScene, readPreviewModel } from './model-preview-scene.js';

type ImageSource = Pick<Asset, 'modelFileId'> & Partial<Pick<Asset, 'originalImageId'>>;
/** Share of the thumbnail the model's outline spans along its binding axis. */
export const THUMBNAIL_FILL = .88;
export type ThumbnailCache = Map<string, Promise<string>>;
let queue: Promise<unknown> = Promise.resolve();

function modelImage(fileId: string, cache: ThumbnailCache) {
  const existing = cache.get(fileId);
  if (existing) return existing;
  // Only visible cards ask for a render. Serialize decodes and release each WebGL context.
  const next = queue.then(async () => {
    const model = await readPreviewModel(fileId, {}, '模型缩略图暂不可用。');
    let renderer: T.WebGLRenderer | undefined;
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(192, 144);
      configurePreview(renderer);
      const scene = previewScene();
      const camera = new T.PerspectiveCamera(35, 192 / 144);
      framePreview(model, camera, THUMBNAIL_FILL);
      scene.add(model);
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/webp', .85);
    } finally {
      disposeResources([model]);
      renderer?.dispose();
      renderer?.forceContextLoss();
    }
  });
  queue = next.catch(() => undefined);
  cache.set(fileId, next);
  if (cache.size > 96) cache.delete(cache.keys().next().value!);
  void next.catch(() => { if (cache.get(fileId) === next) cache.delete(fileId); });
  return next;
}

export default function AssetThumbnail({ asset, cache }: { asset?: ImageSource; cache?: ThumbnailCache }) {
  const target = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [brokenOriginal, setBrokenOriginal] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ id: string; url: string } | null>(null);
  const fileId = asset?.modelFileId;
  const original = asset?.originalImageId && asset.originalImageId !== brokenOriginal ? fileUrl(asset.originalImageId) : null;
  useEffect(() => {
    if (visible || !target.current || original || !fileId || !cache) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [visible, original, fileId, cache]);
  useEffect(() => {
    if (!visible || original || !fileId || !cache) return;
    let live = true;
    void modelImage(fileId, cache).then(url => { if (live) setRendered({ id: fileId, url }); }).catch(() => {});
    return () => { live = false; };
  }, [visible, original, fileId, cache]);
  const src = original || (rendered?.id === fileId ? rendered?.url : undefined);
  return <span className="asset-thumbnail" ref={target} aria-hidden="true">
    {src ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => {
      if (original) setBrokenOriginal(asset?.originalImageId ?? null);
      else setRendered(null);
    }} /> : <svg className="asset-thumbnail-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5m8 4.5v9" /></svg>}
  </span>;
}
