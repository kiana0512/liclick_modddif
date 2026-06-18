import { Crosshair, LocateFixed, RotateCcw, Scaling, Target } from 'lucide-react';
import {
  centerImportedModel,
  fitCameraToImportedModel,
  groundImportedModel,
  resetImportedModelTransform,
} from '@/engine/scene/transformActions';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { useSceneStore } from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';

function formatNumber(value?: number) {
  return typeof value === 'number' ? value.toFixed(2) : '-';
}

export function ObjectTransformPanel() {
  const object = useSceneStore((state) => state.objects.find((item) => item.id === state.selectedObjectId));
  const importedModel = useSceneStore((state) => state.importedModel);
  const importSettings = useSceneStore((state) => state.importSettings);
  const setImportSettings = useSceneStore((state) => state.setImportSettings);
  const pushToast = useToastStore((state) => state.pushToast);

  function runTransformAction(action: () => void, title: string) {
    if (!importedModel) {
      pushToast({ tone: 'warning', title: 'Please import a model first.' });
      return;
    }
    action();
    pushToast({ tone: 'success', title });
  }

  return (
    <Panel title="Object Transform">
      <div className="space-y-3 text-xs text-white/58">
        {!object && <div className="rounded-md border border-dashed border-white/12 p-3">No object selected.</div>}
        {object && (
          <>
            <div className="grid grid-cols-2 gap-2 rounded-md bg-white/[0.045] p-3">
              <div>Format</div>
              <div className="text-right uppercase text-white/76">{object.format}</div>
              <div>Meshes</div>
              <div className="text-right text-white/76">{object.childMeshCount ?? '-'}</div>
              <div>UV</div>
              <div className={object.uvSets.length ? 'text-right text-emerald-200' : 'text-right text-amber-200'}>
                {object.uvSets.length ? object.uvSets.join(', ') : 'No UV'}
              </div>
              <div>Size</div>
              <div className="text-right text-white/76">
                {object.boundingBox
                  ? object.boundingBox.size.map((value) => value.toFixed(2)).join(' / ')
                  : '-'}
              </div>
              <div>Norm scale</div>
              <div className="text-right text-white/76">
                {object.importNormalizationTransform
                  ? object.importNormalizationTransform.scale.map((value) => value.toFixed(2)).join(' / ')
                  : '-'}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 rounded-md bg-white/[0.045] p-3">
              <div className="text-white/40">Position</div>
              <div className="col-span-2 text-right text-white/76">
                {object.transform.position.map(formatNumber).join(' / ')}
              </div>
              <div className="text-white/40">Rotation</div>
              <div className="col-span-2 text-right text-white/76">
                {object.transform.rotation.map(formatNumber).join(' / ')}
              </div>
              <div className="text-white/40">Scale</div>
              <div className="col-span-2 text-right text-white/76">
                {object.transform.scale.map(formatNumber).join(' / ')}
              </div>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            className="w-full"
            icon={<RotateCcw className="h-4 w-4" />}
            onClick={() => runTransformAction(resetImportedModelTransform, 'Transform reset')}
          >
            Reset
          </Button>
          <Button
            className="w-full"
            icon={<Crosshair className="h-4 w-4" />}
            onClick={() => runTransformAction(centerImportedModel, 'Object centered')}
          >
            Center
          </Button>
          <Button
            className="w-full"
            icon={<LocateFixed className="h-4 w-4" />}
            onClick={() => runTransformAction(groundImportedModel, 'Object grounded')}
          >
            Ground
          </Button>
          <Button
            className="w-full"
            icon={<Target className="h-4 w-4" />}
            onClick={() => runTransformAction(fitCameraToImportedModel, 'Camera fitted')}
          >
            Fit Camera
          </Button>
        </div>

        <div className="space-y-2 rounded-md bg-white/[0.045] p-3">
          {[
            ['normalizeOnImport', 'Normalize on Import'],
            ['groundOnImport', 'Ground on Import'],
            ['autoFitCamera', 'Auto Fit Camera'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-3">
              <span>{label}</span>
              <input
                type="checkbox"
                checked={importSettings[key as keyof typeof importSettings]}
                onChange={(event) => setImportSettings({ [key]: event.target.checked })}
                className="accent-liclick-pink"
              />
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2 rounded-md bg-white/[0.045] px-3 py-2 text-white/42">
          <Scaling className="h-3.5 w-3.5" />
          Use Move / Rotate / Scale in the bottom toolbar to edit the selected model.
        </div>
      </div>
    </Panel>
  );
}
