import { exportProjectJson, validateProjectJson } from './projectService';
import {
  ensureDirectory,
  ensureReadWritePermission,
  pickProjectFile,
  pickWorkspaceDirectory,
  supportsFileSystemAccess,
  writeFile,
  type LiclickFileSystemDirectoryHandle,
} from './fileSystemAccess';
import { getIndexedDbValue, putIndexedDbValue } from './indexedDbService';
import type { AssetManifest, Project } from '@/types/project';
import type { WorkspaceLoadResult, WorkspaceSaveResult } from '@/types/workspace';

const recentWorkspaceKey = 'recent-workspace-directory';
let currentWorkspaceHandle: LiclickFileSystemDirectoryHandle | undefined;

function isPersistableUrl(url?: string) {
  return Boolean(url && (url.startsWith('data:') || url.startsWith('blob:')));
}

function extensionFromDataUrl(url: string) {
  if (url.startsWith('data:image/png')) return 'png';
  if (url.startsWith('data:image/jpeg')) return 'jpg';
  if (url.startsWith('data:image/svg+xml')) return 'svg';
  return 'bin';
}

async function urlToBlob(url: string) {
  const response = await fetch(url);
  return response.blob();
}

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'asset';
}

async function saveUrlAsset(input: {
  root: LiclickFileSystemDirectoryHandle;
  path: string[];
  fileStem: string;
  url?: string;
}) {
  if (!input.url || !isPersistableUrl(input.url)) return undefined;
  const directory = await ensureDirectory(input.root, input.path);
  const extension = input.url.startsWith('data:') ? extensionFromDataUrl(input.url) : 'png';
  const name = `${safeFileName(input.fileStem)}.${extension}`;
  await writeFile(directory, name, await urlToBlob(input.url));
  return [...input.path, name].join('/');
}

async function saveProjectAssets(root: LiclickFileSystemDirectoryHandle, project: Project) {
  const manifest: AssetManifest = {
    models: [],
    references: [],
    generations: [],
    layers: [],
    baked: [],
  };

  const projectForSave: Project = structuredClone(project);

  for (const object of projectForSave.objects) {
    const saved = await saveUrlAsset({
      root,
      path: ['assets', 'models'],
      fileStem: object.name,
      url: object.sourcePath,
    });
    if (saved) {
      object.sourcePath = saved;
      manifest.models.push(saved);
    }
  }

  for (const reference of projectForSave.references) {
    const saved = await saveUrlAsset({
      root,
      path: ['assets', 'references'],
      fileStem: reference.name,
      url: reference.url,
    });
    if (saved) {
      reference.url = saved;
      manifest.references.push(saved);
    }
  }

  for (const generation of projectForSave.generations) {
    const saved = await saveUrlAsset({
      root,
      path: ['assets', 'generations'],
      fileStem: generation.id,
      url: generation.resultUrl,
    });
    if (saved) {
      generation.resultUrl = saved;
      manifest.generations.push(saved);
    }
  }

  for (const layer of projectForSave.layers) {
    const saved = await saveUrlAsset({
      root,
      path: ['assets', 'layers'],
      fileStem: layer.name,
      url: layer.imageUrl,
    });
    if (saved) {
      layer.imageUrl = saved;
      manifest.layers.push(saved);
    }
  }

  for (const bakedTexture of projectForSave.bakedTextures) {
    const saved = await saveUrlAsset({
      root,
      path: ['assets', 'baked'],
      fileStem: bakedTexture.id,
      url: bakedTexture.imageUrl,
    });
    if (saved) {
      bakedTexture.imageUrl = saved;
      manifest.baked.push(saved);
    }
  }

  projectForSave.assetManifest = manifest;
  projectForSave.workspaceMode = 'file-system-access';
  projectForSave.workspaceName = root.name;
  return { projectForSave, manifest };
}

export async function getRecentWorkspaceHandle() {
  currentWorkspaceHandle ??= await getIndexedDbValue<LiclickFileSystemDirectoryHandle>(recentWorkspaceKey);
  return currentWorkspaceHandle;
}

export async function saveProjectAsWorkspace(project: Project): Promise<WorkspaceSaveResult> {
  if (!supportsFileSystemAccess()) {
    return {
      mode: 'download-fallback',
      project,
      lastSavedAt: new Date().toISOString(),
      message: 'Browser fallback: Download JSON only.',
    };
  }

  const directory = await pickWorkspaceDirectory();
  const allowed = await ensureReadWritePermission(directory);
  if (!allowed) throw new Error('Write permission was not granted for the selected project folder.');
  currentWorkspaceHandle = directory;
  await putIndexedDbValue(recentWorkspaceKey, directory);
  return saveProjectToWorkspace(project, directory);
}

export async function saveProjectToWorkspace(
  project: Project,
  directory = currentWorkspaceHandle,
): Promise<WorkspaceSaveResult> {
  if (!supportsFileSystemAccess() || !directory) {
    return {
      mode: 'download-fallback',
      project,
      lastSavedAt: new Date().toISOString(),
      message: 'Browser fallback: Download JSON only.',
    };
  }

  const allowed = await ensureReadWritePermission(directory);
  if (!allowed) throw new Error('Write permission was not granted for the selected project folder.');

  await ensureDirectory(directory, ['assets', 'models']);
  await ensureDirectory(directory, ['assets', 'references']);
  await ensureDirectory(directory, ['assets', 'generations']);
  await ensureDirectory(directory, ['assets', 'layers']);
  await ensureDirectory(directory, ['assets', 'baked']);
  await ensureDirectory(directory, ['thumbnails']);

  const { projectForSave } = await saveProjectAssets(directory, project);
  const lastSavedAt = new Date().toISOString();
  projectForSave.lastSavedAt = lastSavedAt;
  projectForSave.dirty = false;

  await writeFile(directory, 'project.liclick.json', exportProjectJson(projectForSave));

  return {
    mode: 'file-system-access',
    workspaceName: directory.name,
    project: projectForSave,
    lastSavedAt,
    message: 'Project saved locally.',
  };
}

export async function loadProjectWithPicker(): Promise<WorkspaceLoadResult> {
  if (!supportsFileSystemAccess()) throw new Error('File System Access API is not supported.');
  const fileHandle = await pickProjectFile();
  const file = await fileHandle.getFile();
  const text = await file.text();
  const project = validateProjectJson(JSON.parse(text) as unknown);
  const warnings: string[] = [];
  const allAssetUrls = [
    ...project.references.map((reference) => reference.url),
    ...project.generations.map((generation) => generation.resultUrl),
    ...project.layers.map((layer) => layer.imageUrl),
    ...project.bakedTextures.map((texture) => texture.imageUrl),
  ].filter(Boolean);
  if (allAssetUrls.some((url) => url && !url.startsWith('data:') && !url.startsWith('blob:') && !url.startsWith('http'))) {
    warnings.push('Some project assets use relative paths. They may need the original workspace folder.');
  }
  return { project, warnings };
}
