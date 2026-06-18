import { useState } from 'react';
import { Image, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
import { generateTextureMock } from '@/services/mockGenerationService';
import { useGenerationStore } from '@/stores/generationStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';

type GenerateTab = 'single' | 'multiview';

const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
} as const;

export function GeneratePanel() {
  const [tab, setTab] = useState<GenerateTab>('single');
  const [prompt, setPrompt] = useState('soft pink-purple ceramic texture with clean highlights');
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [upscale, setUpscale] = useState(false);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const references = useReferenceStore((state) => state.references);
  const { currentGeneration, lastCapture, isGenerating, start, finish, addGeneration, setLastCapture } =
    useGenerationStore();
  const addProjectGeneration = useProjectStore((state) => state.addGeneration);
  const addProjectedLayerFromGeneration = useLayerStore((state) => state.addProjectedLayerFromGeneration);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const objects = useSceneStore((state) => state.objects);
  const importedModel = useSceneStore((state) => state.importedModel);
  const resolution = useSettingsStore((state) => state.resolution);
  const pushToast = useToastStore((state) => state.pushToast);

  async function ensureCapture() {
    if (!importedModel) throw new Error('Please import a model first.');
    const objectId = selectedObjectId ?? importedModel.objectId;
    if (lastCapture?.objectId === objectId) return lastCapture;

    const capture = await captureCurrentView({
      objectId,
      resolution: resolutionToSize[resolution],
    });
    setLastCapture(capture);
    return capture;
  }

  async function handleGenerate() {
    try {
      start();
      const capture = await ensureCapture();
      const object = objects.find((item) => item.id === capture.objectId);
      const generation = await generateTextureMock({
        mode: 'single',
        prompt,
        referenceIds: selectedReferenceIds,
        referenceImages: references.filter((reference) => selectedReferenceIds.includes(reference.id)),
        capture,
        object,
        resolution,
        textureMode: 'realistic',
        visibleOnly,
        upscale,
      });
      addGeneration(generation);
      addProjectGeneration(generation);
      pushToast({
        tone: 'success',
        title: 'Image generated',
        description: 'Mock generation is linked to the latest real capture.',
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Generate failed:', error);
      finish();
      pushToast({
        tone: 'error',
        title: 'Generate failed',
        description: error instanceof Error ? error.message : 'Could not generate a texture image.',
      });
    }
  }

  function handleAddProjectedLayer() {
    if (!currentGeneration?.resultUrl) return;
    const layer = addProjectedLayerFromGeneration(currentGeneration, lastCapture, selectedObjectId);
    pushToast({
      tone: 'success',
      title: 'Projected layer added',
      description: `${layer.name} is now previewed on the model.`,
    });
  }

  return (
    <Panel title="Generate">
      <SegmentedControl
        value={tab}
        options={[
          { value: 'single', label: 'Single' },
          { value: 'multiview', label: 'Multiview', disabled: true },
        ]}
        onChange={setTab}
        className="mb-3"
      />
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        className="h-24 w-full resize-none rounded-md border border-white/10 bg-black/24 p-3 text-sm text-white outline-none focus:border-liclick-pink"
      />
      <div className="mt-3 rounded-md border border-dashed border-white/15 p-3 text-sm text-white/52">
        <div className="flex items-center gap-2">
          <Image className="h-4 w-4" />
          {selectedReferenceIds.length} reference selected
        </div>
        <div className="mt-1 text-xs text-white/38">
          {lastCapture ? `Last capture ${lastCapture.width}px` : 'Generate will auto-capture first.'}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-white/70">
        <label className="flex items-center gap-2 rounded-md bg-white/[0.045] px-3 py-2">
          <input type="checkbox" checked={visibleOnly} onChange={(e) => setVisibleOnly(e.target.checked)} />
          Visible
        </label>
        <label className="flex items-center gap-2 rounded-md bg-white/[0.045] px-3 py-2">
          <input type="checkbox" checked={upscale} onChange={(e) => setUpscale(e.target.checked)} />
          Upscale
        </label>
      </div>
      <Button
        className="mt-3 w-full"
        variant="primary"
        disabled={isGenerating}
        onClick={handleGenerate}
        icon={<Sparkles className="h-4 w-4" />}
      >
        {isGenerating ? 'Generating...' : 'Generate Image'}
      </Button>
      {currentGeneration?.resultUrl && (
        <div className="mt-3 overflow-hidden rounded-md border border-white/10 bg-white/[0.045]">
          <img src={currentGeneration.resultUrl} alt="" className="aspect-square w-full object-cover" />
          <div className="p-2">
            <Button className="w-full" onClick={handleAddProjectedLayer}>
              Add as Projected Layer
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
