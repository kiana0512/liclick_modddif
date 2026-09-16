import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TextureRuntimeBoundary } from './components/runtime/TextureRuntimeBoundary';
import { EngineSessionBoundary } from './engine/session/EngineSessionBoundary';
import { resolveBakeEntryProject } from './features/workflow/resolveBakeEntryProject';
import { nextRetainedTextureProjectId } from './features/workflow/persistentTextureEditor';
import { ToastHost } from './components/common/ToastHost';
import { getAuthMe, getProviderStatus } from './services/authApiClient';
import { createProject, listProjects, loadProject } from './services/workspaceApiClient';
import { useAuthStore } from './stores/authStore';
import { useProjectStore } from './stores/projectStore';
import type { Project, TextureBakeHandoff } from './types/project';

type RouteState =
  | { name: 'home' }
  | { name: 'projects'; module: 'texture' | 'bake' }
  | { name: 'modelingToolbox' }
  | { name: 'performanceLabAdmin' }
  | { name: 'autoRetopology'; projectId?: string }
  | { name: 'autoUv'; projectId?: string }
  | {
      name: 'editor';
      projectId: string;
      showOnboarding?: boolean;
      continueToBake?: boolean;
      bakeHandoff?: TextureBakeHandoff;
    }
  | { name: 'bake'; projectId: string; handoff?: TextureBakeHandoff };

const HomePage = lazy(() =>
  import('./routes/HomePage').then((module) => ({ default: module.HomePage })),
);
const AppAuthGate = lazy(() =>
  import('./components/auth/AppAuthGate').then((module) => ({ default: module.AppAuthGate })),
);
const ProjectsPage = lazy(() =>
  import('./routes/ProjectsPage').then((module) => ({ default: module.ProjectsPage })),
);
const ModelingToolboxPage = lazy(() =>
  import('./routes/ModelingToolboxPage').then((module) => ({
    default: module.ModelingToolboxPage,
  })),
);
const AutoRetopologyPage = lazy(() =>
  import('./routes/AssetProcessingPage').then((module) => ({
    default: module.AutoRetopologyPage,
  })),
);
const AutoUvPage = lazy(() =>
  import('./routes/AssetProcessingPage').then((module) => ({
    default: module.AutoUvPage,
  })),
);
const EditorPage = lazy(() =>
  import('./routes/EditorPage').then((module) => ({ default: module.EditorPage })),
);
const PerformanceLabCloudBridge = lazy(() =>
  import('./features/performanceLab/PerformanceLabCloudBridge').then((module) => ({
    default: module.PerformanceLabCloudBridge,
  })),
);
const PerformanceLabAdminPage = lazy(() =>
  import('./routes/PerformanceLabAdminPage').then((module) => ({
    default: module.PerformanceLabAdminPage,
  })),
);
const BakeWorkspacePage = lazy(() =>
  import('./routes/BakeWorkspacePage').then((module) => ({ default: module.BakeWorkspacePage })),
);

function AppRouteFallback() {
  return (
    <main className="liclick-surface flex min-h-screen items-center justify-center text-sm text-white/58">
      Loading LIclick 3D Texture...
    </main>
  );
}

function OptionalEngineSessionBoundary({
  projectId,
  children,
}: {
  projectId?: string;
  children: ReactNode;
}) {
  return projectId ? (
    <EngineSessionBoundary projectId={projectId}>{children}</EngineSessionBoundary>
  ) : (
    children
  );
}

function appBasePath() {
  const normalized = `/${(import.meta.env.BASE_URL ?? '/').split('/').filter(Boolean).join('/')}`;
  if (normalized !== '/') return normalized;
  // A100 historically exposes the same SPA both at `/` and `/li3d`. Keep the
  // alias stable for direct bookmarks instead of normalizing an admin link
  // back to the home route.
  if (
    typeof window !== 'undefined' &&
    (window.location.pathname === '/li3d' || window.location.pathname.startsWith('/li3d/'))
  ) {
    return '/li3d';
  }
  return '';
}

