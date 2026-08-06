import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary, WorkspaceProject } from '../types/project.js';
import { writeAutosave } from './autosaveService.js';
import {
  createId,
  ensureDir,
  readJsonFile,
  slugify,
  toWorkspaceUrl,
  getUserProjectDir,
  getUserProjectsDir,
  getUserTrashProjectsDir,
  writeJsonFile,
} from './workspaceService.js';

const assetFolders = ['models', 'references', 'captures', 'generations', 'layers', 'baked'];
const MIN_SAVED_PROJECTED_BAKE_COVERAGE_RATIO = 0.35;
const projectSaveTails = new Map<string, Promise<void>>();

async function runSerializedProjectSave<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectSaveTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  projectSaveTails.set(key, tail);
  try {
    return await current;
  } finally {
    if (projectSaveTails.get(key) === tail) projectSaveTails.delete(key);
  }
}

export class ProjectSaveConflictError extends Error {
  statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectSaveConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProjectedLayerRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'projected';
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function isBlobUrl(value: unknown) {
  return typeof value === 'string' && value.startsWith('blob:');
}

function getBakedTextureCoverageRatio(texture: Record<string, unknown>) {
  const directCoverageRatio = readNumber(texture.coverageRatio);
  if (directCoverageRatio !== undefined) return directCoverageRatio;
  const report = texture.report;
  return isRecord(report) ? readNumber(report.coverageRatio) : undefined;
}

function getBakedTextureSourceLayerIds(texture: Record<string, unknown>) {
  return (
    readStringArray(texture.sourceLayerIds) ??
    [readString(texture.sourceLayerId)].filter((id): id is string => Boolean(id))
  );
}

function sanitizeLowCoverageProjectedBakes(project: WorkspaceProject): WorkspaceProject {
  const layerIds = new Set(
    project.layers
      .filter(isRecord)
      .map((layer) => readString(layer.id))
      .filter((id): id is string => Boolean(id)),
  );
  const projectedLayerIds = new Set(
    project.layers
      .filter(isProjectedLayerRecord)
      .map((layer) => readString(layer.id))
      .filter((id): id is string => Boolean(id)),
  );
  if (project.bakedTextures.length === 0) return project;

  const removedTextureIds = new Set<string>();
  const bakedTextures = project.bakedTextures.filter((texture) => {
    if (!isRecord(texture)) return true;
    const coverageRatio = getBakedTextureCoverageRatio(texture);
    if (coverageRatio === undefined || coverageRatio >= MIN_SAVED_PROJECTED_BAKE_COVERAGE_RATIO)
      return true;
    const sourceLayerIds = getBakedTextureSourceLayerIds(texture);
    const allSourcesAreProjectedOrStale = sourceLayerIds.every(
      (id) => projectedLayerIds.has(id) || !layerIds.has(id),
    );
    if (sourceLayerIds.length > 0 && !allSourcesAreProjectedOrStale) return true;
    const textureId = readString(texture.id);
    if (textureId) removedTextureIds.add(textureId);
    return false;
  });
  if (removedTextureIds.size === 0) return project;

  return {
    ...project,
    bakedTextures,
    layers: project.layers.map((layer) => {
      if (!isRecord(layer)) return layer;
      const bakedTextureId = readString(layer.bakedTextureId);
      if (!bakedTextureId || !removedTextureIds.has(bakedTextureId)) return layer;
      const nextLayer: Record<string, unknown> = { ...layer, isBaked: false, needsRebake: true };
      delete nextLayer.bakedTextureId;
      delete nextLayer.bakedAt;
      return nextLayer;
    }),
  };
}

function sanitizeVolatileLayerAssets(
  project: WorkspaceProject,
  existingProject?: WorkspaceProject,
): WorkspaceProject {
  const capturesById = new Map(
    project.captures
      .filter(isRecord)
      .map((capture) => [readString(capture.id), capture])
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])),
  );
  const existingLayersById = new Map(
    (existingProject?.layers ?? [])
      .filter(isRecord)
      .map((layer) => [readString(layer.id), layer])
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])),
  );
  const durableUrl = (value: unknown) => {
    const url = readString(value);
    return url && !isBlobUrl(url) ? url : undefined;
  };
  let changed = false;
  const layers = project.layers.map((layer) => {
    if (!isRecord(layer)) return layer;
    const capture = capturesById.get(readString(layer.captureId) ?? '');
    const existingLayer = existingLayersById.get(readString(layer.id) ?? '');
    const nextLayer: Record<string, unknown> = { ...layer };
    if (isBlobUrl(nextLayer.maskUrl)) {
      nextLayer.maskUrl = durableUrl(existingLayer?.maskUrl) ?? durableUrl(capture?.maskUrl);
      changed = true;
    }
    if (isBlobUrl(nextLayer.depthUrl)) {
      nextLayer.depthUrl = durableUrl(existingLayer?.depthUrl) ?? durableUrl(capture?.depthUrl);
      changed = true;
    }
    if (isProjectedLayerRecord(nextLayer) && !durableUrl(nextLayer.imageUrl)) {
      const existingImageUrl = durableUrl(existingLayer?.imageUrl);
      if (!existingImageUrl) {
        throw new ProjectSaveConflictError(
          'Projected layer image is still uploading. Retry after the layer asset has been saved.',
        );
      }
      nextLayer.imageUrl = existingImageUrl;
      changed = true;
    }
    return nextLayer;
  });
  return changed ? { ...project, layers } : project;
}

