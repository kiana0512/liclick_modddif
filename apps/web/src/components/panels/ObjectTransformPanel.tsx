import { Crosshair, LocateFixed, RotateCcw, Scaling, Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  centerImportedModel,
  fitCameraToImportedModel,
  groundImportedModel,
  resetImportedModelTransform,
} from '@/engine/scene/transformActions';
import { Button } from '@/components/ui/Button';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { Panel } from '@/components/ui/Panel';
import { useT } from '@/stores/i18nStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';

function formatNumber(value?: number) {
  return typeof value === 'number' ? value.toFixed(2) : '-';
}

export function ObjectTransformPanel() {
  const t = useT();
  const object = useSceneStore((state) => state.objects.find((item) => item.id === state.selectedObjectId));
  const importedModel = useSceneStore((state) => state.importedModel);
  const importSettings = useSceneStore((state) => state.importSettings);
  const selectObject = useSceneStore((state) => state.selectObject);
  const setImportSettings = useSceneStore((state) => state.setImportSettings);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const pushToast = useToastStore((state) => state.pushToast);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const objectLabel = object?.name ?? importedModel?.name ?? '模型';

  useEffect(() => {
    if (!object && importedModel) selectObject(importedModel.objectId);
  }, [importedModel, object, selectObject]);

  function runTransformAction(action: () => void, title: string, captureLabel?: string) {
    if (!importedModel) {
      pushToast({ tone: 'warning', title: t('importModelFirst') });
      return;
    }
    if (captureLabel) captureHistory(captureLabel);
    action();
    pushToast({ tone: 'success', title });
  }

  return (
    <Panel title={t('objectTransform')}>
      <div className="space-y-3 text-xs text-white/58">
        {!object && <div className="rounded-md border border-dashed border-white/12 p-3">{t('noObjectSelected')}</div>}
        {object && (
          <>
            <div className="grid grid-cols-2 gap-2 rounded-md bg-white/[0.045] p-2.5">
              <div>{t('format')}</div>
              <div className="text-right uppercase text-white/76">{object.format}</div>
              <div>{t('meshes')}</div>
              <div className="text-right text-white/76">{object.childMeshCount ?? '-'}</div>
              <div>{t('uv')}</div>
              <div className={object.uvSets.length ? 'text-right text-emerald-200' : 'text-right text-amber-200'}>
                {object.uvSets.length ? object.uvSets.join(', ') : t('noUv')}
              </div>
              <div>{t('size')}</div>
              <div className="text-right text-white/76">
                {object.boundingBox
                  ? object.boundingBox.size.map((value) => value.toFixed(2)).join(' / ')
                  : '-'}
              </div>
              <div>{t('normScale')}</div>
              <div className="text-right text-white/76">
                {object.importNormalizationTransform
                  ? object.importNormalizationTransform.scale.map((value) => value.toFixed(2)).join(' / ')
                  : '-'}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 rounded-md bg-white/[0.045] p-2.5">
              <div className="text-white/40">{t('position')}</div>
              <div className="col-span-2 text-right text-white/76">
                {object.transform.position.map(formatNumber).join(' / ')}
              </div>
              <div className="text-white/40">{t('rotationLabel')}</div>
              <div className="col-span-2 text-right text-white/76">
                {object.transform.rotation.map(formatNumber).join(' / ')}
              </div>
              <div className="text-white/40">{t('scale')}</div>
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
            onClick={() => runTransformAction(resetImportedModelTransform, 'Transform reset', `重置对象变换：${objectLabel}`)}
          >
            {t('reset')}
          </Button>
          <Button
            className="w-full"
            icon={<Crosshair className="h-4 w-4" />}
            onClick={() => runTransformAction(centerImportedModel, 'Object centered', `居中对象：${objectLabel}`)}
          >
            {t('center')}
          </Button>
          <Button
            className="w-full"
            icon={<LocateFixed className="h-4 w-4" />}
            onClick={() => runTransformAction(groundImportedModel, 'Object grounded', `对象落地：${objectLabel}`)}
          >
            {t('ground')}
          </Button>
          <Button
            className="w-full"
            icon={<Target className="h-4 w-4" />}
            onClick={() => runTransformAction(fitCameraToImportedModel, 'Camera fitted')}
          >
            {t('fitCamera')}
          </Button>
        </div>

        <div className="rounded-md bg-white/[0.045]">
          <button
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-white/56 hover:text-white/76"
          >
            <span>{t('importSettings')}</span>
            <span>{settingsOpen ? '-' : '+'}</span>
          </button>
          {settingsOpen && (
            <div className="space-y-2 border-t border-white/8 px-3 py-2">
              {[
                ['normalizeOnImport', t('normalizeOnImport')],
                ['groundOnImport', t('groundOnImport')],
                ['autoFitCamera', t('autoFitCamera')],
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
          )}
        </div>

        <div className="flex items-center gap-2 rounded-md bg-white/[0.045] px-3 py-2 text-white/42">
          <Scaling className="h-3.5 w-3.5" />
          {t('transformHint')}
        </div>
      </div>
    </Panel>
  );
}
