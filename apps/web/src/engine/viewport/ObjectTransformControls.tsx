import { TransformControls } from '@react-three/drei';
import { syncImportedModelTransform } from '@/engine/scene/transformActions';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useSceneStore } from '@/stores/sceneStore';

export function ObjectTransformControls() {
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const transformMode = useSceneStore((state) => state.transformMode);
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const captureHistory = useEditorHistoryStore((state) => state.capture);

  if (!importedModel || selectedObjectId !== importedModel.objectId || transformMode === 'select') {
    return null;
  }

  return (
    <TransformControls
      object={importedModel.group}
      mode={transformMode}
      size={0.9}
      onMouseDown={() => {
        captureHistory();
        setOrbitControlsEnabled(false);
      }}
      onMouseUp={() => {
        setOrbitControlsEnabled(true);
        syncImportedModelTransform();
      }}
      onObjectChange={() => syncImportedModelTransform()}
    />
  );
}
