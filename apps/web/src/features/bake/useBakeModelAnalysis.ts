import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import { canonicalizeBakeBoundingBox } from './bakeModelAlignment';
import type { ModelBoundingBox, ModelFormat } from '@/types/model';

export type BakeModelFileInput = { objectId: string; file: File };

export type BakeModelInfo = {
  name: string;
  boundingBox: ModelBoundingBox;
  uvSets: string[];
  childMeshCount: number;
  warnings: string[];
  format: ModelFormat;
  sourceUnitScaleFactor?: number;
};

export type BakeModelAnalysis = {
  low: Record<string, BakeModelInfo>;
  cage: Record<string, BakeModelInfo>;
  loading: boolean;
  error?: string;
};

function disposeLoadedRoot(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

async function inspectModel({ objectId, file }: BakeModelFileInput) {
  const loaded = await loadModelFromFile(file, {
    normalize: false,
    ground: false,
    targetMaxDimension: 3,
    recenter: false,
  });
  try {
    return {
      objectId,
      info: {
        name: loaded.object.name,
        boundingBox: canonicalizeBakeBoundingBox(
          loaded.result.originalBoundingBox,
          loaded.result.format,
          loaded.result.sourceUnitScaleFactor,
        ),
        uvSets: loaded.object.uvSets,
        childMeshCount: loaded.result.childMeshCount,
        warnings: loaded.result.warnings,
        format: loaded.result.format,
        sourceUnitScaleFactor: loaded.result.sourceUnitScaleFactor,
      } satisfies BakeModelInfo,
    };
  } finally {
    disposeLoadedRoot(loaded.root);
    if (loaded.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(loaded.sourceUrl);
  }
}

async function inspectCollection(inputs: BakeModelFileInput[]) {
  const results = await Promise.all(inputs.map(inspectModel));
  return Object.fromEntries(results.map(({ objectId, info }) => [objectId, info]));
}

/** Parses bake inputs for preflight checks without creating a second 3D viewport. */
export function useBakeModelAnalysis(
  lowFiles: BakeModelFileInput[],
  cageFiles: BakeModelFileInput[],
) {
  const [analysis, setAnalysis] = useState<BakeModelAnalysis>({
    low: {},
    cage: {},
    loading: false,
  });

  useEffect(() => {
    let cancelled = false;
    setAnalysis((current) => ({ ...current, loading: true, error: undefined }));
    void Promise.all([inspectCollection(lowFiles), inspectCollection(cageFiles)])
      .then(([low, cage]) => {
        if (!cancelled) setAnalysis({ low, cage, loading: false });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setAnalysis({
          low: {},
          cage: {},
          loading: false,
          error: reason instanceof Error ? reason.message : '烘焙模型解析失败',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cageFiles, lowFiles]);

  return analysis;
}
