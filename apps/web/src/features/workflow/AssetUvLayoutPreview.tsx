import { CheckCircle2, LoaderCircle, Map as MapIcon, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import {
  assetJobArtifacts,
  assetJobError,
  assetJobId,
  fetchVerifiedArtifactBlob,
  type AssetArtifact,
  type AssetJob,
} from '@/services/assetProcessingApiClient';

const maxPreviewTriangles = 180_000;

type UvLayoutData = {
  triangles: Float32Array;
  meshCount: number;
  uvMeshCount: number;
  sourceTriangleCount: number;
  renderedTriangleCount: number;
  bounds: { minU: number; minV: number; maxU: number; maxV: number };
  label: string;
};

function artifactName(artifact: AssetArtifact) {
  return artifact.filename || artifact.name || 'UV result.fbx';
}

function uvFbxArtifact(job?: AssetJob) {
  if (!job || job.status !== 'SUCCEEDED') return undefined;
  return assetJobArtifacts(job).find((artifact) => /_pbr_uv\.fbx$/i.test(artifactName(artifact)))
    ?? assetJobArtifacts(job).find((artifact) => /\.fbx$/i.test(artifactName(artifact)));
}

function triangleCount(geometry: THREE.BufferGeometry) {
  const count = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
  const start = Math.max(0, geometry.drawRange.start || 0);
  const available = Math.max(0, count - start);
  const requested = Number.isFinite(geometry.drawRange.count)
    ? Math.min(available, geometry.drawRange.count)
    : available;
  return Math.floor(requested / 3);
}

function collectUvLayout(root: THREE.Object3D, label: string): UvLayoutData {
  const meshes: THREE.Mesh[] = [];
  let meshCount = 0;
  let uvMeshCount = 0;
  let sourceTriangleCount = 0;

  root.traverseVisible((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    meshCount += 1;
    const uv = child.geometry.getAttribute('uv');
    if (!uv) return;
    uvMeshCount += 1;
    sourceTriangleCount += triangleCount(child.geometry);
    meshes.push(child);
  });

  if (uvMeshCount === 0 || sourceTriangleCount === 0) {
    throw new Error('展 UV 结果中没有检测到可预览的 UV0。');
  }

  const sampleStride = Math.max(1, Math.ceil(sourceTriangleCount / maxPreviewTriangles));
  const values: number[] = [];
  let triangleIndex = 0;
  let renderedTriangleCount = 0;
  let minU = Number.POSITIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const uv = geometry.getAttribute('uv');
    const index = geometry.index;
    const elementCount = index?.count ?? geometry.getAttribute('position')?.count ?? 0;
    const start = Math.max(0, geometry.drawRange.start || 0);
    const available = Math.max(0, elementCount - start);
    const requested = Number.isFinite(geometry.drawRange.count)
      ? Math.min(available, geometry.drawRange.count)
      : available;
    const end = start + requested;

    for (let offset = start; offset + 2 < end; offset += 3) {
      const shouldRender = triangleIndex % sampleStride === 0;
      triangleIndex += 1;
      if (!shouldRender) continue;
      const a = index ? index.getX(offset) : offset;
      const b = index ? index.getX(offset + 1) : offset + 1;
      const c = index ? index.getX(offset + 2) : offset + 2;
      if (a >= uv.count || b >= uv.count || c >= uv.count) continue;
      const coordinates = [uv.getX(a), uv.getY(a), uv.getX(b), uv.getY(b), uv.getX(c), uv.getY(c)];
      if (!coordinates.every(Number.isFinite)) continue;
      values.push(...coordinates);
      renderedTriangleCount += 1;
      minU = Math.min(minU, coordinates[0], coordinates[2], coordinates[4]);
      minV = Math.min(minV, coordinates[1], coordinates[3], coordinates[5]);
      maxU = Math.max(maxU, coordinates[0], coordinates[2], coordinates[4]);
      maxV = Math.max(maxV, coordinates[1], coordinates[3], coordinates[5]);
    }
  }

  if (renderedTriangleCount === 0) throw new Error('UV0 数据为空，无法生成预览。');
  return {
    triangles: new Float32Array(values),
    meshCount,
    uvMeshCount,
    sourceTriangleCount,
    renderedTriangleCount,
    bounds: {
      minU: Math.min(0, minU),
      minV: Math.min(0, minV),
      maxU: Math.max(1, maxU),
      maxV: Math.max(1, maxV),
    },
    label,
  };
}