function stripAppBasePath(pathname: string) {
  const base = appBasePath();
  if (!base || pathname === base) return pathname;
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

function routeFromPath(pathname: string): RouteState {
  const segments = stripAppBasePath(pathname).split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'performance-lab-admin') return { name: 'performanceLabAdmin' };
  if (segments[0] === 'texture') {
    if (segments[1] === 'project' && segments[2]) return { name: 'editor', projectId: segments[2] };
    return { name: 'projects', module: 'texture' };
  }
  if (segments[0] === 'baking') {
    if (segments[1] === 'project' && segments[2]) return { name: 'bake', projectId: segments[2] };
    return { name: 'projects', module: 'bake' };
  }
  if (segments[0] === 'projects') {
    if (segments[1] === 'bake') {
      const projectId = useProjectStore.getState().getCurrentProject()?.id;
      return projectId ? { name: 'bake', projectId } : { name: 'home' };
    }
    return { name: 'projects', module: segments[1] === 'bake' ? 'bake' : 'texture' };
  }
  if (segments[0] === 'tools' || segments[0] === 'toolbox') {
    return { name: 'modelingToolbox' };
  }
  if (segments[0] === 'retopology') {
    return { name: 'autoRetopology' };
  }
  if (segments[0] === 'uv') {
    return { name: 'autoUv' };
  }
  if (segments[0] === 'project' && segments[1]) {
    if (segments[2] === 'texture') return { name: 'editor', projectId: segments[1] };
    if (segments[2] === 'retopology') return { name: 'autoRetopology', projectId: segments[1] };
    if (segments[2] === 'uv') return { name: 'autoUv', projectId: segments[1] };
    if (segments[2] === 'bake') return { name: 'bake', projectId: segments[1] };
    // Delivery was removed. Keep old bookmarks useful by redirecting them to baking.
    if (segments[2] === 'delivery') return { name: 'bake', projectId: segments[1] };
    return { name: 'editor', projectId: segments[1] };
  }
  return { name: 'home' };
}

function pathFromRoute(route: RouteState) {
  let path: string;
  if (route.name === 'home') path = '/';
  else if (route.name === 'projects') path = route.module === 'texture' ? '/texture' : '/baking';
  else if (route.name === 'modelingToolbox') path = '/tools';
  else if (route.name === 'performanceLabAdmin') path = '/performance-lab-admin';
  else if (route.name === 'autoRetopology') path = route.projectId
    ? `/project/${encodeURIComponent(route.projectId)}/retopology`
    : '/retopology';
  else if (route.name === 'autoUv') path = route.projectId
    ? `/project/${encodeURIComponent(route.projectId)}/uv`
    : '/uv';
  else if (route.name === 'editor') path = `/project/${encodeURIComponent(route.projectId)}/texture`;
  else path = `/project/${encodeURIComponent(route.projectId)}/bake`;
  return `${appBasePath()}${path}`;
}

