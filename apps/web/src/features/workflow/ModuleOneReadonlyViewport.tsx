import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { SceneObject } from '@/types/model';
import type { Project } from '@/types/project';

type ImportedModel = NonNullable<ReturnType<typeof useSceneStore.getState>['importedModel']>;
const moduleOneViewportCache = new Map<string, ImportedModel>();

function fileNameForObject(object: SceneObject) {
  const sourcePath = object.sourcePath?.split('?')[0].split('#')[0];
  return sourcePath?.split('/').pop() || object.name;
}

export function ModuleOneReadonlyViewport({
  project,
  object,
  sceneOverlay,
}: {
  project: Project;
  object: SceneObject;
  sceneOverlay?: ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const snapshotRef = useRef<{
    scene: ReturnType<typeof useSceneStore.getState>;
    layers: ReturnType<typeof useLayerStore.getState>;
    projectId: string;
  }>();

  useEffect(() => {
    snapshotRef.current = {
      scene: useSceneStore.getState(),
      layers: useLayerStore.getState(),
      projectId: useProjectStore.getState().currentProjectId,
    };
    return () => {
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      useSceneStore.setState({
        objects: snapshot.scene.objects,
        importedModels: snapshot.scene.importedModels,
        importedModel: snapshot.scene.importedModel,
        selectedObjectId: snapshot.scene.selectedObjectId,
        displayMode: snapshot.scene.displayMode,
        projectionMode: snapshot.scene.projectionMode,
        transformMode: snapshot.scene.transformMode,
        paintTool: snapshot.scene.paintTool,
      });
      useLayerStore.setState({
        layers: snapshot.layers.layers,
        activeProjectedLayerId: snapshot.layers.activeProjectedLayerId,
      });
      useProjectStore.getState().setCurrentProject(snapshot.projectId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    const scene = useSceneStore.getState();
    const existing = scene.importedModels.find((model) => model.objectId === object.id);
    const cacheKey = `${project.id}:${object.id}:${object.sourcePath ?? ''}`;
    const cached = moduleOneViewportCache.get(cacheKey);
    useProjectStore.getState().setCurrentProject(project.id);
    useLayerStore.getState().setLayers(project.layers);
    // Module 2 deliberately reuses Module 1's proven flat-lighting preview.
    // The final UV layers still come from the same layer store; only the
    // lighting mode is fixed so bake preparation is visually predictable.
    scene.setDisplayMode('flat');
    scene.setPaintTool('none');

    if (existing) {
      scene.setObjects(project.objects.filter((item) => item.format !== 'primitive'));
      scene.setActiveImportedModel(object.id);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (cached) {
      scene.setObjects(project.objects.filter((item) => item.format !== 'primitive'));
      scene.setImportedModel(cached, { ...object, selected: true, visible: true });
      scene.setActiveImportedModel(object.id);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    scene.clearImportedModel();
    if (!object.sourcePath || !/^(https?:|blob:|data:)/.test(object.sourcePath)) {
      setError('当前模型路径不可用于只读视口');
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    void loadModelFromUrl({
      sourceUrl: object.sourcePath,
      fileName: fileNameForObject(object),
      normalizeOptions: {
        normalize: object.importNormalizationTransform?.normalized ?? true,
        ground: object.importNormalizationTransform?.grounded ?? true,
        targetMaxDimension: object.importNormalizationTransform?.targetMaxDimension ?? 3,
      },
    }).then((loaded) => {
      if (cancelled) return;
      loaded.root.name = object.name;
      loaded.root.userData.liclickObjectId = object.id;
      loaded.root.traverse((child) => {
        child.userData.liclickObjectId = object.id;
      });
      loaded.root.position.set(...object.transform.position);
      loaded.root.rotation.set(...object.transform.rotation);
      loaded.root.scale.set(...object.transform.scale);
      loaded.root.updateMatrixWorld(true);
      const restoredModel: ImportedModel = {
        ...loaded.result,
        objectId: object.id,
        name: object.name,
        sourceFileName: fileNameForObject(object),
        objectUrl: object.sourcePath,
        group: loaded.root,
        materialSlots: object.materialSlots.map((slot) => slot.name),
        uvSets: object.uvSets,
        boundingBox: object.boundingBox ?? loaded.result.boundingBox,
        originalBoundingBox: object.originalBoundingBox ?? loaded.result.originalBoundingBox,
        importNormalizationTransform: object.importNormalizationTransform ?? loaded.result.importNormalizationTransform,
        childMeshCount: object.childMeshCount ?? loaded.result.childMeshCount,
        warnings: object.warnings ?? loaded.result.warnings,
      };
      moduleOneViewportCache.set(cacheKey, restoredModel);
      scene.setImportedModel(restoredModel, { ...object, selected: true, visible: true });
      setLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : '模块 1 视口恢复失败');
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [object, project.id, project.layers, project.objects]);

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden bg-[#0d0f1c]">
      <ViewportCanvas
        hasImportedModel={!loading && !error}
        onImportModels={() => undefined}
        onImportReferenceImages={() => undefined}
        onOpenImport={() => undefined}
        showGrid
        gridVariant="subtle"
        backgroundColor="#0d0f1c"
        showCaptureFrame={false}
        showViewCube={false}
        sceneOverlay={sceneOverlay}
      />
      {loading ? <div className="absolute inset-0 z-30 grid place-items-center bg-[#080914] text-sm text-white/42">正在恢复模块 1 视图…</div> : null}
      {error ? <div className="absolute inset-0 z-30 grid place-items-center bg-[#080914] px-8 text-center text-sm text-white/42">{error}</div> : null}
    </div>
  );
}
