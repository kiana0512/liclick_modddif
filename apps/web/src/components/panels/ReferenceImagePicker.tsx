import { useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Eye, ImagePlus, MoreVertical, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/stores/i18nStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { ReferenceImage } from '@/types/project';
import { createId } from '@/utils/id';
import { downloadImageAsset } from '@/utils/downloadImage';

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image.'));
    reader.readAsDataURL(file);
  });
}

function getImageSize(url: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
}

function getImageFiles(files: FileList) {
  return Array.from(files).filter((file) => file.type.startsWith('image/'));
}

type ReferenceImagePickerProps = {
  compact?: boolean;
  inputId?: string;
  selectionMode?: 'multiple' | 'single';
};

type MenuState = {
  referenceId: string;
  x: number;
  y: number;
};

export function ReferenceImagePicker({ compact = false, inputId, selectionMode = 'multiple' }: ReferenceImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [menu, setMenu] = useState<MenuState | undefined>();
  const [hoveredReferenceId, setHoveredReferenceId] = useState<string | undefined>();
  const [previewReferenceId, setPreviewReferenceId] = useState<string | undefined>();
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [pendingImport, setPendingImport] = useState<ReferenceImage[] | undefined>();
  const t = useT();
  const references = useReferenceStore((state) => state.references);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const visibleReferences = references.filter((reference) => !reference.objectId || reference.objectId === selectedObjectId);
  const visibleReferenceIds = new Set(visibleReferences.map((reference) => reference.id));
  const visibleSelectedReferenceIds = selectedReferenceIds.filter((id) => visibleReferenceIds.has(id));
  const addReferences = useReferenceStore((state) => state.addReferences);
  const setSelectedReferences = useReferenceStore((state) => state.setSelectedReferences);
  const toggleReference = useReferenceStore((state) => state.toggleReference);
  const renameReference = useReferenceStore((state) => state.renameReference);
  const duplicateReference = useReferenceStore((state) => state.duplicateReference);
  const deleteReference = useReferenceStore((state) => state.deleteReference);
  const previewReference = previewReferenceId
    ? references.find((reference) => reference.id === previewReferenceId)
    : isShiftPressed && hoveredReferenceId
      ? references.find((reference) => reference.id === hoveredReferenceId)
      : undefined;
  const portalRoot = typeof document === 'undefined' ? undefined : document.body;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Shift') setIsShiftPressed(true);
      if (event.key === 'Escape') {
        setMenu(undefined);
        setPreviewReferenceId(undefined);
        setPendingImport(undefined);
        setIsShiftPressed(false);
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === 'Shift') setIsShiftPressed(false);
    }

    function handleBlur() {
      setIsShiftPressed(false);
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  async function importFiles(files: FileList | File[]) {
    const imageFiles = Array.isArray(files) ? files.filter((file) => file.type.startsWith('image/')) : getImageFiles(files);
    if (imageFiles.length === 0) return;
    const nextReferences: ReferenceImage[] = await Promise.all(
      imageFiles.map(async (file, index) => {
        const url = await fileToDataUrl(file);
        const size = await getImageSize(url);
        return {
          id: createId('reference'),
          name: file.name.replace(/\.[^.]+$/, '') || `Reference ${index + 1}`,
          url,
          width: size.width,
          height: size.height,
          isPrimary: index === 0,
          objectId: selectedObjectId,
        };
      }),
    );
    setPendingImport(nextReferences);
  }

  function confirmPendingImport() {
    if (!pendingImport) return;
    addReferences(pendingImport);
    if (selectionMode === 'single' && pendingImport[0]) {
      setSelectedReferences([pendingImport[0].id]);
    }
    setPendingImport(undefined);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingImage(false);
    void importFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    const hasImage = Array.from(event.dataTransfer.items).some((item) => item.type.startsWith('image/'));
    if (!hasImage) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingImage(true);
  }

  function handleRename(reference: ReferenceImage) {
    const nextName = window.prompt(t('rename'), reference.name)?.trim();
    if (nextName) renameReference(reference.id, nextName);
    setMenu(undefined);
  }

  function handleDownload(reference: ReferenceImage) {
    void downloadImageAsset(reference.url, `liclick_reference_${reference.name || reference.id}`);
    setMenu(undefined);
  }

  function openMenu(referenceId: string, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    setMenu({
      referenceId,
      x: Math.max(8, Math.min(rect.right - 132, window.innerWidth - 232)),
      y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 246)),
    });
  }

  return (
    <>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={selectionMode === 'multiple'}
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      <div
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingImage(false);
        }}
        onDrop={handleDrop}
        className={`rounded-md transition ${
          compact
            ? `min-h-[72px] p-2 ${isDraggingImage ? 'border border-dashed border-liclick-pink bg-liclick-pink/14' : 'border border-transparent bg-transparent'}`
            : `min-h-24 border border-dashed p-2 ${isDraggingImage ? 'border-liclick-pink bg-liclick-pink/14' : 'border-white/14 bg-black/18'}`
        }`}
      >
        {visibleReferences.length === 0 ? (
          <div className={`flex items-center justify-center gap-2 text-xs font-semibold text-white/50 ${compact ? 'h-14' : 'h-20'}`}>
            {!compact && <Plus className="h-4 w-4" />}
            {!compact && t('dropReferenceImages')}
          </div>
        ) : (
          <div className={compact ? 'flex flex-wrap gap-2' : 'grid grid-cols-2 gap-2'}>
            {visibleReferences.map((reference) => {
              const selected = visibleSelectedReferenceIds.includes(reference.id);
              return (
                <div
                  key={reference.id}
                  className={`group relative shrink-0 rounded-md border-2 text-left transition ${
                    compact ? 'w-[68px]' : ''
                  } ${
                    selected
                      ? 'border-liclick-pink bg-liclick-pink/14 shadow-[0_0_0_2px_rgba(255,92,207,0.34),0_8px_24px_rgba(238,77,214,0.24)] ring-2 ring-liclick-pink/28'
                      : 'border-white/16 bg-white/[0.045] hover:border-white/34'
                  }`}
                >
                  <button
                    type="button"
                    className="block w-full overflow-hidden rounded-[inherit] text-left"
                    title="Shift"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleReference(reference.id, selectionMode);
                    }}
                    onMouseEnter={() => setHoveredReferenceId(reference.id)}
                    onMouseMove={() => setHoveredReferenceId(reference.id)}
                    onMouseLeave={() => setHoveredReferenceId(undefined)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openMenu(reference.id, event.currentTarget);
                    }}
                  >
                    <img src={reference.url} alt="" className={`${compact ? 'h-[58px]' : 'h-16'} w-full object-cover`} />
                    {!compact && <div className="truncate px-2 py-1 text-xs text-white/74">{reference.name}</div>}
                  </button>
                  {selected && (
                    <div className="pointer-events-none absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full border border-white/70 bg-liclick-pink text-white shadow-glow">
                      <Check className="h-3.5 w-3.5" />
                    </div>
                  )}
                  <button
                    type="button"
                    className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded bg-black/62 text-white/82 opacity-0 transition hover:bg-black group-hover:opacity-100"
                    title={t('edit')}
                    onClick={(event) => {
                      event.stopPropagation();
                      openMenu(reference.id, event.currentTarget);
                    }}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!compact && (
        <Button
          variant="ghost"
          className="mt-2 h-8 w-full justify-center text-xs"
          title={t('uploadReference')}
          onClick={() => inputRef.current?.click()}
          icon={<ImagePlus className="h-4 w-4" />}
        >
          {t('uploadReference')}
        </Button>
      )}
      {portalRoot && menu && createPortal(
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={(event) => {
              event.stopPropagation();
              setMenu(undefined);
            }}
          />
          <div
            className="fixed z-[70] min-w-56 rounded-md border border-white/12 bg-[#202020] p-1 text-sm text-white shadow-xl"
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/10"
              onClick={() => {
                toggleReference(menu.referenceId, selectionMode);
                setMenu(undefined);
              }}
            >
              {t('select')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-white/72 hover:bg-white/10"
              onClick={() => {
                setPreviewReferenceId(menu.referenceId);
                setMenu(undefined);
              }}
            >
              <Eye className="h-3.5 w-3.5" />
              {t('view')}
              <span className="ml-auto rounded bg-white/70 px-1 text-[10px] text-black">SHIFT</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/10"
              onClick={() => {
                const reference = references.find((item) => item.id === menu.referenceId);
                if (reference) handleRename(reference);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('edit')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/10"
              onClick={() => {
                duplicateReference(menu.referenceId);
                setMenu(undefined);
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              {t('duplicate')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/10"
              onClick={() => {
                const reference = references.find((item) => item.id === menu.referenceId);
                if (reference) handleDownload(reference);
              }}
            >
              <Download className="h-3.5 w-3.5" />
              {t('downloadImage')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-red-200 hover:bg-red-500/18"
              onClick={() => {
                deleteReference(menu.referenceId);
                setMenu(undefined);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('delete')}
            </button>
          </div>
        </>,
        portalRoot,
      )}
      {portalRoot && pendingImport && createPortal(
        <div className="fixed inset-0 z-[128] grid place-items-center bg-black/70 px-4">
          <div className="grid w-full max-w-[320px] gap-3 rounded-lg border border-white/14 bg-[#151515] p-3 text-white shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{pendingImport[0]?.name}</div>
                {pendingImport.length > 1 && (
                  <div className="mt-0.5 text-xs text-white/58">
                    {pendingImport.length} {t('images')}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                aria-label={t('cancel')}
                onClick={() => setPendingImport(undefined)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {pendingImport[0] && (
              <img
                src={pendingImport[0].url}
                alt=""
                className="max-h-[320px] w-full rounded-md bg-white object-contain"
              />
            )}
            <button
              type="button"
              className="h-10 rounded-md border border-white/16 bg-white/10 text-sm font-semibold text-white hover:bg-white/16"
              onClick={confirmPendingImport}
            >
              {t('importAsReferenceImage')}
            </button>
            <button
              type="button"
              className="h-10 rounded-md border border-white/10 bg-white/[0.045] text-sm font-semibold text-white/46"
              disabled
            >
              {t('create3dObjectFromImage')}
            </button>
            <button
              type="button"
              className="h-9 rounded-md text-sm font-semibold text-white/70 hover:bg-white/8 hover:text-white"
              onClick={() => setPendingImport(undefined)}
            >
              {t('cancel')}
            </button>
          </div>
        </div>,
        portalRoot,
      )}
      {portalRoot && previewReference && createPortal(
        <button
          type="button"
          className={`fixed inset-0 z-[112] grid place-items-center bg-black/34 p-4 ${
            previewReferenceId ? 'cursor-default backdrop-blur-[1px]' : 'pointer-events-none'
          }`}
          aria-label={t('view')}
          onClick={() => setPreviewReferenceId(undefined)}
        >
          <img
            src={previewReference.url}
            alt=""
            className="max-h-[88vh] max-w-[92vw] rounded-md border border-white/16 bg-[#181818] object-contain shadow-2xl"
            draggable={false}
          />
        </button>,
        portalRoot,
      )}
    </>
  );
}
