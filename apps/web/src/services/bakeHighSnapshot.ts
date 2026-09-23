import type { SceneObject } from '@/types/model';
import type { BakeAssetReference, Project, ProjectBakeSetState } from '@/types/project';

function nonEmptyId(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function legacyBakeObjectId(project: Project, bakeSet: ProjectBakeSetState) {
  return (
    nonEmptyId(bakeSet.objectId) ??
    nonEmptyId(bakeSet.highObject?.id) ??
    nonEmptyId(project.activeObjectId) ??
    `bake-target-${project.id}`
  );
}

/**
 * Releases before 2.16.3 could persist the first Bake Set under an empty key
 * because nullish coalescing accepts ''. High-poly enumeration still rendered
 * that snapshot, while low/material lookups treated the id as absent. Repair
 * the document in memory so existing assets become addressable immediately;
 * the next normal project save persists the canonical key.
 */
export function normalizeBakeWorkspaceObjectIds(project?: Project): Project | undefined {
  const workspace = project?.bakeWorkspace;
  if (!project || !workspace) return project;
  const invalidEntries = Object.entries(workspace.bakeSets).filter(
    ([objectId, bakeSet]) => !nonEmptyId(objectId) || !nonEmptyId(bakeSet.objectId),
  );
  if (invalidEntries.length === 0 && nonEmptyId(workspace.selectedObjectId)) return project;

  const bakeSets: Record<string, ProjectBakeSetState> = {};
  let replacementSelectedId = nonEmptyId(workspace.selectedObjectId);
  Object.entries(workspace.bakeSets).forEach(([objectId, bakeSet]) => {
    const canonicalId = nonEmptyId(objectId) ?? legacyBakeObjectId(project, bakeSet);
    const existing = bakeSets[canonicalId];
    const highObject = bakeSet.highObject
      ? { ...bakeSet.highObject, id: canonicalId }
      : existing?.highObject;
    bakeSets[canonicalId] = {
      ...bakeSet,
      ...existing,
      objectId: canonicalId,
      ...(highObject ? { highObject } : {}),
    };
    if (!replacementSelectedId || workspace.selectedObjectId === objectId) {
      replacementSelectedId = canonicalId;
    }
  });

  return {
    ...project,
    bakeWorkspace: {
      ...workspace,
      selectedObjectId: replacementSelectedId,
      bakeSets,
    },
  };
}

export function cloneBakeHighObject(
  object: SceneObject,
  objectId: string,
  asset: BakeAssetReference,
): SceneObject {
  const clone = structuredClone(object);
  return {
    ...clone,
    id: objectId,
    name: asset.name,
    sourcePath: asset.url,
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
  const objectId = nonEmptyId(input.objectId) ?? `bake-target-${project.id}`;
  const previousWorkspace = project.bakeWorkspace;
  const previousSet: ProjectBakeSetState = previousWorkspace?.bakeSets[objectId] ?? {
    objectId,
  };
  const high = { ...input.asset };
  const highObject = cloneBakeHighObject(input.highObject, objectId, high);
  const bakeSets = {
    ...(previousWorkspace?.bakeSets ?? {}),
    [objectId]: {
      ...previousSet,
      objectId,
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
      activeStage: previousSet.low ? 'alignment' : 'assets',
      selectedObjectId: objectId,
      bakeSets,
    },
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

export function getBakeHighObjects(project?: Project): SceneObject[] {
  const normalizedProject = normalizeBakeWorkspaceObjectIds(project);
  if (!normalizedProject?.bakeWorkspace) return [];
  return Object.entries(normalizedProject.bakeWorkspace.bakeSets).flatMap(([objectId, bakeSet]) => {
    const highSource =
      bakeSet.high?.relativePath ?? bakeSet.high?.url ?? bakeSet.highObject?.sourcePath;
    const pipelineOwnsHighSource = Boolean(
      highSource &&
      normalizedProject.pipeline?.revisions.some((revision) =>
        revision.outputAssets.some(
          (asset) =>
            (asset.kind === 'high-model' || asset.kind === 'model') &&
            (asset.relativePath === highSource || asset.url === highSource),
        ),
      ),
    );
    // UV input models are pipeline provenance, not an implicit Bake high-poly
    // selection. Historical projects may still contain that old snapshot, so
    // suppress it at read time without deleting the stored pipeline asset.
    if (pipelineOwnsHighSource) return [];

    if (bakeSet.highObject) {
      const asset = bakeSet.high ?? {
        name: bakeSet.highObject.name,
        url: bakeSet.highObject.sourcePath ?? '',
      };
      return [cloneBakeHighObject(bakeSet.highObject, objectId, asset)];
    }

    const legacyObject = normalizedProject.objects.find((object) => object.id === objectId);
    if (!legacyObject || !bakeSet.high) return [];
    return [cloneBakeHighObject(legacyObject, objectId, bakeSet.high)];
  });
}
