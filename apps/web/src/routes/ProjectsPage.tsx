import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, HardDrive, Plus, RefreshCw } from 'lucide-react';
import { UserMenu } from '@/components/auth/UserMenu';
import { ContextMenu, ModalShell } from '@/components/common/ContextMenu';
import { Button } from '@/components/ui/Button';
import { ProjectCard } from '@/components/project/ProjectCard';
import { mockProjects } from '@/mock/mockProjects';
import { useI18nStore, useT } from '@/stores/i18nStore';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore } from '@/stores/projectStore';
import { useToastStore } from '@/stores/toastStore';
import { runFeishuLoginFlow } from '@/services/feishuLoginFlow';
import type { Project } from '@/types/project';
import {
  createFolder,
  createProject,
  deleteFolder,
  deleteProject,
  duplicateProject,
  getWorkspaceHealth,
  listFolders,
  listProjects,
  loadProject,
  moveProject,
  renameFolder,
  renameProject,
  WorkspaceApiError,
  type ProjectSummary,
  type WorkspaceFolder,
} from '@/services/workspaceApiClient';

type ProjectsPageProps = {
  onOpenProject: (projectId: string) => void;
  onLogout: () => void;
};

type SortMode = 'updated-desc' | 'created-desc' | 'created-asc' | 'name-asc';
type FolderFilter = string | null | undefined;
type PageNotice = {
  tone: 'info' | 'warning' | 'error';
  title: string;
  description?: string;
};

function projectFromSummary(summary: ProjectSummary): Project {
  return {
    id: summary.id,
    name: summary.name,
    folderId: summary.folderId ?? null,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    thumbnail: summary.thumbnail,
    objects: [],
    references: [],
    captures: [],
    generations: [],
    layers: [],
    bakedTextures: [],
    workspaceMode: 'local-server',
    workspaceName: summary.slug,
    workspaceVersion: '0.6.0',
    dirty: false,
    settings: {
      resolution: '2K',
      displayMode: 'pbr',
      projectionMode: 'perspective',
      colorManagement: 'srgb',
    },
  };
}

