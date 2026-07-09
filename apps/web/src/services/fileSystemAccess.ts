export type FileSystemPermissionMode = 'read' | 'readwrite';

export type FileSystemPermissionDescriptor = {
  mode?: FileSystemPermissionMode;
};

export interface WritableFileStream {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface LiclickFileSystemFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFileStream>;
  queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
}

export interface LiclickFileSystemDirectoryHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LiclickFileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LiclickFileSystemFileHandle>;
  queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
}

type WindowWithFileSystemAccess = Window & {
  showDirectoryPicker?: () => Promise<LiclickFileSystemDirectoryHandle>;
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<LiclickFileSystemFileHandle[]>;
};

export function supportsFileSystemAccess() {
  const fsWindow = window as WindowWithFileSystemAccess;
  return typeof fsWindow.showDirectoryPicker === 'function' && typeof fsWindow.showOpenFilePicker === 'function';
}

export async function pickWorkspaceDirectory() {
  const fsWindow = window as WindowWithFileSystemAccess;
  if (!fsWindow.showDirectoryPicker) throw new Error('File System Access API is not supported.');
  return fsWindow.showDirectoryPicker();
}

export async function pickProjectFile() {
  const fsWindow = window as WindowWithFileSystemAccess;
  if (!fsWindow.showOpenFilePicker) throw new Error('File System Access API is not supported.');
  const handles = await fsWindow.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: 'Liclick Project',
        accept: {
          'application/json': ['.liclick.json', '.json'],
        },
      },
    ],
  });
  return handles[0];
}

export async function ensureReadWritePermission(handle: LiclickFileSystemDirectoryHandle) {
  if (handle.queryPermission) {
    const current = await handle.queryPermission({ mode: 'readwrite' });
    if (current === 'granted') return true;
  }
  if (handle.requestPermission) {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  }
  return true;
}

export async function ensureDirectory(
  root: LiclickFileSystemDirectoryHandle,
  path: string[],
): Promise<LiclickFileSystemDirectoryHandle> {
  let current = root;
  for (const part of path) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

export async function writeFile(
  directory: LiclickFileSystemDirectoryHandle,
  name: string,
  data: Blob | string,
) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}
