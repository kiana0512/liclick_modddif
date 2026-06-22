import { useEffect, useMemo, useState } from 'react';
import { ToastHost } from './components/common/ToastHost';
import { EditorPage } from './routes/EditorPage';
import { ProjectsPage } from './routes/ProjectsPage';
import { getAuthMe, getProviderStatus } from './services/authApiClient';
import { useAuthStore } from './stores/authStore';

type RouteState = { name: 'projects' } | { name: 'editor'; projectId: string };

export function App() {
  const [route, setRoute] = useState<RouteState>({ name: 'projects' });
  const setChecking = useAuthStore((state) => state.setChecking);
  const setAnonymous = useAuthStore((state) => state.setAnonymous);
  const setAuthenticated = useAuthStore((state) => state.setAuthenticated);

  const navigation = useMemo(
    () => ({
      openProjects: () => setRoute({ name: 'projects' }),
      openEditor: (projectId: string) => setRoute({ name: 'editor', projectId }),
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

  if (route.name === 'editor') {
    return (
      <>
        <EditorPage projectId={route.projectId} onBack={navigation.openProjects} />
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <ProjectsPage onOpenProject={navigation.openEditor} onLogout={navigation.openProjects} />
      <ToastHost />
    </>
  );
}