function workspaceUrlToProjectRelative(userId: string, slug: string, value?: string) {
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return value;
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Plain relative asset paths are already portable.
    if (!value.startsWith('/workspace/')) return value;
  }
  if (!pathname.startsWith('/workspace/')) return value;
  const workspaceRelativePath = decodeURIComponent(pathname.slice('/workspace/'.length)).replaceAll(
    '\\',
    '/',
  );
  const projectPrefix = `users/${userId}/projects/${slug}/`;
  return workspaceRelativePath.startsWith(projectPrefix)
    ? workspaceRelativePath.slice(projectPrefix.length)
    : value;
}

function mapBakeWorkspaceAssetUrls(
  workspace: unknown,
  mapUrl: (url?: string) => string | undefined,
) {
  if (!isRecord(workspace) || !isRecord(workspace.bakeSets)) return workspace;
  const bakeSets = Object.fromEntries(
    Object.entries(workspace.bakeSets).map(([objectId, value]) => {
      if (!isRecord(value)) return [objectId, value];
      const next = { ...value };
      (['high', 'low', 'cage', 'color', 'normalMap', 'roughness', 'metallic', 'normal'] as const).forEach((key) => {
        const asset = value[key];
        if (isRecord(asset)) next[key] = { ...asset, url: mapUrl(readString(asset.url)) };
      });
      if (isRecord(value.highObject)) {
        next.highObject = {
          ...value.highObject,
          sourcePath: mapUrl(readString(value.highObject.sourcePath)),
        };
      }
      return [objectId, next];
    }),
  );
  return { ...workspace, bakeSets };
}

function mapPipelineAssetList(
  assets: unknown,
  mapUrl: (url?: string) => string | undefined,
) {
  if (!Array.isArray(assets)) return assets;
  return assets.map((asset) => {
    if (!isRecord(asset) || typeof asset.url !== 'string') return asset;
    return { ...asset, url: mapUrl(asset.url) };
  });
}

/**
 * Maps only durable pipeline asset URLs while preserving all unknown revision
 * metadata. The generic return type makes this safe for both strict current
 * projects and loosely shaped legacy/future project documents.
 */
export function mapProjectPipelineAssetUrls<T>(
  pipeline: T,
  mapUrl: (url?: string) => string | undefined,
): T {
  if (!isRecord(pipeline) || !Array.isArray(pipeline.revisions)) return pipeline;
  return {
    ...pipeline,
    revisions: pipeline.revisions.map((revision) =>
      isRecord(revision)
        ? {
            ...revision,
            ...(Array.isArray(revision.inputAssets)
              ? { inputAssets: mapPipelineAssetList(revision.inputAssets, mapUrl) }
              : {}),
            ...(Array.isArray(revision.outputAssets)
              ? { outputAssets: mapPipelineAssetList(revision.outputAssets, mapUrl) }
              : {}),
          }
        : revision,
    ),
  } as T;
}

