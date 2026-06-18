import { useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
import { runComingSoonCommand } from '@/features/commandRegistry';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useGenerationStore } from '@/stores/generationStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { DisplayMode, ProjectionMode } from '@/types/model';

const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
} as const;

export function ViewportPanel() {
  const [captureStatus, setCaptureStatus] = useState('Ready');
  const displayMode = useSceneStore((state) => state.displayMode);
  const projectionMode = useSceneStore((state) => state.projectionMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const importedModel = useSceneStore((state) => state.importedModel);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);
  const setProjectionMode = useSceneStore((state) => state.setProjectionMode);
  const resolution = useSettingsStore((state) => state.resolution);
  const setLastCapture = useGenerationStore((state) => state.setLastCapture);
  const pushToast = useToastStore((state) => state.pushToast);

  async function handleCapture() {
    if (!importedModel) {
      pushToast({
        tone: 'warning',
        title: 'Please import a model first.',
        description: 'Capture needs a selected model object.',
      });
      return;
    }
    const objectId = selectedObjectId ?? importedModel.objectId;

    try {
      setCaptureStatus('Capturing...');
      const capture = await captureCurrentView({
        objectId,
        resolution: resolutionToSize[resolution],
      });
      setLastCapture(capture);
      setCaptureStatus(`Captured ${capture.width}px color / mask / depth / normal`);
      pushToast({
        tone: capture.warnings.length > 0 ? 'warning' : 'success',
        title: 'Capture complete',
        description: capture.warnings[0] ?? 'Current viewport was captured for generation and projection.',
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Capture failed:', error);
      setCaptureStatus('Failed');
      pushToast({
        tone: 'error',
        title: 'Capture failed',
        description: error instanceof Error ? error.message : 'Could not capture the current view.',
      });
    }
  }

  return (
    <Panel title="Viewport">
      <div className="space-y-3">
        <SegmentedControl<DisplayMode>
          value={displayMode}
          options={[
            { value: 'pbr', label: 'PBR' },
            { value: 'flat', label: 'Flat' },
            { value: 'normal', label: 'Normal' },
            { value: 'wire', label: 'Wire' },
          ]}
          onChange={setDisplayMode}
        />
        {displayMode === 'normal' && (
          <div className="rounded-md border border-sky-300/15 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-100/80">
            Normal preview mode: colors visualize surface normals, not final texture.
          </div>
        )}
        <SegmentedControl<ProjectionMode>
          value={projectionMode}
          options={[
            { value: 'perspective', label: 'Perspective' },
            { value: 'orthographic', label: 'Orthographic' },
          ]}
          onChange={setProjectionMode}
        />
        <Button className="w-full" icon={<Camera className="h-4 w-4" />} onClick={handleCapture}>
          Capture Current View
        </Button>
        <div className="rounded-md bg-white/[0.045] px-3 py-2 text-xs text-white/48">{captureStatus}</div>
        <Button
          className="w-full"
          icon={<ScanLine className="h-4 w-4" />}
          onClick={() => runComingSoonCommand('quickMask')}
        >
          Quick Mask
        </Button>
      </div>
    </Panel>
  );
}
