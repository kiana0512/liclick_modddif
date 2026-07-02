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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
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
  return readStringArray(texture.sourceLayerIds) ?? [readString(texture.sourceLayerId)].filter((id): id is string => Boolean(id));
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
    if (coverageRatio === undefined || coverageRatio >= MIN_SAVED_PROJECTED_BAKE_COVERAGE_RATIO) return true;
    const sourceLayerIds = getBakedTextureSourceLayerIds(texture);
    const allSourcesAreProjectedOrStale = sourceLayerIds.every((id) => projectedLayerIds.has(id) || !layerIds.has(id));
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

function sanitizeVolatileLayerAssets(project: WorkspaceProject): WorkspaceProject {
  const capturesById = new Map(
    project.captures
      .filter(isRecord)
      .map((capture) => [readString(capture.id), capture])
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])),
  );
  let changed = false;
  const layers = project.layers.map((layer) => {
    if (!isRecord(layer)) return layer;
    const capture = capturesById.get(readString(layer.captureId) ?? '');
    const nextLayer: Record<string, unknown> = { ...layer };
    if (isBlobUrl(nextLayer.maskUrl)) {
      nextLayer.maskUrl = isBlobUrl(capture?.maskUrl) ? undefined : capture?.maskUrl;
      changed = true;
    }
    if (isBlobUrl(nextLayer.depthUrl)) {
      nextLayer.depthUrl = isBlobUrl(capture?.depthUrl) ? undefined : capture?.depthUrl;
      changed = true;
    }
    if (isBlobUrl(nextLayer.imageUrl)) {
      delete nextLayer.imageUrl;
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
  const workspaceRelativePath = decodeURIComponent(pathname.slice('/workspace/'.length)).replaceAll('\\', '/');
  const projectPrefix = `users/${userId}/projects/${slug}/`;
  return workspaceRelativePath.startsWith(projectPrefix)
    ? workspaceRelativePath.slice(projectPrefix.length)
    : value;
}

function normalizeProjectAssetReferences(userId: string, slug: string, project: WorkspaceProject): WorkspaceProject {
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
      isRecord(object) ? { ...object, sourcePath: normalizeUrl(readString(object.sourcePath)) } : object,
    ),
    references: references.map((reference) =>
      isRecord(reference) ? { ...reference, url: normalizeUrl(readString(reference.url)) } : reference,
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
      isRecord(generation) ? { ...generation, resultUrl: normalizeUrl(readString(generation.resultUrl)) } : generation,
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
      isRecord(texture) ? { ...texture, imageUrl: normalizeUrl(readString(texture.imageUrl)) } : texture,
    ),
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
          thumbnail: project.thumbnail ? resolveProjectAssetUrl(userId, entry.name, project.thumbnail) : '',
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
      if (url.pathname.startsWith('/workspace/')) {
        return toWorkspaceUrl(decodeURIComponent(url.pathname.slice('/workspace/'.length)));
      }
    } catch {
      return relativePath;
    }
    return relativePath;
  }
  return toWorkspaceUrl(path.join('users', userId, 'projects', slug, relativePath));
}

function resolveProjectAssets(userId: string, slug: string, project: WorkspaceProject): WorkspaceProject {
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
  };
}

export async function loadProject(userId: string, projectId: string) {
  const slug = await findProjectSlug(userId, projectId);
  if (!slug) return undefined;
  const project = await readJsonFile<WorkspaceProject | undefined>(getProjectFile(getProjectDir(userId, slug)), undefined);
  if (!project) return undefined;
  return { project: resolveProjectAssets(userId, slug, project), slug };
}

export async function saveProject(userId: string, projectId: string, inputProject: WorkspaceProject) {
  const slug = await findProjectSlug(userId, projectId);
  if (!slug) return undefined;
  const projectDir = getProjectDir(userId, slug);
  const existingProject = await loadRawProjectBySlug(userId, slug);
  if (existingProject) {
    const existingHasSceneData = existingProject.objects.length > 0 || existingProject.layers.length > 0;
    const incomingClearsSceneData = inputProject.objects.length === 0 && inputProject.layers.length === 0;
    if (existingHasSceneData && incomingClearsSceneData) {
      throw new ProjectSaveConflictError(
        'Blocked saving an empty scene over an existing project with model or layer data.',
      );
    }
  }
  const now = new Date().toISOString();
  const sanitizedProject = normalizeProjectAssetReferences(
    userId,
    slug,
    sanitizeLowCoverageProjectedBakes(sanitizeVolatileLayerAssets(inputProject)),
  );
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
  return { project, slug };
}

async function loadRawProjectBySlug(userId: string, slug: string) {
  return readJsonFile<WorkspaceProject | undefined>(getProjectFile(getProjectDir(userId, slug)), undefined);
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
