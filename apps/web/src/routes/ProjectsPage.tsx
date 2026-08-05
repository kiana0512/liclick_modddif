import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Flame, Folder, FolderPlus, Palette, Plus } from 'lucide-react';
import { UserMenu } from '@/components/auth/UserMenu';
import { BrandMark } from '@/components/common/BrandMark';
import { ContextMenu, ModalShell } from '@/components/common/ContextMenu';
import { Button } from '@/components/ui/Button';
import { ProjectCard } from '@/components/project/ProjectCard';
import { useT } from '@/stores/i18nStore';
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
  saveProject as saveWorkspaceProject,
  WorkspaceApiError,
  type ProjectSummary,
  type WorkspaceFolder,
} from '@/services/workspaceApiClient';

type ProjectsPageProps = {
  module: 'texture' | 'bake';
  onBack: () => void;
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

function mergeWorkspaceProjects(
  serverProjects: Project[],
  currentProjects: Project[] = [],
  serverProjectsAuthoritative = true,
) {
  const formalProjects = serverProjectsAuthoritative
    ? serverProjects
    : currentProjects.filter((project) => project.workspaceMode === 'local-server');
  if (formalProjects.length === 0) return [];

  const merged = new Map<string, Project>();
  const currentProjectById = new Map(currentProjects.map((project) => [project.id, project]));
  for (const project of formalProjects) {
    const currentProject = currentProjectById.get(project.id);
    const currentThumbnail = currentProject?.thumbnail;
    merged.set(project.id, {
      ...project,
      // Project list responses contain summaries only. Never replace a project that has
      // already been hydrated with the summary's placeholder empty collections: a late
      // list refresh can otherwise race project opening and make the editor autosave an
      // empty layer stack over the real project.
      ...(currentProject
        ? {
            objects: currentProject.objects,
            references: currentProject.references,
            captures: currentProject.captures,
            generations: currentProject.generations,
            layers: currentProject.layers,
            bakedTextures: currentProject.bakedTextures,
            settings: currentProject.settings,
            bakeWorkspace: currentProject.bakeWorkspace,
            currentMode: currentProject.currentMode,
            activeObjectId: currentProject.activeObjectId,
            activeLayerId: currentProject.activeLayerId,
            assetManifest: currentProject.assetManifest,
            lastSavedAt: currentProject.lastSavedAt,
            dirty: currentProject.dirty,
          }
        : {}),
      thumbnail:
        currentThumbnail && (currentThumbnail.startsWith('data:') || currentThumbnail.startsWith('blob:'))
          ? currentThumbnail
          : project.thumbnail,
    });
  }
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
        className="inline-flex h-9 min-w-44 items-center justify-between gap-3 rounded-md border border-white/12 bg-[#262731] px-3 text-[13px] font-medium text-white/86 transition hover:border-white/20 hover:bg-[#30313b] hover:text-white"
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

export function ProjectsPage({ module, onBack, onOpenProject, onLogout }: ProjectsPageProps) {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('updated-desc');
  const [, setServerState] = useState<'checking' | 'online' | 'offline'>('checking');
  const [pageNotice, setPageNotice] = useState<PageNotice | undefined>();
  const [activeFolderId, setActiveFolderId] = useState<FolderFilter>(undefined);
  const [nameDialog, setNameDialog] = useState<
    | { type: 'new-project' }
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
  const authStatus = useAuthStore((state) => state.status);
  const authenticatedUserId = useAuthStore((state) => state.user?.id);
  const providerStatus = useAuthStore((state) => state.providerStatus);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const pushToast = useToastStore((state) => state.pushToast);
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
      setProjects(
        mergeWorkspaceProjects(
          projectResult.projects.map(projectFromSummary),
          useProjectStore.getState().projects,
        ),
      );
      setPageNotice(undefined);
    } catch (error) {
      const isAuthRequired =
        error instanceof WorkspaceApiError && error.status === 401;
      setServerState(isAuthRequired ? 'online' : 'offline');
      if (isAuthRequired) {
        setFolders([]);
        setProjects(mergeWorkspaceProjects([], useProjectStore.getState().projects, false));
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
    if (authStatus === 'checking') return;
    void refreshWorkspace(true);
    // Authentication changes are a data boundary: immediately replace the
    // anonymous/mock list with the signed-in user's folders and projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, authenticatedUserId]);

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

  async function handleNewProject(name: string) {
    await runWorkspaceAction(async () => {
      const result = await createProject({
        name,
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
      const fallbackProject = useProjectStore
        .getState()
        .projects.find((project) => project.id === projectId);
      if (fallbackProject) {
        try {
          const result = await saveWorkspaceProject({
            ...fallbackProject,
            workspaceMode: 'local-server',
            dirty: true,
          });
          replaceCurrentProject(result.project);
        } catch {
          // Keep an already loaded project available if workspace persistence is temporarily offline.
        }
      }
    }
    onOpenProject(projectId);
  }

  return (
    <main className="li3d-home-surface min-h-screen text-white">
      {nameDialog?.type === 'new-project' && (
        <NameDialog
          title={t('newProject')}
          placeholder={t('projectName')}
          confirmLabel={t('create')}
          onClose={() => setNameDialog(undefined)}
          onConfirm={(name) => {
            setNameDialog(undefined);
            void handleNewProject(name);
          }}
        />
      )}
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

      <header className="flex h-16 items-center border-b border-white/[0.055] px-4 sm:px-6">
        <BrandMark />
      </header>

      <section className="mx-auto w-full max-w-[1240px] px-4 pb-16 pt-8 sm:px-7 lg:px-8">
        <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <div>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 text-sm text-white/44 transition hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              返回功能首页
            </button>
            <div className="mt-5 flex items-center gap-3">
              <span className={`grid h-10 w-10 place-items-center rounded-xl border ${module === 'texture' ? 'border-fuchsia-300/24 bg-fuchsia-400/10 text-fuchsia-100' : 'border-orange-300/24 bg-orange-400/10 text-orange-100'}`}>
                {module === 'texture' ? <Palette className="h-5 w-5" /> : <Flame className="h-5 w-5" />}
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-[-0.025em] text-white">
                  {module === 'texture' ? '贴图绘制' : '模型烘焙'}
                </h1>
                <p className="mt-1 text-xs text-white/36">
                  {module === 'texture' ? '选择项目进入贴图创作工作台' : '选择项目进入独立烘焙工作台'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              className="h-10 border-white/16 bg-transparent px-4 hover:border-white/28 hover:bg-white/8"
              icon={<FolderPlus className="h-4 w-4" />}
              onClick={() => setNameDialog({ type: 'new-folder' })}
            >
              {t('newFolder')}
            </Button>
            <Button
              className="h-10 px-4"
              icon={<Plus className="h-4 w-4" />}
              variant="primary"
              onClick={() => setNameDialog({ type: 'new-project' })}
            >
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

        <section className="mt-5 sm:mt-6">
          <h1 className="mb-4 text-[19px] font-medium tracking-[-0.01em] text-white/88">{t('folders')}</h1>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <button
              type="button"
              onClick={() => setActiveFolderId(undefined)}
              className={`flex h-[54px] items-center gap-3 rounded-md border px-4 text-left text-sm font-semibold transition ${
                activeFolderId === undefined
                  ? 'border-violet-200/28 bg-[#686970] text-white shadow-[0_8px_22px_rgba(0,0,0,0.14)]'
                  : 'border-white/[0.075] bg-[#303136] text-white/82 hover:border-white/18 hover:bg-[#383941]'
              }`}
            >
              <Folder className="h-5 w-5 shrink-0 text-white/68" />
              <span>{t('allProjects')}</span>
            </button>
            {folders.map((folder) => (
              <div
                key={folder.id}
                className={`flex h-[54px] items-center rounded-md border text-sm font-semibold transition ${
                  activeFolderId === folder.id
                    ? 'border-violet-200/28 bg-[#686970] text-white shadow-[0_8px_22px_rgba(0,0,0,0.14)]'
                    : 'border-white/[0.075] bg-[#303136] text-white/82 hover:border-white/18 hover:bg-[#383941]'
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

        <section className="mt-11">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-[19px] font-medium tracking-[-0.01em] text-white/88">{t('projects')}</h2>
            {visibleProjects.length > 0 && (
              <SortDropdown value={sortMode} onChange={setSortMode} />
            )}
          </div>
          {visibleProjects.length > 0 && (
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
