import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, RotateCcw, Trash2, X } from 'lucide-react';
import { useI18nStore } from '@/stores/i18nStore';
import {
  SHORTCUT_DEFINITIONS,
  captureShortcutBinding,
  formatShortcutBinding,
  getShortcutBindings,
  shortcutBindingKey,
  useShortcutStore,
  type ShortcutActionId,
} from '@/stores/shortcutStore';

type ShortcutSettingsDialogProps = {
  onClose: () => void;
};

export function ShortcutSettingsDialog({ onClose }: ShortcutSettingsDialogProps) {
  const language = useI18nStore((state) => state.language);
  const overrides = useShortcutStore((state) => state.overrides);
  const setBindings = useShortcutStore((state) => state.setBindings);
  const resetAll = useShortcutStore((state) => state.resetAll);
  const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId>();
  const [conflict, setConflict] = useState('');

  const groups = useMemo(() => {
    const result = new Map<string, typeof SHORTCUT_DEFINITIONS>();
    for (const definition of SHORTCUT_DEFINITIONS) {
      const category = language === 'zh' ? definition.categoryZh : definition.categoryEn;
      const entries = result.get(category) ?? [];
      entries.push(definition);
      result.set(category, entries);
    }
    return [...result.entries()];
  }, [language]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!recordingActionId) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setRecordingActionId(undefined);
        setConflict('');
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setBindings(recordingActionId, []);
        setRecordingActionId(undefined);
        setConflict('');
        return;
      }
      const nextBinding = captureShortcutBinding(event);
      if (!nextBinding) return;
      const currentDefinition = SHORTCUT_DEFINITIONS.find((item) => item.id === recordingActionId);
      const conflictDefinition = SHORTCUT_DEFINITIONS.find((item) => {
        if (item.id === recordingActionId) return false;
        const sharesRuntimeScope =
          item.scope === currentDefinition?.scope ||
          item.scope === 'global' ||
          currentDefinition?.scope === 'global';
        return (
          sharesRuntimeScope &&
          getShortcutBindings(item.id).some(
            (itemBinding) => shortcutBindingKey(itemBinding) === shortcutBindingKey(nextBinding),
          )
        );
      });
      if (conflictDefinition) {
        const label = language === 'zh' ? conflictDefinition.labelZh : conflictDefinition.labelEn;
        setConflict(
          language === 'zh'
            ? `该快捷键已用于“${label}”，请换一个组合。`
            : `This shortcut is already assigned to “${label}”.`,
        );
        return;
      }
      setBindings(recordingActionId, [nextBinding]);
      setRecordingActionId(undefined);
      setConflict('');
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [language, onClose, recordingActionId, setBindings]);

  return createPortal(
    <div
      data-shortcut-dialog
      className="fixed inset-0 z-[180] grid place-items-center bg-black/68 p-4 text-white backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="flex max-h-[min(86vh,820px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/14 bg-[#171822] shadow-[0_30px_90px_rgba(0,0,0,0.62)]">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold">
              <Keyboard className="h-5 w-5 text-liclick-pink" />
              {language === 'zh' ? '自定义快捷键' : 'Keyboard shortcuts'}
            </div>
            <p className="mt-1 text-xs leading-5 text-white/48">
              {language === 'zh'
                ? '配置会按当前登录用户全局保存。点击快捷键后直接按下新组合，Delete 可清除。'
                : 'Saved globally for the signed-in user. Select a shortcut and press a new combination; Delete clears it.'}
            </p>
          </div>
          <button type="button" className="grid h-8 w-8 place-items-center rounded hover:bg-white/10" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        {conflict && <div className="border-b border-red-300/14 bg-red-400/10 px-5 py-2 text-xs text-red-100">{conflict}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {groups.map(([category, definitions]) => (
            <section key={category} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/38">{category}</h3>
              <div className="overflow-hidden rounded-lg border border-white/10">
                {definitions.map((definition) => {
                  const bindings = overrides[definition.id] ?? definition.defaults;
                  const isRecording = recordingActionId === definition.id;
                  return (
                    <div key={definition.id} className="flex min-h-12 items-center gap-3 border-b border-white/8 px-3 last:border-b-0 hover:bg-white/[0.035]">
                      <span className="min-w-0 flex-1 truncate text-sm text-white/78">
                        {language === 'zh' ? definition.labelZh : definition.labelEn}
                      </span>
                      <button
                        type="button"
                        className={`min-w-40 rounded-md border px-3 py-1.5 text-right text-xs font-semibold transition ${
                          isRecording
                            ? 'border-liclick-pink bg-liclick-pink/14 text-liclick-pink'
                            : 'border-white/14 bg-black/18 text-white/72 hover:border-white/28 hover:text-white'
                        }`}
                        onClick={() => {
                          setConflict('');
                          setRecordingActionId(definition.id);
                        }}
                      >
                        {isRecording
                          ? language === 'zh' ? '请按新快捷键…' : 'Press shortcut…'
                          : bindings.length > 0
                            ? bindings.map(formatShortcutBinding).join(' / ')
                            : language === 'zh' ? '未设置' : 'Unassigned'}
                      </button>
                      <button
                        type="button"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded text-white/34 transition hover:bg-white/10 hover:text-white"
                        title={language === 'zh' ? '清除' : 'Clear'}
                        onClick={() => {
                          setBindings(definition.id, []);
                          setRecordingActionId(undefined);
                          setConflict('');
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <footer className="flex items-center justify-between border-t border-white/10 px-5 py-3">
          <span className="text-xs text-white/38">
            {language === 'zh' ? '同一作用域内不允许重复快捷键。' : 'Duplicate shortcuts are blocked within the same scope.'}
          </span>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-white/14 px-3 text-xs font-semibold text-white/66 hover:bg-white/8 hover:text-white"
            onClick={() => {
              resetAll();
              setRecordingActionId(undefined);
              setConflict('');
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {language === 'zh' ? '恢复全部默认值' : 'Restore defaults'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
