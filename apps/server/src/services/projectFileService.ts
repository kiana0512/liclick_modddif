import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary, WorkspaceProject } from '../types/project.js';
import { writeAutosave } from './autosaveService.js';
import {
  createId,
  ensureDir,
  getProjectDir,
  getProjectsDir,
  getTrashProjectsDir,
  readJsonFile,
  slugify,
  toWorkspaceUrl,
  writeJsonFile,
} from './workspaceService.js';

const assetFolders = ['models', 'references', 'captures', 'generations', 'layers', 'baked'];

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

export async function createProject(input: { name?: string; folderId?: string }) {
  const now = new Date().toISOString();
  const id = createId('project');
  const baseName = input.name?.trim() || 'Untitled Project';
  const slug = `${slugify(baseName)}-${id.slice(-8)}`;
  const projectDir = getProjectDir(slug);
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

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureDir(getProjectsDir());
  const entries = await fs.readdir(getProjectsDir(), { withFileTypes: true });
  const summaries: Array<ProjectSummary | undefined> = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const project = await readJsonFile<WorkspaceProject | undefined>(
          getProjectFile(getProjectDir(entry.name)),
          undefined,
        );
        if (!project) return undefined;
        const summary: ProjectSummary = {
          id: project.id,
          name: project.name,
          folderId: project.folderId ?? null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          thumbnail: project.thumbnail ? resolveProjectAssetUrl(entry.name, project.thumbnail) : '',
          local: true,
          slug: entry.name,
          localPath: getProjectDir(entry.name),
          status: 'local',
        };
        return summary;
      }),
  );
  return summaries.filter((summary): summary is ProjectSummary => Boolean(summary));
}

export async function findProjectSlug(projectId: string) {
  const projects = await listProjects();
  return projects.find((project) => project.id === projectId)?.slug;
}

export function resolveProjectAssetUrl(slug: string, relativePath: string) {
  if (!relativePath || relativePath.startsWith('data:') || relativePath.startsWith('blob:') || relativePath.startsWith('http')) {
    return relativePath;
  }
  return toWorkspaceUrl(path.join('projects', slug, relativePath));
}

function resolveProjectAssets(slug: string, project: WorkspaceProject): WorkspaceProject {
  const resolveUrl = (url?: string) => (url ? resolveProjectAssetUrl(slug, url) : url);
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

export async function loadProject(projectId: string) {
  const slug = await findProjectSlug(projectId);
  if (!slug) return undefined;
  const project = await readJsonFile<WorkspaceProject | undefined>(getProjectFile(getProjectDir(slug)), undefined);
  if (!project) return undefined;
  return { project: resolveProjectAssets(slug, project), slug };
}

export async function saveProject(projectId: string, inputProject: WorkspaceProject) {
  const slug = await findProjectSlug(projectId);
  if (!slug) return undefined;
  const projectDir = getProjectDir(slug);
  const now = new Date().toISOString();
  const project = {
    ...inputProject,
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

async function loadRawProjectBySlug(slug: string) {
  return readJsonFile<WorkspaceProject | undefined>(getProjectFile(getProjectDir(slug)), undefined);
}

async function updateProjectById(
  projectId: string,
  updater: (project: WorkspaceProject, slug: string) => WorkspaceProject,
) {
  const slug = await findProjectSlug(projectId);
  if (!slug) return undefined;
  const project = await loadRawProjectBySlug(slug);
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
  await writeJsonFile(getProjectFile(getProjectDir(slug)), nextProject);
  return { project: resolveProjectAssets(slug, nextProject), slug };
}

export async function renameProject(projectId: string, name: string) {
  const nextName = name.trim();
  if (!nextName) return undefined;
  return updateProjectById(projectId, (project) => ({ ...project, name: nextName }));
}

export async function moveProject(projectId: string, folderId: string | null) {
  return updateProjectById(projectId, (project) => ({ ...project, folderId }));
}

export async function moveProjectsInFolderToRoot(folderId: string) {
  const projects = await listProjects();
  const matchingProjects = projects.filter((project) => project.folderId === folderId);
  await Promise.all(matchingProjects.map((project) => moveProject(project.id, null)));
  return matchingProjects.length;
}

export async function duplicateProject(projectId: string) {
  const slug = await findProjectSlug(projectId);
  if (!slug) return undefined;
  const project = await loadRawProjectBySlug(slug);
  if (!project) return undefined;

  const id = createId('project');
  const now = new Date().toISOString();
  const name = `${project.name} Copy`;
  const nextSlug = `${slugify(name)}-${id.slice(-8)}`;
  const sourceDir = getProjectDir(slug);
  const targetDir = getProjectDir(nextSlug);
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
  return { project: resolveProjectAssets(nextSlug, duplicatedProject), slug: nextSlug };
}

export async function deleteProject(projectId: string) {
  const slug = await findProjectSlug(projectId);
  if (!slug) return undefined;
  await ensureDir(getTrashProjectsDir());
  const sourceDir = getProjectDir(slug);
  const trashSlug = `${slug}-${Date.now()}`;
  const targetDir = path.join(getTrashProjectsDir(), trashSlug);
  await fs.rename(sourceDir, targetDir);
  return { deleted: true, projectId, slug, trashSlug };
}
