import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import type { SceneObject, Transform } from '@/types/model';
import { bakeOverlayScale } from './bakeModelAlignment';

export type BakeViewportMode = 'high' | 'overlay' | 'cage';

type OverlaySource = {
  root: THREE.Group;
  sourceUrl: string;
  sourceUnitScaleFactor?: number;
};

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function useOverlaySource(file?: File) {
  const [source, setSource] = useState<OverlaySource>();

  useEffect(() => {
    let cancelled = false;
    let loadedSource: OverlaySource | undefined;
    setSource(undefined);
    if (!file) return;

    void loadModelFromFile(file, {
      normalize: false,
      ground: false,
      targetMaxDimension: 3,
      recenter: false,
    })
      .then((loaded) => {
        loadedSource = {
          root: loaded.root,
          sourceUrl: loaded.sourceUrl,
          sourceUnitScaleFactor: loaded.result.sourceUnitScaleFactor,
        };
        if (cancelled) {
          disposeObject(loaded.root);
          if (loaded.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(loaded.sourceUrl);
          return;
        }
        setSource(loadedSource);
      });

    return () => {
      cancelled = true;
      if (!loadedSource) return;
      disposeObject(loadedSource.root);
      if (loadedSource.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(loadedSource.sourceUrl);
    };
  }, [file]);

  return source;
}

function cloneForOverlay(root: THREE.Group, style: 'low' | 'cage', cageDistance = 0) {
  const clone = root.clone(true);
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry = child.geometry.clone();
    if (style === 'cage' && cageDistance > 0) {
      const positions = child.geometry.getAttribute('position');
      let normals = child.geometry.getAttribute('normal');
      if (!normals) {
        child.geometry.computeVertexNormals();
        normals = child.geometry.getAttribute('normal');
      }
      for (let index = 0; index < positions.count; index += 1) {
        positions.setXYZ(
          index,
          positions.getX(index) + normals.getX(index) * cageDistance,
          positions.getY(index) + normals.getY(index) * cageDistance,
          positions.getZ(index) + normals.getZ(index) * cageDistance,
        );
      }
      positions.needsUpdate = true;
      child.geometry.computeBoundingBox();
      child.geometry.computeBoundingSphere();
    }
    child.material = new THREE.MeshBasicMaterial({
      color: style === 'cage' ? '#f0a04b' : '#df5ee2',
      wireframe: style === 'cage',
      transparent: true,
      opacity: style === 'cage' ? 0.72 : 0.26,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: style === 'cage' ? -3 : -2,
      polygonOffsetUnits: style === 'cage' ? -3 : -2,
    });
    child.raycast = () => undefined;
  });
  return clone;
}

function OverlayModel({
  root,
  transform,
  highUnitScaleFactor,
  sourceUnitScaleFactor,
}: {
  root: THREE.Group;
  transform: Transform;
  highUnitScaleFactor?: number;
  sourceUnitScaleFactor?: number;
}) {
  return (
    <primitive
      object={root}
      position={transform.position}
      rotation={transform.rotation}
      scale={bakeOverlayScale(transform.scale, highUnitScaleFactor, sourceUnitScaleFactor)}
    />
  );
}

/** Adds bake-only geometry to Module 1's existing R3F scene; it never creates its own Canvas. */
export function BakeSceneOverlay({
  highObject,
  lowFile,
  cageFile,
  mode,
  cageInflation,
}: {
  highObject: SceneObject;
  lowFile?: File;
  cageFile?: File;
  mode: BakeViewportMode;
  cageInflation: number;
}) {
  const lowSource = useOverlaySource(lowFile);
  const cageSource = useOverlaySource(cageFile);
  const rawMaxDimension = Math.max(...(highObject.originalBoundingBox?.size ?? [1, 1, 1]));
  const cageDistance = Math.max(0, cageInflation) * rawMaxDimension;
  const lowOverlay = useMemo(
    () => lowSource ? cloneForOverlay(lowSource.root, 'low') : undefined,
    [lowSource],
  );
  const cageOverlay = useMemo(
    () => {
      const source = cageSource ?? lowSource;
      if (!source) return undefined;
      return cloneForOverlay(source.root, 'cage', cageSource ? 0 : cageDistance);
    }, [cageDistance, cageSource, lowSource],
  );

  useEffect(() => () => {
    if (lowOverlay) disposeObject(lowOverlay);
  }, [lowOverlay]);
  useEffect(() => () => {
    if (cageOverlay) disposeObject(cageOverlay);
  }, [cageOverlay]);

  if (mode === 'high') return null;
  return (
    <group name="module-2-bake-overlay">
      {lowOverlay ? (
        <OverlayModel
          root={lowOverlay}
          transform={highObject.transform}
          highUnitScaleFactor={highObject.sourceUnitScaleFactor}
          sourceUnitScaleFactor={lowSource?.sourceUnitScaleFactor}
        />
      ) : null}
      {mode === 'cage' && cageOverlay ? (
        <OverlayModel
          root={cageOverlay}
          transform={highObject.transform}
          highUnitScaleFactor={highObject.sourceUnitScaleFactor}
          sourceUnitScaleFactor={(cageSource ?? lowSource)?.sourceUnitScaleFactor}
        />
      ) : null}
    </group>
  );
}
