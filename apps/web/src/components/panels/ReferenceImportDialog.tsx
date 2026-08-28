import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon, Images, X } from 'lucide-react';
import type { ReferenceImage } from '@/types/project';

export type ReferenceImportRole = 'single-view' | 'multi-view';

type ReferenceImportDialogProps = {
  references: ReferenceImage[];
  onImport: (role: ReferenceImportRole) => void;
  onClose: () => void;
};

export function ReferenceImportDialog({
  references,
  onImport,
  onClose,
}: ReferenceImportDialogProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const firstReference = references[0];
  if (!firstReference || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[220] grid place-items-center bg-black/76 p-4 backdrop-blur-[5px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reference-import-title"
      onClick={onClose}
    >
      <div
        className="grid w-full max-w-[420px] gap-3 overflow-hidden rounded-xl border border-white/14 bg-[#11111b] p-4 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="reference-import-title" className="text-base font-semibold text-white">
              导入参考图
            </h2>
            <p className="mt-0.5 text-xs text-white/48">请选择这张图片的用途</p>
          </div>
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white/58 transition hover:bg-white/8 hover:text-white"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-hidden rounded-lg bg-[#080810]">
          <img
            src={firstReference.url}
            alt={firstReference.name}
            className="max-h-[330px] min-h-[180px] w-full object-contain"
            draggable={false}
          />
        </div>

        <div className="flex min-w-0 items-center justify-between gap-3 text-[11px] text-white/46">
          <span className="truncate">{firstReference.name}</span>
          {references.length > 1 ? <span className="shrink-0">共 {references.length} 张</span> : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="grid min-h-[72px] content-center justify-items-center gap-1 rounded-lg border border-white/14 bg-white/[0.055] px-3 text-sm font-semibold text-white transition hover:border-liclick-pink/55 hover:bg-liclick-pink/10 hover:text-liclick-pink"
            onClick={() => onImport('single-view')}
          >
            <ImageIcon className="h-5 w-5" />
            传入作为单视图
          </button>
          <button
            type="button"
            className="grid min-h-[72px] content-center justify-items-center gap-1 rounded-lg border border-white/14 bg-white/[0.055] px-3 text-sm font-semibold text-white transition hover:border-liclick-pink/55 hover:bg-liclick-pink/10 hover:text-liclick-pink"
            onClick={() => onImport('multi-view')}
          >
            <Images className="h-5 w-5" />
            传入作为多视图
          </button>
        </div>

        <button
          type="button"
          className="h-9 rounded-lg text-sm font-semibold text-white/58 transition hover:bg-white/[0.055] hover:text-white"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
    </div>,
    document.body,
  );
}
