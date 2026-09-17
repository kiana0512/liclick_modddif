import { GLTFExporter } from 'three-stdlib';
import { Mesh, SkinnedMesh, Texture } from 'three';
import type { LoadedModel } from './modelImportTypes';
import type { NormalizeImportedModelOptions } from '@/engine/scene/normalizeImportedModel';
import { loadModelFromFile } from './loadModelFromFile';
import { disposeRejectedModel } from './modelTriangleLimit';
import { inspectModelUv, needsUvRepair, type ModelUvReport } from './modelUvValidation';
import { getWorkspaceApiBase } from '@/services/workspaceApiBase';

export function disposeImportCandidate(model: LoadedModel) {
  disposeRejectedModel(model.root);
  if (model.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(model.sourceUrl);
}

export async function waitForImportTextures(model: LoadedModel, signal: AbortSignal) {
  const textures = new Set<Texture>();
  model.root.traverse(child => {
    if (!(child instanceof Mesh)) return;
    for (const material of [child.material].flat()) {
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  await Promise.all([...textures].map(async texture => {
    const deadline = performance.now() + 5000;
    while (!texture.image && performance.now() < deadline) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    signal.throwIfAborted();
    if (!texture.image) throw new Error('模型贴图未能加载，请同时提供配套贴图后重新导入');
    if (texture.image instanceof HTMLImageElement) await texture.image.decode();
  }));
}

export async function prepareModelUvImport(input: {
  file: File; parsed: LoadedModel; resources: File[]; normalize: NormalizeImportedModelOptions;
  confirm: (name: string, report: ModelUvReport, signal: AbortSignal) => Promise<boolean>;
  isCurrent: () => boolean; progress: (message: string) => void;
}): Promise<{ file: File; loaded: LoadedModel } | undefined> {
  const controller = new AbortController();
  const staleTimer = window.setInterval(() => { if (!input.isCurrent()) controller.abort(); }, 100);
  let raw: LoadedModel | undefined, repaired: LoadedModel | undefined, retained: LoadedModel | undefined;
  try {
    if (!input.isCurrent()) return;
    input.progress('正在检查模型 UV');
    const report = inspectModelUv(input.parsed.root);
    if (!needsUvRepair(report)) { retained = input.parsed; return { file: input.file, loaded: retained }; }
    input.progress('等待确认是否修改 UV');
    if (!await input.confirm(input.file.name, report, controller.signal) || !input.isCurrent()) return;
    input.progress('正在准备 UV 修复模型');
    // Export source coordinates, before editor normalization/scene placement. Embed companion resources.
    raw = await loadModelFromFile(input.file, { normalize: false, ground: false, recenter: false, targetMaxDimension: 3 }, input.resources);
    raw.root.traverse(child => {
      if (child.animations.length || child instanceof SkinnedMesh ||
          Object.values((child as Mesh).geometry?.morphAttributes ?? {}).some(attributes => attributes.length)) {
        throw new Error('暂不支持自动修复带动画、骨骼或形态键的模型，请手动修复 UV 后导入');
      }
    });
    await waitForImportTextures(raw, controller.signal);
    raw.root.traverse(child => { child.userData = {}; });
    const data = await new GLTFExporter().parseAsync(raw.root, { binary: true, onlyVisible: false });
    if (!(data instanceof ArrayBuffer)) throw new Error('无法准备 UV 修复模型');
    controller.signal.throwIfAborted();
    if (!input.isCurrent()) return;
    input.progress('服务器正在展开 UV，请稍候');
    const timeout = window.setTimeout(() => controller.abort(), 210_000);
    let blob: Blob;
    try {
      const base = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);
      const response = await fetch(`${base}/api/asset-processing/import-uv-repair?consent=change-uv-v1`, {
        method: 'POST', credentials: 'include', signal: controller.signal,
        headers: { 'content-type': 'model/gltf-binary' }, body: data,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => undefined);
        throw new Error(error?.error ?? `UV 修复失败（${response.status}），模型未导入`);
      }
      blob = await response.blob();
    } finally { window.clearTimeout(timeout); }
    if (!input.isCurrent()) return;
    input.progress('正在复检修复后的 UV');
    const file = new File([blob], `${input.file.name.replace(/\.[^.]+$/, '')}_uv-repaired.glb`, { type: 'model/gltf-binary' });
    repaired = await loadModelFromFile(file, input.normalize);
    if (needsUvRepair(inspectModelUv(repaired.root))) throw new Error('修复后 UV 仍不满足绘制要求，模型未导入');
    if (!input.isCurrent()) return;
    // The snapshot retains source numeric coordinates; retain its physical unit metadata too.
    repaired.object.sourceUnitScaleFactor = input.parsed.object.sourceUnitScaleFactor;
    repaired.result.sourceUnitScaleFactor = input.parsed.result.sourceUnitScaleFactor;
    retained = repaired;
    return { file, loaded: retained };
  } finally {
    window.clearInterval(staleTimer);
    if (raw) disposeImportCandidate(raw);
    if (repaired && repaired !== retained) disposeImportCandidate(repaired);
    if (input.parsed !== retained) disposeImportCandidate(input.parsed);
  }
}
