import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
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
  const controlsRef = useRef<TransformControlsImpl>(null);
  const { gl } = useThree();
  const snapshotRef = useRef<CenteredTransformSnapshot>();
  const lastModelMatrixWorldRef = useRef(importedModel.group.matrixWorld.clone());

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    // three-stdlib exposes this property at runtime (and through Drei props),
    // but its declaration marks it private.
    const inputControls = controls as unknown as { enabled: boolean };
    let navigationPointer: number | undefined;
    const release = (event?: PointerEvent) => {
      if (navigationPointer === undefined || (event && event.pointerId !== navigationPointer)) return;
      navigationPointer = undefined;
      inputControls.enabled = true;
    };
    const reserveNavigation = (event: PointerEvent) => {
      if (!event.altKey || event.pointerType === 'touch' || event.button < 0 || event.button > 2 || draggingRef.current || !inputControls.enabled) return;
      navigationPointer = event.pointerId;
      inputControls.enabled = false;
    };
    gl.domElement.addEventListener('pointerdown', reserveNavigation, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    gl.domElement.addEventListener('lostpointercapture', release);
    return () => {
      release();
      gl.domElement.removeEventListener('pointerdown', reserveNavigation, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      gl.domElement.removeEventListener('lostpointercapture', release);
    };
  }, [gl]);

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
      ref={controlsRef}
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