function forEachPipelineAsset(
  pipeline: unknown,
  visit: (asset: Record<string, unknown>) => void,
) {
  if (!isRecord(pipeline) || !Array.isArray(pipeline.revisions)) return;
  pipeline.revisions.forEach((revision) => {
    if (!isRecord(revision)) return;
    [revision.inputAssets, revision.outputAssets].forEach((assets) => {
      if (!Array.isArray(assets)) return;
      assets.forEach((asset) => {
        if (isRecord(asset)) visit(asset);
      });
    });
  });
}

function collectReferencedObjectIds(project: WorkspaceProject) {
  const referenced = new Set<string>();
  const explicitlyDeleted = new Set(project.deletedObjectIds ?? []);
  const addReferencedObjectId = (value: unknown) => {
    const objectId = readString(value);
    if (objectId && !explicitlyDeleted.has(objectId)) referenced.add(objectId);
  };
  if (isRecord(project.bakeWorkspace) && isRecord(project.bakeWorkspace.bakeSets)) {
    Object.entries(project.bakeWorkspace.bakeSets).forEach(([objectId, bakeSet]) => {
      addReferencedObjectId(objectId);
      if (isRecord(bakeSet)) {
        addReferencedObjectId(bakeSet.objectId);
      }
    });
  }
  project.references.forEach((reference) => {
    if (isRecord(reference)) {
      addReferencedObjectId(reference.objectId);
    }
  });
  project.layers.forEach((layer) => {
    if (isRecord(layer)) {
      addReferencedObjectId(layer.objectId);
    }
  });
  project.captures.forEach((capture) => {
    if (isRecord(capture)) {
      addReferencedObjectId(capture.objectId);
    }
  });
  project.generations.forEach((generation) => {
    if (!isRecord(generation) || !isRecord(generation.metadata)) return;
    addReferencedObjectId(generation.metadata.objectId);
  });
  // Pipeline revisions own historical input/output assets too. Without these
  // references, a partial client save can incorrectly treat their objects as
  // orphaned and discard the object metadata required by a later handoff.
  forEachPipelineAsset(project.pipeline, (asset) => addReferencedObjectId(asset.objectId));
  return referenced;
}

function applyExplicitObjectDeletions(project: WorkspaceProject) {
  const deletedObjectIds = new Set(project.deletedObjectIds ?? []);
  if (deletedObjectIds.size === 0) return project;
  const removedLayerIds = new Set(
    project.layers
      .filter(isRecord)
      .filter((layer) => deletedObjectIds.has(readString(layer.objectId) ?? ''))
      .map((layer) => readString(layer.id))
      .filter((id): id is string => Boolean(id)),
  );
  let bakeWorkspace = project.bakeWorkspace;
  if (isRecord(bakeWorkspace) && isRecord(bakeWorkspace.bakeSets)) {
    const bakeSets = Object.fromEntries(
      Object.entries(bakeWorkspace.bakeSets).filter(
        ([objectId, bakeSet]) =>
          !deletedObjectIds.has(objectId) &&
          (!isRecord(bakeSet) ||
            !deletedObjectIds.has(readString(bakeSet.objectId) ?? '')),
      ),
    );
    const nextBakeWorkspace: Record<string, unknown> = { ...bakeWorkspace, bakeSets };
    if (deletedObjectIds.has(readString(nextBakeWorkspace.selectedObjectId) ?? '')) {
      delete nextBakeWorkspace.selectedObjectId;
    }
    bakeWorkspace = nextBakeWorkspace;
  }
  return {
    ...project,
    objects: project.objects.filter(
      (object) => !isRecord(object) || !deletedObjectIds.has(readString(object.id) ?? ''),
    ),
    references: project.references.filter(
      (reference) =>
        !isRecord(reference) ||
        !deletedObjectIds.has(readString(reference.objectId) ?? ''),
    ),
    captures: project.captures.filter(
      (capture) =>
        !isRecord(capture) ||
        !deletedObjectIds.has(readString(capture.objectId) ?? ''),
    ),
    generations: project.generations.filter(
      (generation) =>
        !isRecord(generation) ||
        !isRecord(generation.metadata) ||
        !deletedObjectIds.has(readString(generation.metadata.objectId) ?? ''),
    ),
    layers: project.layers.filter(
      (layer) =>
        !isRecord(layer) || !deletedObjectIds.has(readString(layer.objectId) ?? ''),
    ),
    bakedTextures: project.bakedTextures.filter((texture) => {
      if (!isRecord(texture)) return true;
      if (deletedObjectIds.has(readString(texture.objectId) ?? '')) return false;
      return !getBakedTextureSourceLayerIds(texture).some((layerId) =>
        removedLayerIds.has(layerId),
      );
    }),
    bakeWorkspace,
  };
}

