import { useState } from 'react';
import { Image, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { captureCurrentView } from '@/engine/capture/captureCurrentView';
import { generateTextureMock } from '@/services/mockGenerationService';
import { useGenerationStore } from '@/stores/generationStore';
import { useT } from '@/stores/i18nStore';
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
  const t = useT();
  const [tab, setTab] = useState<GenerateTab>('single');
  const [prompt, setPrompt] = useState(t('defaultPrompt'));
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [upscale, setUpscale] = useState(false);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const references = useReferenceStore((state) => state.references);
  const selectedReferences = references.filter((reference) => selectedReferenceIds.includes(reference.id));
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
    if (!importedModel) throw new Error(t('importModelFirst'));
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
    <Panel title={t('generatePanel')}>
      <SegmentedControl
        value={tab}
        options={[
          { value: 'single', label: t('single') },
          { value: 'multiview', label: t('multiview'), disabled: true },
        ]}
        onChange={setTab}
        className="mb-2"
      />
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        className="h-16 w-full resize-none rounded-md border border-white/10 bg-white/[0.08] p-2.5 text-[13px] leading-5 text-white outline-none focus:border-liclick-pink"
      />
      <div className="mt-2 rounded-md border border-dashed border-white/12 p-2.5 text-xs text-white/52">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Image className="h-3.5 w-3.5" />
            {selectedReferenceIds.length} {t('referenceSelected')}
          </span>
          <span className="text-white/36">
            {lastCapture ? `${lastCapture.width}${t('capturePx')}` : t('autoCapture')}
          </span>
        </div>
        {selectedReferences.length > 0 && (
          <div className="mt-2 flex gap-1.5 overflow-hidden">
            {selectedReferences.slice(0, 4).map((reference) => (
              <img
                key={reference.id}
                src={reference.url}
                alt=""
                className="h-8 w-8 rounded border border-white/10 object-cover"
              />
            ))}
          </div>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/68">
        <label className="flex items-center gap-2 rounded-md bg-white/[0.045] px-3 py-2">
          <input type="checkbox" checked={visibleOnly} onChange={(e) => setVisibleOnly(e.target.checked)} />
          {t('visible')}
        </label>
        <label className="flex items-center gap-2 rounded-md bg-white/[0.045] px-3 py-2">
          <input type="checkbox" checked={upscale} onChange={(e) => setUpscale(e.target.checked)} />
          {t('upscale')}
        </label>
      </div>
      <Button
        className="mt-2 w-full"
        variant="primary"
        disabled={isGenerating}
        onClick={handleGenerate}
        icon={<Sparkles className="h-4 w-4" />}
      >
        {isGenerating ? t('generating') : t('generateImage')}
      </Button>
      {currentGeneration?.resultUrl && (
        <div className="mt-2 overflow-hidden rounded-md border border-white/10 bg-white/[0.045]">
          <div className="relative h-44 overflow-hidden">
            <img src={currentGeneration.resultUrl} alt="" className="h-full w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-2 text-xs font-semibold leading-4 text-white">
              {currentGeneration.prompt}
            </div>
          </div>
          <div className="p-2">
            <Button className="w-full" onClick={handleAddProjectedLayer}>
              {t('addAsProjectedLayer')}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
