import type { LoadedModel, SupportedImportFormat } from './modelImportTypes';
import type { NormalizeImportedModelOptions } from '@/engine/scene/normalizeImportedModel';
import type { ModelImportProgressCallback } from './modelImportProgress';
import { getPipelineTrace, traceAsync } from '@/engine/performance/tracing/pipelineTrace';

export const supportedModelExtensions = ['glb', 'gltf', 'fbx', 'obj'] as const;

async function loadModelByFormat(
  format: SupportedImportFormat,
  options: Parameters<typeof import('./loadGltfModel').loadGltfModel>[0],
) {
  if (format === 'glb' || format === 'gltf') {
    const { loadGltfModel } = await import('./loadGltfModel');
    return loadGltfModel(options);
  }
  if (format === 'fbx') {
    const { loadFbxModel } = await import('./loadFbxModel');
    return loadFbxModel(options);
  }
  const { loadObjModel } = await import('./loadObjModel');
  return loadObjModel(options);
}

export function getModelFormatFromFileName(fileName: string): SupportedImportFormat | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!extension) return undefined;
  if (supportedModelExtensions.includes(extension as SupportedImportFormat)) {
    return extension as SupportedImportFormat;
  }
  return undefined;
}

function readModelFileAsArrayBuffer(file: File, onProgress?: ModelImportProgressCallback) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      onProgress?.({
        phase: 'reading',
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable && event.total > 0 ? event.total : file.size,
      });
    };
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('Could not read the model file.'));
        return;
      }
      onProgress?.({
        phase: 'reading',
        loadedBytes: file.size,
        totalBytes: file.size,
      });
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the model file.'));
    reader.readAsArrayBuffer(file);
  });
}

export async function loadModelFromFile(
  file: File,
  normalizeOptions?: NormalizeImportedModelOptions,
  resourceFiles: File[] = [],
  onProgress?: ModelImportProgressCallback,
): Promise<LoadedModel> {
  const format = getModelFormatFromFileName(file.name);
  if (!format) {
    throw new Error('Unsupported model format. Please import GLB, GLTF, FBX, or OBJ.');
  }

  onProgress?.({ phase: 'preparing', phaseProgress: 1 });
  const sourceUrl = URL.createObjectURL(file);
  const sourceBuffer =
    format === 'fbx' ? await (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true' && getPipelineTrace()
      ? traceAsync(getPipelineTrace()!, 'model.read', () => readModelFileAsArrayBuffer(file, onProgress)) : readModelFileAsArrayBuffer(file, onProgress)) : undefined;
  const options = {
    sourceUrl,
    fileName: file.name,
    normalizeOptions,
    resourceFiles,
    sourceBuffer,
    sourceByteLength: file.size,
    onProgress,
  };

  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
    const trace = getPipelineTrace();
    if (trace) return traceAsync(trace, 'model.load', context => loadModelByFormat(format, { ...options, traceContext: context }));
  }
  return loadModelByFormat(format, options);
}

export async function loadModelFromUrl(input: {
  sourceUrl: string;
  fileName: string;
  normalizeOptions?: NormalizeImportedModelOptions;
  sourceBuffer?: ArrayBuffer;
}): Promise<LoadedModel> {
  const format = getModelFormatFromFileName(input.fileName);
  if (!format) {
    throw new Error('Unsupported model format. Please import GLB, GLTF, FBX, or OBJ.');
  }

  const options = {
    sourceUrl: input.sourceUrl,
    fileName: input.fileName,
    normalizeOptions: input.normalizeOptions,
    sourceBuffer: input.sourceBuffer,
  };

  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
    const trace = getPipelineTrace();
    if (trace) return traceAsync(trace, 'model.load', context => loadModelByFormat(format, { ...options, traceContext: context }));
  }
  return loadModelByFormat(format, options);
}
