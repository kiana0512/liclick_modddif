import { useState } from 'react';
import { Image, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { generateTextureMock } from '@/services/mockGenerationService';
import { useGenerationStore } from '@/stores/generationStore';
import { useLayerStore } from '@/stores/layerStore';
import { useReferenceStore } from '@/stores/referenceStore';

type GenerateTab = 'single' | 'multiview';

export function GeneratePanel() {
  const [tab, setTab] = useState<GenerateTab>('single');
  const [prompt, setPrompt] = useState('soft pink-purple ceramic texture with clean highlights');
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [upscale, setUpscale] = useState(false);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const { currentGeneration, isGenerating, start, addGeneration } = useGenerationStore();
  const addProjectedLayerFromGeneration = useLayerStore((state) => state.addProjectedLayerFromGeneration);

  async function handleGenerate() {
    start();
    const generation = await generateTextureMock({
      mode: 'single',
      prompt,
      referenceIds: selectedReferenceIds,
      visibleOnly,
      upscale,
    });
    addGeneration(generation);
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
            <Button
              className="w-full"
              onClick={() => addProjectedLayerFromGeneration(currentGeneration)}
            >
              Add as Projected Layer
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