function disposeLoadedRoot(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material?.dispose());
  });
}

function UvCanvas({ data }: { data: UvLayoutData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container) return undefined;
    const targetCanvas = canvas;
    const targetContainer = container;

    function draw() {
      const width = Math.max(1, targetContainer.clientWidth);
      const height = Math.max(1, targetContainer.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      targetCanvas.width = Math.round(width * dpr);
      targetCanvas.height = Math.round(height * dpr);
      targetCanvas.style.width = `${width}px`;
      targetCanvas.style.height = `${height}px`;
      const context = targetCanvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const padding = Math.max(24, Math.min(width, height) * 0.075);
      const availableWidth = Math.max(1, width - padding * 2);
      const availableHeight = Math.max(1, height - padding * 2);
      const rangeU = Math.max(0.0001, data.bounds.maxU - data.bounds.minU);
      const rangeV = Math.max(0.0001, data.bounds.maxV - data.bounds.minV);
      const scale = Math.min(availableWidth / rangeU, availableHeight / rangeV);
      const contentWidth = rangeU * scale;
      const contentHeight = rangeV * scale;
      const originX = (width - contentWidth) * 0.5;
      const originY = (height - contentHeight) * 0.5;
      const point = (u: number, v: number) => [
        originX + (u - data.bounds.minU) * scale,
        originY + (data.bounds.maxV - v) * scale,
      ] as const;

      context.lineWidth = 1;
      for (let step = 0; step <= 10; step += 1) {
        const value = step / 10;
        const [x0, y0] = point(value, 0);
        const [x1, y1] = point(value, 1);
        context.strokeStyle = step === 0 || step === 10 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.045)';
        context.beginPath();
        context.moveTo(x0, y0);
        context.lineTo(x1, y1);
        context.stroke();
        const [hx0, hy0] = point(0, value);
        const [hx1, hy1] = point(1, value);
        context.beginPath();
        context.moveTo(hx0, hy0);
        context.lineTo(hx1, hy1);
        context.stroke();
      }

      context.strokeStyle = 'rgba(100, 240, 211, .72)';
      context.lineWidth = Math.max(0.55, Math.min(1.05, 900 / Math.max(data.renderedTriangleCount, 1)));
      context.beginPath();
      for (let index = 0; index < data.triangles.length; index += 6) {
        const [aX, aY] = point(data.triangles[index], data.triangles[index + 1]);
        const [bX, bY] = point(data.triangles[index + 2], data.triangles[index + 3]);
        const [cX, cY] = point(data.triangles[index + 4], data.triangles[index + 5]);
        context.moveTo(aX, aY);
        context.lineTo(bX, bY);
        context.lineTo(cX, cY);
        context.closePath();
      }
      context.stroke();
    }

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(targetContainer);
    return () => observer.disconnect();
  }, [data]);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-label="UV 展开线框预览" />;
}