function pathFromRouteWithDiagnostics(route: RouteState) {
  const path = pathFromRoute(route);
  const current = new URLSearchParams(window.location.search);
  const diagnostics = new URLSearchParams();
  for (const key of [
    'perfLab',
    'perfOrbit',
    'perfWebGpuAb',
    'perfWebGpuChunkMb',
    'previewUploadGovernor',
    'webGpuUv',
  ]) {
    const value = current.get(key);
    if (value !== null) diagnostics.set(key, value);
  }
  const query = diagnostics.toString();
  return query ? `${path}?${query}` : path;
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => routeFromPath(window.location.pathname));
  const performanceLabEnabled =
    import.meta.env.VITE_LICLICK_PERFORMANCE_LAB_ENABLED === 'true' &&
    new URLSearchParams(window.location.search).get('perfLab') === '1';
  const navigationRevisionRef = useRef(0);
  const entryProjectPromiseRef = useRef<Promise<Project | undefined> | null>(null);
  const residentTextureProjectIdRef = useRef<string>();
  residentTextureProjectIdRef.current = nextRetainedTextureProjectId(
    residentTextureProjectIdRef.current,
    route,
  );
  const preserveTextureWorkspace = Boolean(
    route.name !== 'editor' && residentTextureProjectIdRef.current,
  );
  const setChecking = useAuthStore((state) => state.setChecking);
  const authStatus = useAuthStore((state) => state.status);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const refreshLocalSettings = useAuthStore((state) => state.refreshLocalSettings);

  const navigation = useMemo(
    () => {
      function commitRoute(nextRoute: RouteState) {
        window.history.pushState(nextRoute, '', pathFromRouteWithDiagnostics(nextRoute));
        setRoute(nextRoute);
      }

      function navigate(nextRoute: RouteState) {
        navigationRevisionRef.current += 1;
        commitRoute(nextRoute);
      }

      function bakeDestination(
        project: Project,
        handoff?: TextureBakeHandoff,
      ): RouteState {
        return { name: 'bake', projectId: project.id, handoff };
      }

      function openCurrentProjectStage(stage: 'texture' | 'bake') {
        const requestRevision = ++navigationRevisionRef.current;
        const projectStore = useProjectStore.getState();
        const currentProject = projectStore.getCurrentProject();
        const destination = (project: Project): RouteState =>
          stage === 'texture'
            ? { name: 'editor', projectId: project.id }
            : bakeDestination(project);

        if (currentProject) {
          commitRoute(destination(currentProject));
          return;
        }

        let pendingProject = entryProjectPromiseRef.current;
        if (!pendingProject) {
          pendingProject = resolveBakeEntryProject(undefined, { listProjects, loadProject }).then(
            async (project) => project ?? (await createProject({ name: '未命名项目' })).project,
          );
          entryProjectPromiseRef.current = pendingProject;
          void pendingProject
            .finally(() => {
              if (entryProjectPromiseRef.current === pendingProject) {
                entryProjectPromiseRef.current = null;
              }
            })
            .catch(() => undefined);
        }

        void pendingProject
          .then((project) => {
            if (navigationRevisionRef.current !== requestRevision) return;
            if (!project) {
              commitRoute({ name: 'projects', module: stage });
              return;
            }
            useProjectStore.getState().replaceCurrentProject(project);
            commitRoute(destination(project));
          })
          .catch(() => {
            if (navigationRevisionRef.current !== requestRevision) return;
            commitRoute({ name: 'projects', module: stage });
          });
      }


      function openProjectBake(projectId: string, handoff?: TextureBakeHandoff) {
        const requestRevision = ++navigationRevisionRef.current;
        const cachedProject = useProjectStore
          .getState()
          .projects.find((project) => project.id === projectId);
        if (cachedProject) {
          commitRoute(bakeDestination(cachedProject, handoff));
          return;
        }
        void loadProject(projectId)
          .then(({ project }) => {
            if (navigationRevisionRef.current !== requestRevision) return;
            useProjectStore.getState().replaceCurrentProject(project);
            commitRoute(bakeDestination(project, handoff));
          })
          .catch(() => {
            if (navigationRevisionRef.current !== requestRevision) return;
            commitRoute({ name: 'projects', module: 'bake' });
          });
      }

      return {
        openHome: () => {
          const nextRoute: RouteState = { name: 'home' };
          navigate(nextRoute);
        },
        openTextureProjects: () => {
          const nextRoute: RouteState = { name: 'projects', module: 'texture' };
          navigate(nextRoute);
        },
        openCurrentTexture: () => openCurrentProjectStage('texture'),
        openCurrentBake: () => openCurrentProjectStage('bake'),
        openModelingToolbox: () => {
          const nextRoute: RouteState = { name: 'modelingToolbox' };
          navigate(nextRoute);
        },
        openAutoRetopology: (projectId?: string) => {
          const nextRoute: RouteState = { name: 'autoRetopology', projectId };
          navigate(nextRoute);
        },
        openAutoUv: (projectId?: string) => {
          const nextRoute: RouteState = { name: 'autoUv', projectId };
          navigate(nextRoute);
        },
        openEditor: (projectId: string, options?: { showOnboarding?: boolean }) => {
          const nextRoute: RouteState = {
            name: 'editor',
            projectId,
            showOnboarding: options?.showOnboarding,
          };
          navigate(nextRoute);
        },
        openBake: (projectId: string, handoff?: TextureBakeHandoff) => {
          openProjectBake(projectId, handoff);
        },
      };
    },
    [],
  );

  async function refreshAuth() {
    setChecking();
    const [me, providerStatus] = await Promise.all([getAuthMe(), getProviderStatus()]);
    if (me.authenticated && me.user) setAuthenticated(me.user, me.authMode, providerStatus);
    else setAnonymous(me.authMode, providerStatus);
  }

  useEffect(() => {
    void refreshAuth().catch(() => setAnonymous());
    // A status check can associate an existing authenticated browser session
    // with its random app IDs. It is non-blocking and never reads hardware data.
    void import('./services/identityApiClient')
      .then(({ getIdentityStatus }) => getIdentityStatus())
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void import('./services/telemetryClient').then(({ initializeTelemetry }) => {
      dispose = initializeTelemetry();
    });
    return () => dispose?.();
  }, []);

  useEffect(() => {
    const successIntervalMs = 60_000;
    const retryBaseMs = 30_000;
    const retryMaximumMs = 300_000;
    let disposed = false;
    let inFlight = false;
    let failureCount = 0;
    let nextRefreshAt = Date.now() + successIntervalMs;
    let timer: number | undefined;
    const schedule = (delayMs: number) => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      nextRefreshAt = Date.now() + delayMs;
      timer = window.setTimeout(refresh, delayMs);
    };
    const refresh = () => {
      if (disposed || inFlight || document.visibilityState !== 'visible') return;
      const remainingMs = nextRefreshAt - Date.now();
      if (remainingMs > 0) {
        schedule(remainingMs);
        return;
      }
      inFlight = true;
      void refreshLocalSettings()
        .then(() => {
          failureCount = 0;
          schedule(successIntervalMs);
        })
        .catch(() => {
          failureCount += 1;
          schedule(Math.min(retryMaximumMs, retryBaseMs * 2 ** (failureCount - 1)));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible' && Date.now() >= nextRefreshAt) refresh();
    };
    schedule(successIntervalMs);
    window.addEventListener('focus', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, [refreshLocalSettings]);

  useEffect(() => {
    const normalizedPath = pathFromRoute(route);
    if (window.location.pathname !== normalizedPath) {
      window.history.replaceState(route, '', pathFromRouteWithDiagnostics(route));
    }
    function handlePopState() {
      navigationRevisionRef.current += 1;
      setRoute(routeFromPath(window.location.pathname));
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
    // This effect installs browser navigation once. Route changes are pushed explicitly by navigation helpers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (authStatus !== 'authenticated') {
    return (
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <AppAuthGate />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  if (route.name === 'performanceLabAdmin') {
    return (
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <PerformanceLabAdminPage onBack={navigation.openHome} />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  if (route.name === 'editor' || preserveTextureWorkspace) {
    const textureProjectId =
      route.name === 'editor' ? route.projectId : residentTextureProjectIdRef.current!;
    const textureWorkspaceActive = route.name === 'editor';
    return (
      <EngineSessionBoundary projectId={textureProjectId}>
        <TextureRuntimeBoundary onBack={navigation.openHome}>
          <div
            className={
              textureWorkspaceActive
                ? 'h-screen'
                : 'pointer-events-none fixed inset-0 -z-10 h-screen w-screen opacity-0'
            }
            aria-hidden={!textureWorkspaceActive}
          >
            <Suspense fallback={<AppRouteFallback />}>
              <EditorPage
                projectId={textureProjectId}
                onBack={navigation.openTextureProjects}
                onOpenRetopology={() => navigation.openAutoRetopology(textureProjectId)}
                onOpenUv={() => navigation.openAutoUv(textureProjectId)}
                onOpenBake={(handoff) => navigation.openBake(textureProjectId, handoff)}
                autoOpenBake={route.name === 'editor' ? route.continueToBake : false}
                pendingBakeHandoff={route.name === 'editor' ? route.bakeHandoff : undefined}
                showOnboarding={route.name === 'editor' ? route.showOnboarding : false}
                isActive={textureWorkspaceActive}
              />
            </Suspense>
          </div>
          {textureWorkspaceActive && performanceLabEnabled ? (
            <Suspense fallback={null}>
              <PerformanceLabCloudBridge projectId={textureProjectId} />
            </Suspense>
          ) : null}
        </TextureRuntimeBoundary>
        {route.name === 'autoUv' ? (
          <Suspense fallback={<AppRouteFallback />}>
            <AutoUvPage
              projectId={route.projectId}
              onBack={navigation.openHome}
              onLogout={navigation.openHome}
              navigation={{
                activeModule: 'uv',
                onOpenTexture: () => navigation.openEditor(textureProjectId),
                onOpenRetopology: () => navigation.openAutoRetopology(route.projectId),
                onOpenUv: () => undefined,
                onOpenBake: () => navigation.openBake(textureProjectId),
              }}
              onContinue={(projectId, handoff) => navigation.openBake(projectId, handoff)}
            />
          </Suspense>
        ) : null}
        {route.name === 'autoRetopology' ? (
          <Suspense fallback={<AppRouteFallback />}>
            <AutoRetopologyPage
              projectId={route.projectId}
              onBack={navigation.openHome}
              onLogout={navigation.openHome}
              navigation={{
                activeModule: 'retopology',
                onOpenTexture: () => navigation.openEditor(textureProjectId),
                onOpenRetopology: () => undefined,
                onOpenUv: () => navigation.openAutoUv(textureProjectId),
                onOpenBake: () => navigation.openBake(textureProjectId),
              }}
              onContinue={(projectId) => navigation.openAutoUv(projectId)}
            />
          </Suspense>
        ) : null}
        {route.name === 'bake' ? (
          <Suspense fallback={<AppRouteFallback />}>
            <BakeWorkspacePage
              projectId={route.projectId}
              onBack={navigation.openHome}
              onOpenTexture={() => navigation.openEditor(textureProjectId)}
              onOpenRetopology={() => navigation.openAutoRetopology(textureProjectId)}
              onOpenUv={() => navigation.openAutoUv(textureProjectId)}
              handoff={route.handoff}
            />
          </Suspense>
        ) : null}
        <ToastHost />
      </EngineSessionBoundary>
    );
  }

  if (route.name === 'bake') {
    return (
      <EngineSessionBoundary projectId={route.projectId}>
        <Suspense fallback={<AppRouteFallback />}>
          <BakeWorkspacePage
            projectId={route.projectId}
            onBack={navigation.openHome}
            onOpenTexture={() => navigation.openEditor(route.projectId)}
            onOpenRetopology={() => navigation.openAutoRetopology(route.projectId)}
            onOpenUv={() => navigation.openAutoUv(route.projectId)}
            handoff={route.handoff}
          />
        </Suspense>
        <ToastHost />
      </EngineSessionBoundary>
    );
  }

  if (route.name === 'projects') {
    const openProject = (projectId: string, options?: { showOnboarding?: boolean }) => {
      if (route.module === 'texture') navigation.openEditor(projectId, options);
      else navigation.openBake(projectId);
    };
    const page = (
      <Suspense fallback={<AppRouteFallback />}>
        <ProjectsPage
          module={route.module}
          onBack={navigation.openHome}
          onOpenProject={openProject}
          onLogout={navigation.openHome}
        />
      </Suspense>
    );
    return (
      <>
        {route.module === 'texture' ? (
          <TextureRuntimeBoundary onBack={navigation.openHome}>
            {page}
          </TextureRuntimeBoundary>
        ) : (
          page
        )}
        <ToastHost />
      </>
    );
  }

  if (route.name === 'modelingToolbox') {
    return (
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <ModelingToolboxPage onBack={navigation.openHome} onLogout={navigation.openHome} />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  if (route.name === 'autoRetopology') {
    return (
      <OptionalEngineSessionBoundary projectId={route.projectId}>
        <Suspense fallback={<AppRouteFallback />}>
          <AutoRetopologyPage
            projectId={route.projectId}
            onBack={navigation.openHome}
            onLogout={navigation.openHome}
            navigation={{
              activeModule: 'retopology',
              onOpenTexture: route.projectId
                ? () => navigation.openEditor(route.projectId!)
                : navigation.openCurrentTexture,
              onOpenRetopology: () => undefined,
              onOpenUv: () => navigation.openAutoUv(route.projectId),
              onOpenBake: route.projectId
                ? () => navigation.openBake(route.projectId!)
                : navigation.openCurrentBake,
            }}
            onContinue={(projectId) => navigation.openAutoUv(projectId)}
          />
        </Suspense>
        <ToastHost />
      </OptionalEngineSessionBoundary>
    );
  }

  if (route.name === 'autoUv') {
    return (
      <OptionalEngineSessionBoundary projectId={route.projectId}>
        <Suspense fallback={<AppRouteFallback />}>
          <AutoUvPage
            projectId={route.projectId}
            onBack={navigation.openHome}
            onLogout={navigation.openHome}
            navigation={{
              activeModule: 'uv',
              onOpenTexture: route.projectId
                ? () => navigation.openEditor(route.projectId!)
                : navigation.openCurrentTexture,
              onOpenRetopology: () => navigation.openAutoRetopology(route.projectId),
              onOpenUv: () => undefined,
              onOpenBake: route.projectId
                ? () => navigation.openBake(route.projectId!)
                : navigation.openCurrentBake,
            }}
            onContinue={(projectId, handoff) => navigation.openBake(projectId, handoff)}
          />
        </Suspense>
        <ToastHost />
      </OptionalEngineSessionBoundary>
    );
  }

  return (
    <>
      <Suspense fallback={<AppRouteFallback />}>
        <HomePage
          onOpenTexture={navigation.openTextureProjects}
          onOpenBake={navigation.openCurrentBake}
          onOpenToolbox={navigation.openModelingToolbox}
          onOpenUv={navigation.openAutoUv}
          onLogout={navigation.openHome}
        />
      </Suspense>
      <ToastHost />
    </>
  );
}
