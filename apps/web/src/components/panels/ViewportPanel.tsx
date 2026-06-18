import { useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { captureColor } from '@/engine/capture/captureColor';
import { captureDepth } from '@/engine/capture/captureDepth';
import { captureMask } from '@/engine/capture/captureMask';
import { captureNormal } from '@/engine/capture/captureNormal';
import { mockCameraSnapshot } from '@/engine/capture/captureTypes';
import { useSceneStore } from '@/stores/sceneStore';
import type { DisplayMode, ProjectionMode } from '@/types/model';

export function ViewportPanel() {
  const [captureStatus, setCaptureStatus] = useState('Ready');
  const displayMode = useSceneStore((state) => state.displayMode);
  const projectionMode = useSceneStore((state) => state.projectionMode);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setDisplayMode = useSceneStore((state) => state.setDisplayMode);
  const setProjectionMode = useSceneStore((state) => state.setProjectionMode);

  async function handleCapture() {
    setCaptureStatus('Capturing...');
    const request = {
      objectId: selectedObjectId ?? 'object-demo-capsule',
      width: 1024,
      height: 1024,
      camera: mockCameraSnapshot,
    };
    await Promise.all([
      captureColor(request),
      captureMask(request),
      captureDepth(request),
      captureNormal(request),
    ]);
    setCaptureStatus('Captured mock color / mask / depth / normal');
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
        <Button className="w-full" icon={<ScanLine className="h-4 w-4" />}>
          Quick Mask
        </Button>
      </div>
    </Panel>
  );
}
