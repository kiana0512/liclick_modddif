import type { SceneObject } from '@/types/model';
import type { BakeAssetReference, Project, ProjectBakeSetState } from '@/types/project';

function cloneTuple(value: [number, number, number]): [number, number, number] {
  return [...value];
}

export function cloneBakeHighObject(
  object: SceneObject,
  objectId: string,
  asset: BakeAssetReference,
): SceneObject {
  return {
    ...object,
    id: objectId,
    name: asset.name,
    sourcePath: asset.url,
    materialSlots: object.materialSlots.map((slot) => ({ ...slot })),
    uvSets: [...object.uvSets],
    boundingBox: object.boundingBox
      ? {
          min: cloneTuple(object.boundingBox.min),
          max: cloneTuple(object.boundingBox.max),
          center: cloneTuple(object.boundingBox.center),
          size: cloneTuple(object.boundingBox.size),
        }
      : undefined,
    originalBoundingBox: object.originalBoundingBox
      ? {
          min: cloneTuple(object.originalBoundingBox.min),
          max: cloneTuple(object.originalBoundingBox.max),
          center: cloneTuple(object.originalBoundingBox.center),
          size: cloneTuple(object.originalBoundingBox.size),
        }
      : undefined,
    importNormalizationTransform: object.importNormalizationTransform
      ? {
          ...object.importNormalizationTransform,
          position: cloneTuple(object.importNormalizationTransform.position),
          scale: cloneTuple(object.importNormalizationTransform.scale),
        }
      : undefined,
    userTransform: object.userTransform
      ? {
          position: cloneTuple(object.userTransform.position),
          rotation: cloneTuple(object.userTransform.rotation),
          scale: cloneTuple(object.userTransform.scale),
        }
      : undefined,
    warnings: object.warnings ? [...object.warnings] : undefined,
    transform: {
      position: cloneTuple(object.transform.position),
      rotation: cloneTuple(object.transform.rotation),
      scale: cloneTuple(object.transform.scale),
    },
    visible: true,
    selected: true,
  };
}

export function replaceBakeHighSnapshot(
  project: Project,
  input: {
    objectId: string;
    asset: BakeAssetReference;
    highObject: SceneObject;
  },
): Project {
  const previousWorkspace = project.bakeWorkspace;
  const previousSet: ProjectBakeSetState = previousWorkspace?.bakeSets[input.objectId] ?? {
    objectId: input.objectId,
  };
  const high = { ...input.asset };
  const highObject = cloneBakeHighObject(input.highObject, input.objectId, high);
  const bakeSets = {
    ...(previousWorkspace?.bakeSets ?? {}),
    [input.objectId]: {
      ...previousSet,
      objectId: input.objectId,
      high,
      highObject,
    },
  };
  const modelAssetPath = high.relativePath ?? high.url;
  const assetManifest = {
    ...(project.assetManifest ?? {
      models: [],
      references: [],
      generations: [],
      layers: [],
      baked: [],
    }),
    models: Array.from(new Set([...(project.assetManifest?.models ?? []), modelAssetPath])),
  };

  return {
    ...project,
    assetManifest,
    bakeWorkspace: {
      version: 1,
      activeStage: 'assets',
      selectedObjectId: input.objectId,
      bakeSets,
    },
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

export function getBakeHighObjects(project?: Project): SceneObject[] {
  if (!project?.bakeWorkspace) return [];
  return Object.entries(project.bakeWorkspace.bakeSets).flatMap(([objectId, bakeSet]) => {
    if (bakeSet.highObject) {
      const asset = bakeSet.high ?? {
        name: bakeSet.highObject.name,
        url: bakeSet.highObject.sourcePath ?? '',
      };
      return [cloneBakeHighObject(bakeSet.highObject, objectId, asset)];
    }

    const legacyObject = project.objects.find((object) => object.id === objectId);
    if (!legacyObject) return [];
    if (!bakeSet.high) return [legacyObject];
    return [cloneBakeHighObject(legacyObject, objectId, bakeSet.high)];
  });
}
