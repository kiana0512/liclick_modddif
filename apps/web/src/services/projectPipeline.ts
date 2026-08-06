import type {
  ProjectPipelineAssetReference,
  ProjectPipelineRevision,
  ProjectPipelineRevisionStatus,
  ProjectPipelineSettingValue,
  ProjectPipelineStage,
  ProjectPipelineState,
} from '@/types/project';

export const projectPipelineStageOrder = [
  'texture',
  'retopology',
  'uv',
  'bake',
] as const satisfies readonly ProjectPipelineStage[];

function cloneSettingValue(value: ProjectPipelineSettingValue): ProjectPipelineSettingValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneSettingValue(item)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneSettingValue(item)]),
      ),
    );
  }
  return value;
}

function cloneAsset(asset: ProjectPipelineAssetReference): ProjectPipelineAssetReference {
  return Object.freeze({ ...asset });
}

function cloneRevision(revision: ProjectPipelineRevision): ProjectPipelineRevision {
  const settings = Object.freeze(
    Object.fromEntries(
      Object.entries(revision.settings).map(([key, value]) => [key, cloneSettingValue(value)]),
    ),
  );
  return Object.freeze({
    ...revision,
    inputAssets: Object.freeze(revision.inputAssets.map(cloneAsset)),
    outputAssets: Object.freeze(revision.outputAssets.map(cloneAsset)),
    settings,
  });
}

function assertPublishableRevision(
  pipeline: ProjectPipelineState,
  revision: ProjectPipelineRevision,
) {
  if (!revision.id.trim()) throw new Error('Pipeline revision id is required.');
  if (pipeline.revisions.some((item) => item.id === revision.id)) {
    throw new Error(`Pipeline revision already exists: ${revision.id}`);
  }
  if (revision.parentRevisionId === revision.id) {
    throw new Error('A pipeline revision cannot be its own parent.');
  }
  if (
    revision.parentRevisionId &&
    !pipeline.revisions.some((item) => item.id === revision.parentRevisionId)
  ) {
    throw new Error(`Pipeline parent revision does not exist: ${revision.parentRevisionId}`);
  }
  const inputAssetIds = revision.inputAssets.map((asset) => asset.id);
  const outputAssetIds = revision.outputAssets.map((asset) => asset.id);
  if ([...inputAssetIds, ...outputAssetIds].some((id) => !id.trim())) {
    throw new Error('Pipeline asset id is required.');
  }
  if (new Set(inputAssetIds).size !== inputAssetIds.length) {
    throw new Error('Pipeline input asset ids must be unique within a revision.');
  }
  if (new Set(outputAssetIds).size !== outputAssetIds.length) {
    throw new Error('Pipeline output asset ids must be unique within a revision.');
  }
}

export function createEmptyProjectPipeline(): ProjectPipelineState {
  return Object.freeze({ version: 1, revisions: Object.freeze([]) });
}

/** Append a defensive, frozen copy of a revision without changing prior state. */
export function publishPipelineRevision(
  current: ProjectPipelineState | undefined,
  revision: ProjectPipelineRevision,
): ProjectPipelineState {
  const pipeline = current ?? createEmptyProjectPipeline();
  assertPublishableRevision(pipeline, revision);
  return Object.freeze({
    version: 1,
    revisions: Object.freeze([...pipeline.revisions, cloneRevision(revision)]),
    ...(pipeline.staleRevisionIds
      ? { staleRevisionIds: Object.freeze([...pipeline.staleRevisionIds]) }
      : {}),
  });
}

export function getLatestPipelineStageRevision(
  pipeline: ProjectPipelineState | undefined,
  stage: ProjectPipelineStage,
) {
  if (!pipeline) return undefined;
  for (let index = pipeline.revisions.length - 1; index >= 0; index -= 1) {
    const revision = pipeline.revisions[index];
    if (revision.stage === stage) return revision;
  }
  return undefined;
}

export function isPipelineRevisionStale(
  pipeline: ProjectPipelineState | undefined,
  revisionOrId: ProjectPipelineRevision | string,
) {
  if (!pipeline) return false;
  const id = typeof revisionOrId === 'string' ? revisionOrId : revisionOrId.id;
  return pipeline.staleRevisionIds?.includes(id) ?? false;
}

export function getEffectivePipelineRevisionStatus(
  pipeline: ProjectPipelineState | undefined,
  revision: ProjectPipelineRevision,
): ProjectPipelineRevisionStatus {
  return isPipelineRevisionStale(pipeline, revision) ? 'stale' : revision.status;
}

/**
 * Return the newest checkpoint that is safe for a downstream stage to consume.
 * Historical entries remain append-only, but stale and incomplete revisions are
 * deliberately skipped instead of being treated as the current stage output.
 */
export function getLatestUsablePipelineStageRevision(
  pipeline: ProjectPipelineState | undefined,
  stage: ProjectPipelineStage,
) {
  if (!pipeline) return undefined;
  for (let index = pipeline.revisions.length - 1; index >= 0; index -= 1) {
    const revision = pipeline.revisions[index];
    if (
      revision.stage === stage &&
      getEffectivePipelineRevisionStatus(pipeline, revision) === 'ready'
    ) {
      return revision;
    }
  }
  return undefined;
}

/**
 * Resolve the bake-object identity carried by a pipeline asset chain.
 * Older project revisions did not always persist `objectId`, so callers may
 * provide trusted fallbacks from the bound input asset or selected Bake Set.
 */
export function resolvePipelineAssetObjectId(
  assets: readonly ProjectPipelineAssetReference[],
  ...fallbacks: Array<string | undefined>
) {
  const candidates = [...assets.map((asset) => asset.objectId), ...fallbacks];
  for (const candidate of candidates) {
    const objectId = candidate?.trim();
    if (objectId) return objectId;
  }
  return undefined;
}

/** Select the Bake Set that may safely receive a pipeline low-poly result. */
export function resolvePipelineBakeTargetObjectId(
  availableObjectIds: readonly string[],
  assetObjectId?: string,
  selectedObjectId?: string,
) {
  if (assetObjectId && availableObjectIds.includes(assetObjectId)) return assetObjectId;
  if (selectedObjectId && availableObjectIds.includes(selectedObjectId)) return selectedObjectId;
  return availableObjectIds.length === 1 ? availableObjectIds[0] : undefined;
}

/**
 * Mark every existing revision after `changedStage` stale using an immutable
 * overlay. Historical revision objects and their recorded status are retained.
 */
export function markDownstreamPipelineRevisionsStale(
  pipeline: ProjectPipelineState,
  changedStage: ProjectPipelineStage,
): ProjectPipelineState {
  const changedStageIndex = projectPipelineStageOrder.indexOf(changedStage);
  const downstreamStages = new Set(projectPipelineStageOrder.slice(changedStageIndex + 1));
  const staleRevisionIds = new Set(pipeline.staleRevisionIds ?? []);
  const previousSize = staleRevisionIds.size;
  for (const revision of pipeline.revisions) {
    if (downstreamStages.has(revision.stage)) staleRevisionIds.add(revision.id);
  }
  if (staleRevisionIds.size === previousSize) return pipeline;
  return Object.freeze({
    version: 1,
    revisions: pipeline.revisions,
    staleRevisionIds: Object.freeze([...staleRevisionIds]),
  });
}
