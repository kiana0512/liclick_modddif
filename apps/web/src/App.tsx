import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ToastHost } from './components/common/ToastHost';
import { getAuthMe, getProviderStatus } from './services/authApiClient';
import { useAuthStore } from './stores/authStore';
import { useProjectStore } from './stores/projectStore';
import type { TextureBakeHandoff } from './types/project';

type RouteState =
  | { name: 'home' }
  | { name: 'projects'; module: 'texture' | 'bake' }
  | { name: 'modelingToolbox' }
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
  if (segments[0] === 'projects') {
    if (segments[1] === 'bake') {
      const projectId = useProjectStore.getState().getCurrentProject()?.id;
      return projectId ? { name: 'bake', projectId } : { name: 'home' };
    }
    return { name: 'projects', module: segments[1] === 'bake' ? 'bake' : 'texture' };
  }
  if (segments[0] === 'toolbox') {
    return { name: 'modelingToolbox' };
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
  else if (route.name === 'projects') path = `/projects/${route.module}`;
  else if (route.name === 'modelingToolbox') path = '/toolbox/modeling';
  else if (route.name === 'editor') path = `/project/${encodeURIComponent(route.projectId)}`;
  else path = `/project/${encodeURIComponent(route.projectId)}/${route.name}`;
  return `${appBasePath()}${path}`;
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => routeFromPath(window.location.pathname));
  const setChecking = useAuthStore((state) => state.setChecking);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);
  const refreshLocalSettings = useAuthStore((state) => state.refreshLocalSettings);

  const navigation = useMemo(
    () => ({
      openHome: () => {
        const nextRoute: RouteState = { name: 'home' };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
      openTextureProjects: () => {
        const nextRoute: RouteState = { name: 'projects', module: 'texture' };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
      openCurrentBake: () => {
        const projectId = useProjectStore.getState().getCurrentProject()?.id;
        const nextRoute: RouteState = projectId ? { name: 'bake', projectId } : { name: 'home' };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
      openModelingToolbox: () => {
        const nextRoute: RouteState = { name: 'modelingToolbox' };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
      openEditor: (projectId: string) => {
        const nextRoute: RouteState = { name: 'editor', projectId };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
      openBake: (projectId: string, handoff?: TextureBakeHandoff) => {
        const nextRoute: RouteState = { name: 'bake', projectId, handoff };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
    }),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <Suspense fallback={<AppRouteFallback />}>
          <EditorPage
            projectId={route.projectId}
            onBack={navigation.openTextureProjects}
            onOpenBake={(handoff) => navigation.openBake(route.projectId, handoff)}
          />
        </Suspense>
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
    return (
      <>
        <Suspense fallback={<AppRouteFallback />}>
          <ProjectsPage
            module={route.module}
            onBack={navigation.openHome}
            onOpenProject={openProject}
            onLogout={navigation.openHome}
          />
        </Suspense>
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

  return (
    <>
      <Suspense fallback={<AppRouteFallback />}>
        <HomePage
          onOpenTexture={navigation.openTextureProjects}
          onOpenBake={navigation.openCurrentBake}
          onOpenToolbox={navigation.openModelingToolbox}
          onLogout={navigation.openHome}
        />
      </Suspense>
      <ToastHost />
    </>
  );
}