function sortProjects(projects: Project[], sortMode: SortMode) {
  return [...projects].sort((a, b) => {
    if (sortMode === 'name-asc') return a.name.localeCompare(b.name);
    if (sortMode === 'created-asc') return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (sortMode === 'created-desc') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

function mergeProjectsWithMock(serverProjects: Project[]) {
  const merged = new Map<string, Project>();
  for (const project of mockProjects) merged.set(project.id, project);
  for (const project of serverProjects) merged.set(project.id, project);
  return [...merged.values()];
}

function SortDropdown({ value, onChange }: { value: SortMode; onChange: (value: SortMode) => void }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const options: Array<{ value: SortMode; label: string }> = [
    { value: 'updated-desc', label: t('sortUpdatedDesc') },
    { value: 'created-desc', label: t('sortCreatedDesc') },
    { value: 'created-asc', label: t('sortCreatedAsc') },
    { value: 'name-asc', label: t('sortNameAsc') },
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="relative" onBlur={() => window.setTimeout(() => setOpen(false), 120)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-9 min-w-48 items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.075] px-3 text-sm font-medium text-white transition hover:bg-white/[0.12]"
      >
        <span>{selected.label}</span>
        <ChevronDown className="h-4 w-4 text-white/52" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-20 w-56 overflow-hidden rounded-md border border-white/12 bg-[#1d1d1d] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.42)]">
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm text-white/72 transition hover:bg-white/10 hover:text-white"
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="h-4 w-4 text-liclick-pink" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NameDialog({
  title,
  initialName = '',
  placeholder,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  initialName?: string;
  placeholder: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const t = useT();

  return (
    <ModalShell onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onConfirm(name.trim());
        }}
      >
        <div className="text-lg font-semibold text-white">{title}</div>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={placeholder}
          className="mt-4 h-10 w-full rounded-md border border-white/12 bg-black/30 px-3 text-sm text-white outline-none focus:border-liclick-pink"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <ModalShell onClose={onClose}>
      <div className="text-lg font-semibold text-white">{title}</div>
      <p className="mt-3 text-sm leading-6 text-white/58">{description}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="button" variant="primary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </ModalShell>
  );
}

function MoveDialog({
  folders,
  onClose,
  onConfirm,
}: {
  folders: WorkspaceFolder[];
  onClose: () => void;
  onConfirm: (folderId: string | null) => void;
}) {
  const t = useT();
  return (
    <ModalShell onClose={onClose}>
      <div className="text-lg font-semibold text-white">{t('moveToFolder')}</div>
      <div className="mt-4 grid gap-2">
        <Button className="justify-start" onClick={() => onConfirm(null)}>
          {t('rootFolder')}
        </Button>
        {folders.map((folder) => (
          <Button key={folder.id} className="justify-start" onClick={() => onConfirm(folder.id)}>
            <Folder className="h-4 w-4" />
            {folder.name}
          </Button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>{t('cancel')}</Button>
      </div>
    </ModalShell>
  );
}

export function ProjectsPage({ onOpenProject, onLogout }: ProjectsPageProps) {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('updated-desc');
  const [serverState, setServerState] = useState<'checking' | 'online' | 'offline'>('checking');
  const [pageNotice, setPageNotice] = useState<PageNotice | undefined>();
  const [activeFolderId, setActiveFolderId] = useState<FolderFilter>(undefined);
  const [nameDialog, setNameDialog] = useState<
    | { type: 'new-folder' }
    | { type: 'rename-folder'; folder: WorkspaceFolder }
    | { type: 'rename-project'; project: Project }
    | undefined
  >();
  const [deleteTarget, setDeleteTarget] = useState<
    | { type: 'folder'; folder: WorkspaceFolder }
    | { type: 'project'; project: Project }
    | undefined
  >();
  const [moveTarget, setMoveTarget] = useState<Project>();
  const projects = useProjectStore((state) => state.projects);
  const setProjects = useProjectStore((state) => state.setProjects);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const pushToast = useToastStore((state) => state.pushToast);
  const language = useI18nStore((state) => state.language);
  const t = useT();
  const visibleProjects = useMemo(() => {
    const filtered =
      activeFolderId === undefined
        ? projects
        : projects.filter((project) => (project.folderId ?? null) === activeFolderId);
    return sortProjects(filtered, sortMode);
  }, [activeFolderId, projects, sortMode]);

  async function refreshWorkspace(showOfflineToast = false) {
    try {
      await getWorkspaceHealth();
      setServerState('online');
      const [projectResult, folderResult] = await Promise.all([listProjects(), listFolders()]);
      setFolders(folderResult.folders);
      setProjects(mergeProjectsWithMock(projectResult.projects.map(projectFromSummary)));
      setPageNotice(undefined);
    } catch (error) {
      const isAuthRequired =
        error instanceof WorkspaceApiError && error.status === 401;
      setServerState(isAuthRequired ? 'online' : 'offline');
      if (isAuthRequired) {
        setFolders([]);
        setProjects(mergeProjectsWithMock([]));
        setPageNotice({
          tone: 'warning',
          title: '需要飞书登录',
          description: '当前服务器要求登录后才能创建、导入、保存和查看个人工程数据。请点击右上角“飞书登录”。',
        });
        pushToast({
          tone: 'warning',
          title: '需要飞书登录',
          description: '登录后会显示你自己的项目、文件夹、模型和素材。',
          dedupeKey: 'workspace-auth-required-project-list',
        });
        return;
      }
      if (showOfflineToast && !isAuthRequired) {
        setPageNotice({
          tone: 'error',
          title: '本地工作区服务不可用',
          description: t('workspaceOfflineHelp'),
        });
        pushToast({
          tone: 'warning',
          title: t('workspaceOfflineToast'),
          description: t('workspaceOfflineHelp'),
          dedupeKey: 'workspace-server-offline',
        });
      }
    }
  }

  useEffect(() => {
    void refreshWorkspace(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runWorkspaceAction(action: () => Promise<void>) {
    try {
      await action();
      await refreshWorkspace();
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.status === 401) {
        setServerState('online');
        setPageNotice({
          tone: 'warning',
          title: '需要飞书登录',
          description: '正在启动飞书/IDaaS 授权；完成后会自动重试刚才的操作。',
        });
        pushToast({
          tone: 'warning',
          title: '需要飞书登录',
          description: '创建和管理项目需要登录。授权完成后会自动重试刚才的操作。',
          dedupeKey: 'workspace-auth-required',
        });
        try {
          const result = await runFeishuLoginFlow({
            onStatus: (message) => {
              setPageNotice({
                tone: 'info',
                title: '等待飞书授权',
                description: message,
              });
              pushToast({
                tone: 'info',
                title: '等待飞书授权',
                description: message,
                dedupeKey: 'workspace-auth-waiting',
              });
            },
          });
          if (!result.user) throw new Error('登录服务没有返回用户信息。');
          setAuthenticated(result.user, result.authMode ?? 'feishu-oauth', providerStatus);
          setPageNotice({
            tone: 'info',
            title: '飞书登录成功',
            description: '正在恢复你的工程数据并重试刚才的操作。',
          });
          await action();
          await refreshWorkspace();
        } catch (loginError) {
          setPageNotice({
            tone: 'error',
            title: '飞书登录未完成',
            description: loginError instanceof Error ? loginError.message : '用户取消授权或登录失败。',
          });
          pushToast({
            tone: 'error',
            title: '飞书登录未完成',
            description: loginError instanceof Error ? loginError.message : '用户取消授权或登录失败。',
            dedupeKey: 'workspace-auth-failed',
          });
        }
        return;
      }
      setServerState('offline');
      setPageNotice({
        tone: 'error',
        title: t('workspaceActionFailed'),
        description: error instanceof Error ? error.message : t('workspaceOfflineHelp'),
      });
      pushToast({
        tone: 'error',
        title: t('workspaceActionFailed'),
        description: error instanceof Error ? error.message : t('workspaceOfflineHelp'),
      });
    }
  }

  async function handleNewProject() {
    await runWorkspaceAction(async () => {
      const result = await createProject({
        name: language === 'zh' ? '未命名项目' : 'Untitled Project',
        folderId: typeof activeFolderId === 'string' ? activeFolderId : undefined,
      });
      replaceCurrentProject(result.project);
      onOpenProject(result.project.id);
    });
  }

  async function handleOpenProject(projectId: string) {
    try {
      const result = await loadProject(projectId);
      replaceCurrentProject(result.project);
    } catch {
      // Mock fallback projects can still open without the local workspace server.
    }
    onOpenProject(projectId);
  }

  const statusText =
    serverState === 'online'
      ? t('workspaceConnected')
      : serverState === 'checking'
        ? t('workspaceChecking')
        : t('workspaceOffline');

  return (
    <main className="liclick-surface min-h-screen text-white">
      {nameDialog?.type === 'new-folder' && (
        <NameDialog
          title={t('createFolder')}
          placeholder={t('folderPlaceholder')}
          confirmLabel={t('create')}
          onClose={() => setNameDialog(undefined)}
          onConfirm={(name) => {
            setNameDialog(undefined);
            void runWorkspaceAction(async () => {
              await createFolder(name);
            });
          }}
        />
      )}
      {nameDialog?.type === 'rename-folder' && (
        <NameDialog
          title={t('renameFolder')}
          initialName={nameDialog.folder.name}
          placeholder={t('folderPlaceholder')}
          confirmLabel={t('rename')}
          onClose={() => setNameDialog(undefined)}
          onConfirm={(name) => {
            const { folder } = nameDialog;
            setNameDialog(undefined);
            void runWorkspaceAction(async () => {
              await renameFolder(folder.id, name);
            });
          }}
        />
      )}
      {nameDialog?.type === 'rename-project' && (
        <NameDialog
          title={t('renameProject')}
          initialName={nameDialog.project.name}
          placeholder={t('projectName')}
          confirmLabel={t('rename')}
          onClose={() => setNameDialog(undefined)}
          onConfirm={(name) => {
            const { project } = nameDialog;
            setNameDialog(undefined);
            void runWorkspaceAction(async () => {
              await renameProject(project.id, name);
            });
          }}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={deleteTarget.type === 'folder' ? t('deleteFolder') : t('deleteProject')}
          description={deleteTarget.type === 'folder' ? t('deleteFolderHelp') : t('deleteProjectHelp')}
          confirmLabel={t('delete')}
          onClose={() => setDeleteTarget(undefined)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(undefined);
            void runWorkspaceAction(async () => {
              if (target.type === 'folder') await deleteFolder(target.folder.id);
              else await deleteProject(target.project.id);
              if (target.type === 'folder' && activeFolderId === target.folder.id) setActiveFolderId(undefined);
            });
          }}
        />
      )}
      {moveTarget && (
        <MoveDialog
          folders={folders}
          onClose={() => setMoveTarget(undefined)}
          onConfirm={(folderId) => {
            const project = moveTarget;
            setMoveTarget(undefined);
            void runWorkspaceAction(async () => {
              await moveProject(project.id, folderId);
            });
          }}
        />
      )}

      <section className="mx-auto w-full max-w-[1240px] px-6 py-12 sm:px-8 lg:py-16">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-medium tracking-normal text-white">{t('projects')}</h1>
            <div className="mt-2 flex items-center gap-2 text-xs text-white/42">
              <HardDrive className="h-3.5 w-3.5" />
              <span>{statusText}</span>
              <button
                type="button"
                onClick={() => void refreshWorkspace(true)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-white/56 transition hover:bg-white/10 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('retry')}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="h-10 border-white/18 bg-black/18 px-4"
              icon={<FolderPlus className="h-4 w-4" />}
              onClick={() => setNameDialog({ type: 'new-folder' })}
            >
              {t('newFolder')}
            </Button>
            <Button className="h-10 px-4" icon={<Plus className="h-4 w-4" />} variant="primary" onClick={() => void handleNewProject()}>
              {t('newProject')}
            </Button>
            <UserMenu onLogout={onLogout} />
          </div>
        </div>

        {pageNotice && (
          <div
            className={`mt-5 rounded-md border px-4 py-3 text-sm leading-6 ${
              pageNotice.tone === 'error'
                ? 'border-red-400/32 bg-red-500/12 text-red-50'
                : pageNotice.tone === 'warning'
                  ? 'border-amber-300/32 bg-amber-400/12 text-amber-50'
                  : 'border-sky-300/30 bg-sky-400/12 text-sky-50'
            }`}
          >
            <div className="font-semibold">{pageNotice.title}</div>
            {pageNotice.description && <div className="mt-1 text-white/72">{pageNotice.description}</div>}
          </div>
        )}

        <section className="mt-9">
          <h2 className="mb-4 text-xl font-medium tracking-normal text-white/90">{t('folders')}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <button
              type="button"
              onClick={() => setActiveFolderId(undefined)}
              className={`flex h-14 items-center gap-3 rounded-md border px-4 text-left text-sm font-semibold transition ${
                activeFolderId === undefined
                  ? 'border-white/32 bg-[#6f6f6f] text-white'
                  : 'border-white/10 bg-[#303030] text-white/82 hover:border-white/20 hover:bg-[#383838]'
              }`}
            >
              <Folder className="h-5 w-5 shrink-0 text-white/68" />
              <span>{t('allProjects')}</span>
            </button>
            {folders.map((folder) => (
              <div
                key={folder.id}
                className={`flex h-14 items-center rounded-md border text-sm font-semibold transition ${
                  activeFolderId === folder.id
                    ? 'border-white/32 bg-[#6f6f6f] text-white'
                    : 'border-white/10 bg-[#303030] text-white/82 hover:border-white/20 hover:bg-[#383838]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveFolderId(folder.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 text-left"
                >
                  <Folder className="h-5 w-5 shrink-0 text-white/68" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                </button>
                <ContextMenu
                  className="mr-2"
                  items={[
                    { id: 'rename', label: t('rename'), onSelect: () => setNameDialog({ type: 'rename-folder', folder }) },
                    { id: 'delete', label: t('delete'), tone: 'danger', onSelect: () => setDeleteTarget({ type: 'folder', folder }) },
                  ]}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-medium tracking-normal text-white/90">{t('projects')}</h2>
            <SortDropdown value={sortMode} onChange={setSortMode} />
          </div>
          {visibleProjects.length === 0 ? (
            <div className="rounded-md border border-white/10 bg-[#1d1d1d]/72 px-4 py-8 text-sm text-white/48">
              {t('noProjects')}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {visibleProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={handleOpenProject}
                  menuItems={
                    project.workspaceMode === 'local-server'
                      ? [
                          { id: 'edit', label: t('edit'), onSelect: () => setNameDialog({ type: 'rename-project', project }) },
                          {
                            id: 'copy',
                            label: t('makeCopy'),
                            onSelect: () => void runWorkspaceAction(async () => {
                              await duplicateProject(project.id);
                            }),
                          },
                          { id: 'move', label: t('move'), onSelect: () => setMoveTarget(project) },
                          { id: 'delete', label: t('delete'), tone: 'danger', onSelect: () => setDeleteTarget({ type: 'project', project }) },
                        ]
                      : []
                  }
                />
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
