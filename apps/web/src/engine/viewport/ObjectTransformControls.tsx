import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  alignTransformPivotToObjectCenter,
  applyCenteredTransform,
  captureCenteredTransform,
  type CenteredTransformSnapshot,
} from '@/engine/scene/centeredTransformPivot';
import { syncImportedModelTransform } from '@/engine/scene/transformActions';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';

export function ObjectTransformControls() {
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const transformMode = useSceneStore((state) => state.transformMode);

  if (!importedModel || selectedObjectId !== importedModel.objectId || transformMode === 'select') {
    return null;
  }

  return <CenteredObjectTransformControls importedModel={importedModel} mode={transformMode} />;
}

function CenteredObjectTransformControls({
  importedModel,
  mode,
}: {
  importedModel: ModelLoadResult;
  mode: 'translate' | 'rotate' | 'scale';
}) {
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const pivot = useMemo(() => {
    const next = new THREE.Object3D();
    next.name = 'Liclick centered transform pivot';
    alignTransformPivotToObjectCenter(importedModel.group, next);
    return next;
  }, [importedModel.group]);
  const draggingRef = useRef(false);
  const snapshotRef = useRef<CenteredTransformSnapshot>();
  const lastModelMatrixWorldRef = useRef(importedModel.group.matrixWorld.clone());

  const alignPivot = useCallback(() => {
    if (draggingRef.current) return;
    alignTransformPivotToObjectCenter(importedModel.group, pivot);
    lastModelMatrixWorldRef.current.copy(importedModel.group.matrixWorld);
  }, [importedModel.group, pivot]);

  useLayoutEffect(alignPivot, [alignPivot, importedModel]);
  useEffect(
    () => () => {
      setOrbitControlsEnabled(true);
    },
    [setOrbitControlsEnabled],
  );

  useFrame(() => {
    if (draggingRef.current) return;
    importedModel.group.updateWorldMatrix(true, false);
    if (!lastModelMatrixWorldRef.current.equals(importedModel.group.matrixWorld)) alignPivot();
  });

  return (
    <TransformControls
      object={pivot}
      mode={mode}
      size={0.9}
      onMouseDown={() => {
        alignTransformPivotToObjectCenter(importedModel.group, pivot);
        snapshotRef.current = captureCenteredTransform(importedModel.group, pivot);
        draggingRef.current = true;
        captureHistory();
        setOrbitControlsEnabled(false);
      }}
      onMouseUp={() => {
        if (snapshotRef.current) {
          applyCenteredTransform(importedModel.group, pivot, snapshotRef.current);
        }
        draggingRef.current = false;
        snapshotRef.current = undefined;
        setOrbitControlsEnabled(true);
        syncImportedModelTransform();
        alignPivot();
      }}
      onObjectChange={() => {
        if (!draggingRef.current || !snapshotRef.current) return;
        applyCenteredTransform(importedModel.group, pivot, snapshotRef.current);
        lastModelMatrixWorldRef.current.copy(importedModel.group.matrixWorld);
        syncImportedModelTransform();
      }}
    />
  );
}
