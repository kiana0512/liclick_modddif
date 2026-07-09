import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ToastHost } from './components/common/ToastHost';
import { getAuthMe, getProviderStatus } from './services/authApiClient';
import { useAuthStore } from './stores/authStore';

type RouteState = { name: 'projects' } | { name: 'editor'; projectId: string };

const ProjectsPage = lazy(() => import('./routes/ProjectsPage').then((module) => ({ default: module.ProjectsPage })));
const EditorPage = lazy(() => import('./routes/EditorPage').then((module) => ({ default: module.EditorPage })));

function AppRouteFallback() {
  return (
    <main className="liclick-surface flex min-h-screen items-center justify-center text-sm text-white/58">
      Loading Liclick 3D Texture...
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
  if (segments[0] === 'project' && segments[1]) return { name: 'editor', projectId: segments[1] };
  return { name: 'projects' };
}

function pathFromRoute(route: RouteState) {
  const path = route.name === 'editor' ? `/project/${encodeURIComponent(route.projectId)}` : '/projects';
  return `${appBasePath()}${path}`;
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => routeFromPath(window.location.pathname));
  const setChecking = useAuthStore((state) => state.setChecking);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);

  const navigation = useMemo(
    () => ({
      openProjects: () => {
        const nextRoute: RouteState = { name: 'projects' };
        window.history.pushState(nextRoute, '', pathFromRoute(nextRoute));
        setRoute(nextRoute);
      },
      openEditor: (projectId: string) => {
        const nextRoute: RouteState = { name: 'editor', projectId };
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
          <EditorPage projectId={route.projectId} onBack={navigation.openProjects} />
        </Suspense>
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<AppRouteFallback />}>
        <ProjectsPage onOpenProject={navigation.openEditor} onLogout={navigation.openProjects} />
      </Suspense>
      <ToastHost />
    </>
  );
}
