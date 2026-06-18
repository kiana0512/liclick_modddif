import { useEffect } from 'react';
import { GeneratePanel } from '@/components/panels/GeneratePanel';
import { LayerAdjustmentsPanel } from '@/components/panels/LayerAdjustmentsPanel';
import { LayersPanel } from '@/components/panels/LayersPanel';
import { ObjectsPanel } from '@/components/panels/ObjectsPanel';
import { ReferenceImagesPanel } from '@/components/panels/ReferenceImagesPanel';
import { ViewportPanel } from '@/components/panels/ViewportPanel';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { EditorShell } from '@/layouts/EditorShell';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
};

export function EditorPage({ projectId, onBack }: EditorPageProps) {
  const projects = useProjectStore((state) => state.projects);
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject);
  const setObjects = useSceneStore((state) => state.setObjects);
  const setLayers = useLayerStore((state) => state.setLayers);
  const project = projects.find((item) => item.id === projectId) ?? projects[0];

  useEffect(() => {
    if (!project) return;
    setCurrentProject(project.id);
    setObjects(project.objects);
    setLayers(project.layers);
  }, [project, setCurrentProject, setLayers, setObjects]);

  return (
    <EditorShell
      projectName={project?.name ?? 'Untitled Project'}
      onBack={onBack}
      left={
        <>
          <ObjectsPanel />
          <GeneratePanel />
          <ReferenceImagesPanel />
        </>
      }
      center={<ViewportCanvas />}
      right={
        <>
          <ViewportPanel />
          <LayersPanel />
          <LayerAdjustmentsPanel />
        </>
      }
    />
  );
}