function preserveReferencedObjects(
  existingProject: WorkspaceProject | undefined,
  inputProject: WorkspaceProject,
) {
  if (!existingProject || inputProject.objects.length >= existingProject.objects.length)
    return inputProject;
  const incomingObjectIds = new Set(
    inputProject.objects
      .filter(isRecord)
      .map((object) => readString(object.id))
      .filter((id): id is string => Boolean(id)),
  );
  const referencedObjectIds = collectReferencedObjectIds(inputProject);
  const preservedObjects = existingProject.objects.filter((object) => {
    if (!isRecord(object)) return false;
    const objectId = readString(object.id);
    return Boolean(
      objectId && !incomingObjectIds.has(objectId) && referencedObjectIds.has(objectId),
    );
  });
  if (preservedObjects.length === 0) return inputProject;
  return { ...inputProject, objects: [...inputProject.objects, ...preservedObjects] };
}

function normalizeProjectAssetReferences(
  userId: string,
  slug: string,
  project: WorkspaceProject,
): WorkspaceProject {
  const normalizeUrl = (url?: string) => workspaceUrlToProjectRelative(userId, slug, url);
  const objects = project.objects ?? [];
  const references = project.references ?? [];
  const captures = project.captures ?? [];
  const generations = project.generations ?? [];
  const layers = project.layers ?? [];
  const bakedTextures = project.bakedTextures ?? [];
  return {
    ...project,
    thumbnail: normalizeUrl(project.thumbnail) ?? '',
    objects: objects.map((object) =>
      isRecord(object)
        ? { ...object, sourcePath: normalizeUrl(readString(object.sourcePath)) }
        : object,
    ),
    references: references.map((reference) =>
      isRecord(reference)
        ? { ...reference, url: normalizeUrl(readString(reference.url)) }
        : reference,
    ),
    captures: captures.map((capture) =>
      isRecord(capture)
        ? {
            ...capture,
            colorUrl: normalizeUrl(readString(capture.colorUrl)),
            maskUrl: normalizeUrl(readString(capture.maskUrl)),
            depthUrl: normalizeUrl(readString(capture.depthUrl)),
            normalUrl: normalizeUrl(readString(capture.normalUrl)),
          }
        : capture,
    ),
    generations: generations.map((generation) =>
      isRecord(generation)
        ? { ...generation, resultUrl: normalizeUrl(readString(generation.resultUrl)) }
        : generation,
    ),
    layers: layers.map((layer) =>
      isRecord(layer)
        ? {
            ...layer,
            imageUrl: normalizeUrl(readString(layer.imageUrl)),
            maskUrl: normalizeUrl(readString(layer.maskUrl)),
            depthUrl: normalizeUrl(readString(layer.depthUrl)),
          }
        : layer,
    ),
    bakedTextures: bakedTextures.map((texture) =>
      isRecord(texture)
        ? { ...texture, imageUrl: normalizeUrl(readString(texture.imageUrl)) }
        : texture,
    ),
    bakeWorkspace: mapBakeWorkspaceAssetUrls(project.bakeWorkspace, normalizeUrl),
    ...(project.pipeline === undefined
      ? {}
      : { pipeline: mapProjectPipelineAssetUrls(project.pipeline, normalizeUrl) }),
  };
}

