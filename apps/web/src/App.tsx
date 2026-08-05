import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { TextureRuntimeGate } from './components/runtime/TextureRuntimeGate';
import { resolveBakeEntryProject } from './features/workflow/resolveBakeEntryProject';
import { useLocalTextureRuntime } from './hooks/useLocalTextureRuntime';
import { ToastHost } from './components/common/ToastHost';
import { getAuthMe, getProviderStatus } from './services/authApiClient';
import { getIdentityStatus } from './services/identityApiClient';
import { initializeTelemetry } from './services/telemetryClient';
import { listProjects, loadProject } from './services/workspaceApiClient';
import { useAuthStore } from './stores/authStore';
import { useProjectStore } from './stores/projectStore';
import type { Project, TextureBakeHandoff } from './types/project';

type RouteState =
  | { name: 'home' }
  | { name: 'projects'; module: 'texture' | 'bake' }
  | { name: 'modelingToolbox' }
  | { name: 'autoRetopology' }
  | { name: 'autoUv' }
  | { name: 'editor'; projectId: string }
  | { name: 'bake'; projectId: string; handoff?: TextureBakeHandoff };

const HomePage = lazy(() =>
  import('./routes/HomePage').then((module) => ({ default: module.HomePage })),
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

function appBasePath() {
  const normalized = `/${(import.meta.env.BASE_URL ?? '/').split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '' : normalized;
}

function stripAppBasePath(pathname: string) {
  const base = appBasePath();
  if (!base || pathname === base) return pathname;
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

function routeFromPath(pathname: string): RouteState {
  const segments = stripAppBasePath(pathname).split('/').filter(Boolean).map(decodeURIComponent);
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
  else if (route.name === 'autoRetopology') path = '/retopology';
  else if (route.name === 'autoUv') path = '/uv';
  else if (route.name === 'editor') path = `/texture/project/${encodeURIComponent(route.projectId)}`;
  else path = `/baking/project/${encodeURIComponent(route.projectId)}`;
  return `${appBasePath()}${path}`;
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => routeFromPath(window.location.pathname));
  const navigationRevisionRef = useRef(0);
  const bakeEntryProjectPromiseRef = useRef<Promise<Project | undefined> | null>(null);
  const textureRouteActive =
    route.name === 'editor' || (route.name === 'projects' && route.module === 'texture');
  const localTextureRuntime = useLocalTextureRuntime(textureRouteActive);
  const setChecking = useAuthStore((state) => state.setChecking);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const refreshLocalSettings = useAuthStore((state) => state.refreshLocalSettings);

  const navigation = useMemo(
    () => {
      function commitRoute(nextRoute: RouteState) {
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      }

      function navigate(nextRoute: RouteState) {
        navigationRevisionRef.current += 1;
        commitRoute(nextRoute);
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
        openCurrentBake: () => {
          const requestRevision = ++navigationRevisionRef.current;
          const projectStore = useProjectStore.getState();
          const currentProject = projectStore.getCurrentProject();

          if (currentProject) {
            commitRoute({ name: 'bake', projectId: currentProject.id });
            return;
          }

          let pendingProject = bakeEntryProjectPromiseRef.current;
          if (!pendingProject) {
            pendingProject = resolveBakeEntryProject(undefined, { listProjects, loadProject });
            bakeEntryProjectPromiseRef.current = pendingProject;
            void pendingProject
              .finally(() => {
                if (bakeEntryProjectPromiseRef.current === pendingProject) {
                  bakeEntryProjectPromiseRef.current = null;
                }
              })
              .catch(() => undefined);
          }

          void pendingProject
            .then((project) => {
              if (navigationRevisionRef.current !== requestRevision) return;
              if (!project) {
                commitRoute({ name: 'projects', module: 'bake' });
                return;
              }
              useProjectStore.getState().replaceCurrentProject(project);
              commitRoute({ name: 'bake', projectId: project.id });
            })
            .catch(() => {
              if (navigationRevisionRef.current !== requestRevision) return;
              commitRoute({ name: 'projects', module: 'bake' });
            });
        },
        openModelingToolbox: () => {
          const nextRoute: RouteState = { name: 'modelingToolbox' };
          navigate(nextRoute);
        },
        openAutoRetopology: () => {
          const nextRoute: RouteState = { name: 'autoRetopology' };
          navigate(nextRoute);
        },
        openAutoUv: () => {
          const nextRoute: RouteState = { name: 'autoUv' };
          navigate(nextRoute);
        },
        openEditor: (projectId: string) => {
          const nextRoute: RouteState = { name: 'editor', projectId };
          navigate(nextRoute);
        },
        openBake: (projectId: string, handoff?: TextureBakeHandoff) => {
          const nextRoute: RouteState = { name: 'bake', projectId, handoff };
          navigate(nextRoute);
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
    void getIdentityStatus().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => initializeTelemetry(), []);

  useEffect(() => {
    const refresh = () => void refreshLocalSettings().catch(() => undefined);
    const timer = window.setInterval(refresh, 3_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refreshLocalSettings]);

  useEffect(() => {
    const normalizedPath = pathFromRoute(route);
    if (window.location.pathname !== normalizedPath) {
      window.history.replaceState(route, '', normalizedPath);
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

  if (route.name === 'editor') {
    return (
      <>
        <TextureRuntimeGate
          state={localTextureRuntime.state}
          onRetry={() => void localTextureRuntime.refresh()}
          onBack={navigation.openHome}
        >
          <Suspense fallback={<AppRouteFallback />}>
            <EditorPage
              projectId={route.projectId}
              onBack={navigation.openTextureProjects}
              onOpenBake={(handoff) => navigation.openBake(route.projectId, handoff)}
            />
          </Suspense>
        </TextureRuntimeGate>
        <ToastHost />
      </>
    );
  }

  if (route.name === 'bake') {
    return (
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <BakeWorkspacePage
            projectId={route.projectId}
            onBack={navigation.openHome}
            onOpenTexture={() => navigation.openEditor(route.projectId)}
            handoff={route.handoff}
          />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  if (route.name === 'projects') {
    const openProject = route.module === 'texture' ? navigation.openEditor : navigation.openBake;
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
          <TextureRuntimeGate
            state={localTextureRuntime.state}
            onRetry={() => void localTextureRuntime.refresh()}
            onBack={navigation.openHome}
          >
            {page}
          </TextureRuntimeGate>
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
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <AutoRetopologyPage onBack={navigation.openHome} onLogout={navigation.openHome} />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  if (route.name === 'autoUv') {
    return (
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <AutoUvPage onBack={navigation.openHome} onLogout={navigation.openHome} />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<AppRouteFallback />}>
        <HomePage
          onOpenTexture={navigation.openTextureProjects}
          onOpenBake={navigation.openCurrentBake}
          onOpenToolbox={navigation.openModelingToolbox}
          onOpenRetopology={navigation.openAutoRetopology}
          onOpenUv={navigation.openAutoUv}
          onLogout={navigation.openHome}
        />
      </Suspense>
      <ToastHost />
    </>
  );
}
