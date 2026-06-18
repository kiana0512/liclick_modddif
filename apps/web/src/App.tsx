import { useMemo, useState } from 'react';
import { EditorPage } from './routes/EditorPage';
import { ProjectsPage } from './routes/ProjectsPage';

type RouteState = { name: 'projects' } | { name: 'editor'; projectId: string };

export function App() {
  const [route, setRoute] = useState<RouteState>({ name: 'projects' });

  const navigation = useMemo(
    () => ({
      openProjects: () => setRoute({ name: 'projects' }),
      openEditor: (projectId: string) => setRoute({ name: 'editor', projectId }),
    }),
    [],
  );

  if (route.name === 'editor') {
    return <EditorPage projectId={route.projectId} onBack={navigation.openProjects} />;
  }

  return <ProjectsPage onOpenProject={navigation.openEditor} />;
}