function defaultSettings() {
  return {
    resolution: '2K' as const,
    displayMode: 'pbr',
    projectionMode: 'perspective',
    colorManagement: 'srgb' as const,
  };
}

function getProjectFile(projectDir: string) {
  return path.join(projectDir, 'project.liclick.json');
}

async function ensureProjectFolders(projectDir: string) {
  await ensureDir(projectDir);
  await Promise.all([
    ...assetFolders.map((folder) => ensureDir(path.join(projectDir, 'assets', folder))),
    ensureDir(path.join(projectDir, 'exports')),
    ensureDir(path.join(projectDir, 'thumbnails')),
    ensureDir(path.join(projectDir, 'autosave')),
  ]);
}

async function allocateProjectSlug(userId: string, projectId: string, name: string) {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8) || createId('project').slice(-8);
  const baseSlug = `${slugify(name || 'Untitled Project')}-${safeId}`;
  let slug = baseSlug;
  for (let attempt = 2; ; attempt += 1) {
    try {
      await fs.access(getProjectDir(userId, slug));
      slug = `${baseSlug}-${attempt}`;
    } catch {
      return slug;
    }
  }
}

export async function createProject(userId: string, input: { name?: string; folderId?: string }) {
  const now = new Date().toISOString();
  const id = createId('project');
  const baseName = input.name?.trim() || 'Untitled Project';
  const slug = `${slugify(baseName)}-${id.slice(-8)}`;
  const projectDir = getUserProjectDir(userId, slug);
  await ensureProjectFolders(projectDir);

  const project: WorkspaceProject = {
    id,
    name: baseName,
    folderId: input.folderId ?? null,
    createdAt: now,
    updatedAt: now,
    thumbnail: '',
    objects: [],
    references: [],
    captures: [],
    generations: [],
    layers: [],
    bakedTextures: [],
    settings: defaultSettings(),
    currentMode: 'texture',
    workspaceVersion: '0.6.0',
    workspaceName: slug,
    workspaceMode: 'local-server',
    dirty: false,
    assetManifest: {
      models: [],
      references: [],
      captures: [],
      generations: [],
      layers: [],
      baked: [],
    },
  };
  await writeJsonFile(getProjectFile(projectDir), project);
  return { project, slug };
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  await ensureDir(getUserProjectsDir(userId));
  const entries = await fs.readdir(getUserProjectsDir(userId), { withFileTypes: true });
  const summaries: Array<ProjectSummary | undefined> = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const project = await readJsonFile<WorkspaceProject | undefined>(
          getProjectFile(getProjectDir(userId, entry.name)),
          undefined,
        );
        if (!project) return undefined;
        const summary: ProjectSummary = {
          id: project.id,
          name: project.name,
          folderId: project.folderId ?? null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          thumbnail: project.thumbnail
            ? resolveProjectAssetUrl(userId, entry.name, project.thumbnail)
            : '',
          local: true,
          slug: entry.name,
          localPath: getProjectDir(userId, entry.name),
          status: 'local',
        };
        return summary;
      }),
  );
  return summaries.filter((summary): summary is ProjectSummary => Boolean(summary));
}

export async function findProjectSlug(userId: string, projectId: string) {
  const projects = await listProjects(userId);
  return projects.find((project) => project.id === projectId)?.slug;
}

function getProjectDir(userId: string, slug: string) {
  return getUserProjectDir(userId, slug);
}

export function resolveProjectAssetUrl(userId: string, slug: string, relativePath: string) {
  if (!relativePath || relativePath.startsWith('data:') || relativePath.startsWith('blob:')) {
    return relativePath;
  }
  if (relativePath.startsWith('http')) {
    try {
      const url = new URL(relativePath);
      const currentWorkspaceRoot = new URL(toWorkspaceUrl(''));
      const sameLoopbackEndpoint =
        ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
        ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(currentWorkspaceRoot.hostname) &&
        url.protocol === currentWorkspaceRoot.protocol &&
        url.port === currentWorkspaceRoot.port;
      if (
        (url.origin === currentWorkspaceRoot.origin || sameLoopbackEndpoint) &&
        url.pathname.startsWith(currentWorkspaceRoot.pathname)
      ) {
        return toWorkspaceUrl(
          decodeURIComponent(url.pathname.slice(currentWorkspaceRoot.pathname.length)),
        );
      }
    } catch {
      return relativePath;
    }
    return relativePath;
  }
  return toWorkspaceUrl(path.join('users', userId, 'projects', slug, relativePath));
}