export function AssetUvLayoutPreview({ job, busy, error }: { job?: AssetJob; busy: boolean; error?: string }) {
  const artifact = useMemo(() => uvFbxArtifact(job), [job]);
  const [layout, setLayout] = useState<UvLayoutData>();
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const progress = Math.min(100, Math.max(0, job?.progress ?? 0));

  useEffect(() => {
    let cancelled = false;
    let loadedRoot: THREE.Object3D | undefined;
    let sourceUrl: string | undefined;
    setLayout(undefined);
    setPreviewError(undefined);
    if (!job || job.status !== 'SUCCEEDED') {
      setLoading(false);
      return undefined;
    }
    if (!artifact) {
      setLoading(false);
      setPreviewError('UV 交付中没有找到可预览的 FBX。');
      return undefined;
    }

    setLoading(true);
    void fetchVerifiedArtifactBlob(assetJobId(job), artifact)
      .then((blob) => {
        if (cancelled) return undefined;
        const file = new File([blob], artifactName(artifact), {
          type: artifact.content_type || 'application/octet-stream',
        });
        return loadModelFromFile(file, { normalize: false, ground: false, targetMaxDimension: 3 });
      })
      .then((loaded) => {
        if (!loaded) return;
        loadedRoot = loaded.root;
        sourceUrl = loaded.sourceUrl;
        const nextLayout = collectUvLayout(loaded.root, artifactName(artifact));
        if (!cancelled) setLayout(nextLayout);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setPreviewError(reason instanceof Error ? reason.message : 'UV 预览生成失败。');
        }
      })
      .finally(() => {
        if (loadedRoot) disposeLoadedRoot(loadedRoot);
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (loadedRoot) disposeLoadedRoot(loadedRoot);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [artifact, job]);

  const failedMessage = job?.status === 'FAILED' ? assetJobError(job) || error || 'UV 任务失败。' : undefined;
  const processing = Boolean(job && job.status !== 'SUCCEEDED' && job.status !== 'FAILED' && job.status !== 'CANCELLED');

  return (
    <section className="relative flex min-h-[560px] h-full flex-col overflow-hidden rounded-2xl border border-white/[0.075] bg-[#0b0d15] shadow-[0_20px_60px_rgba(0,0,0,.2)]">
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/[0.06] px-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200/36">UV LAYOUT</div>
          <h2 className="mt-1 text-sm font-semibold text-white/72">展开结果预览</h2>
        </div>
        {layout ? <CheckCircle2 className="h-5 w-5 text-emerald-200/72" /> : <MapIcon className="h-5 w-5 text-white/24" />}
      </div>

      <div className="relative min-h-0 flex-1 bg-[radial-gradient(circle_at_center,rgba(31,93,83,.16),transparent_66%)]">
        {layout ? <UvCanvas data={layout} /> : null}
        {!layout && (loading || processing || busy) ? (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div className="w-full max-w-xs">
              <LoaderCircle className="mx-auto h-7 w-7 animate-spin text-emerald-200/72" />
              <p className="mt-4 text-sm font-medium text-white/58">
                {loading ? '正在读取展 UV 结果…' : job?.stage_message || '正在生成 UV…'}
              </p>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-300 transition-[width] duration-500" style={{ width: `${loading ? 100 : progress}%` }} />
              </div>
              <div className="mt-2 text-[10px] tabular-nums text-white/28">{loading ? '生成预览' : `${Math.round(progress)}%`}</div>
            </div>
          </div>
        ) : null}
        {!layout && !loading && !processing && !busy && (previewError || failedMessage) ? (
          <div className="absolute inset-0 grid place-items-center px-10 text-center">
            <div>
              <TriangleAlert className="mx-auto h-8 w-8 text-rose-200/62" />
              <p className="mt-4 text-sm leading-6 text-rose-100/62">{previewError || failedMessage}</p>
            </div>
          </div>
        ) : null}
        {!layout && !loading && !processing && !busy && !previewError && !failedMessage ? (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div className="text-white/26">
              <MapIcon className="mx-auto h-10 w-10 stroke-[1.2]" />
              <p className="mt-4 text-sm font-medium text-white/42">完成自动展 UV 后在这里显示 UV0</p>
              <p className="mt-2 text-xs text-white/24">预览由交付 FBX 在本地生成</p>
            </div>
          </div>
        ) : null}
      </div>

      {layout ? (
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-white/[0.06] px-5 py-3 text-[10px] text-white/30">
          <span className="min-w-0 truncate" title={layout.label}>{layout.label}</span>
          <span className="shrink-0 tabular-nums">
            {layout.uvMeshCount}/{layout.meshCount} 网格 · {layout.sourceTriangleCount.toLocaleString('zh-CN')} 面
            {layout.renderedTriangleCount < layout.sourceTriangleCount ? ' · 预览已抽样' : ''}
          </span>
        </div>
      ) : null}
    </section>
  );
}
