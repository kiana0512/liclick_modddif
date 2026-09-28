import { GLTFExporter } from 'three-stdlib';
import { Mesh, SkinnedMesh } from 'three';
import type { LoadedModel } from './modelImportTypes';
import { loadModelFromFile } from './loadModelFromFile';
import { countModelTriangles, IMPORT_DECIMATE_THRESHOLD, IMPORT_DECIMATE_TARGET } from './modelTriangleLimit';
import { inspectModelUv, needsUvRepair } from './modelUvValidation';
import { disposeImportCandidate, waitForImportTextures, type ModelImportProcessingInput } from './prepareModelUvImport';
import { getWorkspaceApiBase } from '@/services/workspaceApiBase';
import { getPipelineTrace, traceAsync, traceSync, type TraceSession } from '@/engine/performance/tracing/pipelineTrace';
import { traceFetch } from '@/engine/performance/tracing/traceRequest';

async function traceConfirmation(session: TraceSession, name: 'decimate.confirm' | 'uv.confirm', task: () => Promise<boolean>) {
  const scope = session.begin(name);
  try { const consent = await task(); scope?.end(consent ? 'ok' : 'cancelled'); return consent; }
  catch (error) { scope?.end(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error'); throw error; }
}

// IMPORT-DECIMATE v1.1.0: consent → merge by distance → decimate → separate UV consent.
export async function processModelImport(input: ModelImportProcessingInput): Promise<{ file: File; loaded: LoadedModel } | undefined> {
  const trace = import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' ? getPipelineTrace() : undefined;
  const controller = new AbortController();
  const staleTimer = window.setInterval(() => { if (!input.isCurrent()) controller.abort(); }, 100);
  const owned = new Set<LoadedModel>([input.parsed]);
  let retained: LoadedModel | undefined, loaded = input.parsed, file = input.file;
  try {
    for (const operation of ['decimate', 'uv'] as const) {
      if (!input.isCurrent()) return;
      const decimate = operation === 'decimate';
      input.progress(decimate ? '正在检查模型面数' : '正在检查模型 UV');
      const report = decimate ? { triangles: countModelTriangles(loaded.root), missing: 0, invalid: 0, outside: 0, degenerate: 0 }
        : inspectModelUv(loaded.root);
      if (decimate ? report.triangles <= IMPORT_DECIMATE_THRESHOLD : !needsUvRepair(report)) continue;
      input.progress(decimate ? '等待确认是否减面' : '等待确认是否修改 UV');
      const consent = await (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace
        ? traceConfirmation(trace, decimate ? 'decimate.confirm' : 'uv.confirm', () => input.confirm(input.file.name, report, controller.signal, operation))
        : input.confirm(input.file.name, report, controller.signal, operation));
      if (!consent || !input.isCurrent()) return;
      input.progress('正在准备模型处理');
      // Raw source coordinates, before editor normalization or placement; embed companion assets.
      const raw = await loadModelFromFile(file, { normalize: false, ground: false, recenter: false, targetMaxDimension: 3 }, file === input.file ? input.resources : []);
      owned.add(raw);
      raw.root.traverse(child => {
        if (child.animations.length || child instanceof SkinnedMesh ||
            Object.values((child as Mesh).geometry?.morphAttributes ?? {}).some(attributes => attributes.length)) {
          throw new Error('暂不支持自动处理带动画、骨骼或形态键的模型，请手动处理后导入');
        }
      });
      await waitForImportTextures(raw, controller.signal);
      raw.root.traverse(child => { child.userData = {}; });
      const data = await (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace
        ? traceAsync(trace, decimate ? 'decimate.prepare' : 'uv.prepare', () => new GLTFExporter().parseAsync(raw.root, { binary: true, onlyVisible: false }))
        : new GLTFExporter().parseAsync(raw.root, { binary: true, onlyVisible: false }));
      if (!(data instanceof ArrayBuffer)) throw new Error('无法准备模型处理');
      controller.signal.throwIfAborted();
      if (!input.isCurrent()) return;
      input.progress(decimate ? '服务器正在合并顶点并减面至约 20 万三角面，请稍候' : '服务器正在展开 UV，请稍候');
      const timeout = window.setTimeout(() => controller.abort(), 210_000);
      let blob: Blob;
      try {
        const base = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
        const endpoint = decimate ? 'import-decimate?consent=change-topology-v1' : 'import-uv-repair?consent=change-uv-v1';
        const requestInit = {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'content-type': 'model/gltf-binary' }, body: data,
        } satisfies RequestInit;
        const response = await (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace
          ? traceFetch(`${base}/api/asset-processing/${endpoint}`, requestInit)
          : fetch(`${base}/api/asset-processing/${endpoint}`, requestInit));
        if (!response.ok) {
          const error = await response.json().catch(() => undefined);
          throw new Error(error?.error ?? `模型处理失败（${response.status}），模型未导入`);
        }
        blob = await (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace ? traceAsync(trace, decimate ? 'decimate.download' : 'uv.download', () => response.blob()) : response.blob());
      } finally { window.clearTimeout(timeout); }
      disposeImportCandidate(raw); owned.delete(raw);
      if (!input.isCurrent()) return;
      file = new File([blob], `${file.name.replace(/\.[^.]+$/, '')}_${decimate ? '200k' : 'uv-repaired'}.glb`, { type: 'model/gltf-binary' });
      loaded = await loadModelFromFile(file, input.normalize); owned.add(loaded);
      if (decimate) {
        if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace) traceSync(trace, 'decimate.qa', () => validateDecimation(loaded));
        else validateDecimation(loaded);
      } else {
        if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && trace) traceSync(trace, 'uv.qa', () => validateUv(loaded));
        else validateUv(loaded);
      }
    }
    if (!input.isCurrent()) return;
    loaded.object.sourceUnitScaleFactor = input.parsed.object.sourceUnitScaleFactor;
    loaded.result.sourceUnitScaleFactor = input.parsed.result.sourceUnitScaleFactor;
    retained = loaded;
    return { file, loaded };
  } finally {
    window.clearInterval(staleTimer);
    for (const candidate of owned) if (candidate !== retained) disposeImportCandidate(candidate);
  }
}

function validateDecimation(loaded: LoadedModel) {
  const triangles = countModelTriangles(loaded.root);
  if (!triangles || triangles > IMPORT_DECIMATE_TARGET * 1.01) throw new Error('减面后面数未达到约 20 万面，模型未导入');
}

function validateUv(loaded: LoadedModel) {
  if (needsUvRepair(inspectModelUv(loaded.root))) throw new Error('修复后 UV 仍不满足绘制要求，模型未导入');
}