function resolveProjectAssets(
  userId: string,
  slug: string,
  project: WorkspaceProject,
): WorkspaceProject {
  const resolveUrl = (url?: string) => (url ? resolveProjectAssetUrl(userId, slug, url) : url);
  const objects = project.objects ?? [];
  const references = project.references ?? [];
  const captures = project.captures ?? [];
  const generations = project.generations ?? [];
  const layers = project.layers ?? [];
  const bakedTextures = project.bakedTextures ?? [];
  return {
    ...project,
    thumbnail: resolveUrl(project.thumbnail) ?? '',
    objects: objects.map((object) =>
      typeof object === 'object' && object
        ? { ...object, sourcePath: resolveUrl((object as { sourcePath?: string }).sourcePath) }
        : object,
    ),
    references: references.map((reference) =>
      typeof reference === 'object' && reference
        ? { ...reference, url: resolveUrl((reference as { url?: string }).url) }
        : reference,
    ),
    captures: captures.map((capture) =>
      typeof capture === 'object' && capture
        ? {
            ...capture,
            colorUrl: resolveUrl((capture as { colorUrl?: string }).colorUrl),
            maskUrl: resolveUrl((capture as { maskUrl?: string }).maskUrl),
            depthUrl: resolveUrl((capture as { depthUrl?: string }).depthUrl),
            normalUrl: resolveUrl((capture as { normalUrl?: string }).normalUrl),
          }
        : capture,
    ),
    generations: generations.map((generation) =>
      typeof generation === 'object' && generation
        ? { ...generation, resultUrl: resolveUrl((generation as { resultUrl?: string }).resultUrl) }
        : generation,
    ),
    layers: layers.map((layer) =>
      typeof layer === 'object' && layer
        ? {
            ...layer,
            imageUrl: resolveUrl((layer as { imageUrl?: string }).imageUrl),
            maskUrl: resolveUrl((layer as { maskUrl?: string }).maskUrl),
            depthUrl: resolveUrl((layer as { depthUrl?: string }).depthUrl),
          }
        : layer,
    ),
    bakedTextures: bakedTextures.map((texture) =>
      typeof texture === 'object' && texture
        ? { ...texture, imageUrl: resolveUrl((texture as { imageUrl?: string }).imageUrl) }
        : texture,
    ),
    bakeWorkspace: mapBakeWorkspaceAssetUrls(project.bakeWorkspace, resolveUrl),
    ...(project.pipeline === undefined
      ? {}
      : { pipeline: mapProjectPipelineAssetUrls(project.pipeline, resolveUrl) }),
  };
}

async function repairMissingLayerImageReferences(
  userId: string,
  slug: string,
  project: WorkspaceProject,
): Promise<WorkspaceProject> {
  let changed = false;
  const layers = await Promise.all(
    project.layers.map(async (layer) => {
      if (!isRecord(layer)) return layer;
      const layerId = readString(layer.id);
      if (!layerId || !/^[a-zA-Z0-9_-]+$/.test(layerId)) return layer;
      const repairedLayer: Record<string, unknown> = { ...layer };
      const candidates = [
        ['imageUrl', `${layerId}.png`],
        ['maskUrl', `${layerId}-mask.png`],
        ['depthUrl', `${layerId}-depth.png`],
      ] as const;
      let layerChanged = false;
      for (const [field, filename] of candidates) {
        if (readString(repairedLayer[field])) continue;
        const relativePath = path.posix.join('assets', 'layers', filename);
        try {
          await fs.access(path.join(getProjectDir(userId, slug), relativePath));
        } catch {
          continue;
        }
        repairedLayer[field] = relativePath;
        layerChanged = true;
      }
      changed ||= layerChanged;
      return layerChanged ? repairedLayer : layer;
    }),
  );
  return changed ? { ...project, layers } : project;
}

export async function loadProject(userId: string, projectId: string) {
  const slug = await findProjectSlug(userId, projectId);
  if (!slug) return undefined;
  const project = await readJsonFile<WorkspaceProject | undefined>(
    getProjectFile(getProjectDir(userId, slug)),
    undefined,
  );
  if (!project) return undefined;
  const repairedProject = await repairMissingLayerImageReferences(userId, slug, project);
  return { project: resolveProjectAssets(userId, slug, repairedProject), slug };
}

async function saveProjectUnlocked(
  userId: string,
  projectId: string,
  inputProject: WorkspaceProject,
) {
  const slug =
    (await findProjectSlug(userId, projectId)) ??
    (await allocateProjectSlug(userId, projectId, inputProject.name));
  const projectDir = getProjectDir(userId, slug);
  const rawExistingProject = await loadRawProjectBySlug(userId, slug);
  const existingProject = rawExistingProject
    ? await repairMissingLayerImageReferences(userId, slug, rawExistingProject)
    : undefined;
  // Older clients do not know about pipeline checkpoints and therefore omit
  // the field entirely. Treat omission as "leave unchanged"; a current client
  // can still explicitly clear it by saving an empty pipeline state.
  const pipelineSafeInput =
    inputProject.pipeline === undefined && existingProject?.pipeline !== undefined
      ? { ...inputProject, pipeline: existingProject.pipeline }
      : inputProject;
  const explicitDeletionIds = new Set(pipelineSafeInput.deletedObjectIds ?? []);
  const deletionAwareInput = applyExplicitObjectDeletions(pipelineSafeInput);
  if (existingProject) {
    const incomingUpdatedAt = Date.parse(inputProject.updatedAt);
    const existingUpdatedAt = Date.parse(existingProject.updatedAt);
    if (
      Number.isFinite(incomingUpdatedAt) &&
      Number.isFinite(existingUpdatedAt) &&
      incomingUpdatedAt < existingUpdatedAt
    ) {
      throw new ProjectSaveConflictError(
        'Blocked saving a stale project snapshot over newer project data. Reload and retry the save.',
      );
    }
    const existingHasSceneData =
      existingProject.objects.length > 0 || existingProject.layers.length > 0;
    const incomingClearsSceneData =
      deletionAwareInput.objects.length === 0 && deletionAwareInput.layers.length === 0;
    const explicitlyDeletesEveryExistingObject = existingProject.objects.every(
      (object) => {
        const objectId = isRecord(object) ? readString(object.id) : undefined;
        return Boolean(objectId && explicitDeletionIds.has(objectId));
      },
    );
    if (
      existingHasSceneData &&
      incomingClearsSceneData &&
      !explicitlyDeletesEveryExistingObject
    ) {
      throw new ProjectSaveConflictError(
        'Blocked saving an empty scene over an existing project with model or layer data.',
      );
    }
    const incomingUnexpectedlyDropsAllLayers =
      existingProject.layers.length > 0 &&
      deletionAwareInput.objects.length > 0 &&
      deletionAwareInput.layers.length === 0;
    const explicitlyDeletesEveryExistingLayer = existingProject.layers.every((layer) => {
      const objectId = isRecord(layer) ? readString(layer.objectId) : undefined;
      return Boolean(objectId && explicitDeletionIds.has(objectId));
    });
    if (incomingUnexpectedlyDropsAllLayers && !explicitlyDeletesEveryExistingLayer) {
      throw new ProjectSaveConflictError(
        'Blocked clearing every layer from a project that still contains models. Reload the complete project before saving.',
      );
    }
  }
  const now = new Date().toISOString();
  const objectSafeProject = preserveReferencedObjects(existingProject, deletionAwareInput);
  const sanitizedProject = normalizeProjectAssetReferences(
    userId,
    slug,
    sanitizeLowCoverageProjectedBakes(
      sanitizeVolatileLayerAssets(objectSafeProject, existingProject),
    ),
  );
  delete sanitizedProject.deletedObjectIds;
  const project = {
    ...sanitizedProject,
    id: projectId,
    updatedAt: now,
    lastSavedAt: now,
    dirty: false,
    workspaceVersion: inputProject.workspaceVersion ?? '0.6.0',
    workspaceMode: 'local-server',
    workspaceName: slug,
  };
  await ensureProjectFolders(projectDir);
  await writeJsonFile(getProjectFile(projectDir), project);
  await writeAutosave(projectDir, project);
  return { project: resolveProjectAssets(userId, slug, project), slug };
}

export async function saveProject(
  userId: string,
  projectId: string,
  inputProject: WorkspaceProject,
) {
  return runSerializedProjectSave(`${userId}:${projectId}`, () =>
    saveProjectUnlocked(userId, projectId, inputProject),
  );
}

async function loadRawProjectBySlug(userId: string, slug: string) {
  return readJsonFile<WorkspaceProject | undefined>(
    getProjectFile(getProjectDir(userId, slug)),
    undefined,
  );
}

async function updateProjectById(
  userId: string,
  projectId: string,
  updater: (project: WorkspaceProject, slug: string) => WorkspaceProject,
) {
  const slug = await findProjectSlug(userId, projectId);
  if (!slug) return undefined;
  const project = await loadRawProjectBySlug(userId, slug);
  if (!project) return undefined;
  const now = new Date().toISOString();
  const nextProject = {
    ...updater(project, slug),
    id: projectId,
    updatedAt: now,
    lastSavedAt: now,
    dirty: false,
    workspaceMode: 'local-server',
    workspaceName: slug,
  };
  await writeJsonFile(getProjectFile(getProjectDir(userId, slug)), nextProject);
  return { project: resolveProjectAssets(userId, slug, nextProject), slug };
}

export async function renameProject(userId: string, projectId: string, name: string) {
  const nextName = name.trim();
  if (!nextName) return undefined;
  return updateProjectById(userId, projectId, (project) => ({ ...project, name: nextName }));
}

export async function moveProject(userId: string, projectId: string, folderId: string | null) {
  return updateProjectById(userId, projectId, (project) => ({ ...project, folderId }));
}

export async function moveProjectsInFolderToRoot(userId: string, folderId: string) {
  const projects = await listProjects(userId);
  const matchingProjects = projects.filter((project) => project.folderId === folderId);
  await Promise.all(matchingProjects.map((project) => moveProject(userId, project.id, null)));
  return matchingProjects.length;
}

export async function duplicateProject(userId: string, projectId: string) {
  const slug = await findProjectSlug(userId, projectId);
  if (!slug) return undefined;
  const project = await loadRawProjectBySlug(userId, slug);
  if (!project) return undefined;

  const id = createId('project');
  const now = new Date().toISOString();
  const name = `${project.name} Copy`;
  const nextSlug = `${slugify(name)}-${id.slice(-8)}`;
  const sourceDir = getProjectDir(userId, slug);
  const targetDir = getProjectDir(userId, nextSlug);
  await fs.cp(sourceDir, targetDir, { recursive: true, errorOnExist: true });
  const duplicatedProject: WorkspaceProject = {
    ...project,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    lastSavedAt: now,
    workspaceName: nextSlug,
    workspaceMode: 'local-server',
    dirty: false,
  };
  await writeJsonFile(getProjectFile(targetDir), duplicatedProject);
  return { project: resolveProjectAssets(userId, nextSlug, duplicatedProject), slug: nextSlug };
}

export async function deleteProject(userId: string, projectId: string) {
  const slug = await findProjectSlug(userId, projectId);
  if (!slug) return undefined;
  await ensureDir(getUserTrashProjectsDir(userId));
  const sourceDir = getProjectDir(userId, slug);
  const trashSlug = `${slug}-${Date.now()}`;
  const targetDir = path.join(getUserTrashProjectsDir(userId), trashSlug);
  await fs.rename(sourceDir, targetDir);
  return { deleted: true, projectId, slug, trashSlug };
}
