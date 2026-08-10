import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { IMMEDIATE_PROJECT_SAVE_EVENT } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import type { ReferenceImage } from '@/types/project';
import { createId } from '@/utils/id';
import { referenceGroupId } from './referenceGroupUtils';

export type ReferenceGroupGenerationState = {
  groupId: string;
  status: 'generating' | 'failed';
  error?: string;
};

type ReferenceGroupPickerProps = {
  disabled?: boolean;
  generationState?: ReferenceGroupGenerationState;
  onGenerateMultiview: (singleReference: ReferenceImage) => void;
};

const SINGLE_REFERENCE_EXAMPLE_URL = '/examples/reference-single.png';
const MULTIVIEW_REFERENCE_EXAMPLE_URL = '/examples/reference-multiview.jpg';

function referenceRole(reference: ReferenceImage) {
  return reference.referenceRole ?? 'single-view';
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取参考图。'));
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

function dispatchImmediateSave() {
  window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
}

function checkerboardStyle() {
  return {
    backgroundImage:
      'linear-gradient(45deg,#252530 25%,transparent 25%),linear-gradient(-45deg,#252530 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#252530 75%),linear-gradient(-45deg,transparent 75%,#252530 75%)',
    backgroundPosition: '0 0,0 6px,6px -6px,-6px 0',
    backgroundSize: '12px 12px',
  };
}

function isFileDrag(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name);
}

function imageFilesFromDrop(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.files).filter(isImageFile);
}

function EmptyUploadTarget({
  title,
  exampleUrl,
  disabled,
  onClick,
  onFiles,
}: {
  title: string;
  exampleUrl: string;
  disabled?: boolean;
  onClick: () => void;
  onFiles: (files: File[]) => void;
}) {
  const [dragActive, setDragActive] = useState(false);

  function handleDragEnter(event: ReactDragEvent<HTMLButtonElement>) {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLButtonElement>) {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLButtonElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragActive(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLButtonElement>) {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const files = imageFilesFromDrop(event);
    if (files.length) onFiles(files);
  }

  return (
    <button
      type="button"
      disabled={disabled}
      className={`relative grid h-[64px] place-items-center overflow-hidden rounded-md border transition disabled:cursor-not-allowed disabled:opacity-45 ${dragActive ? 'border-liclick-pink bg-liclick-pink/10 text-liclick-pink shadow-[0_0_22px_rgba(238,72,197,0.16)]' : 'border-transparent text-white/46 hover:bg-white/[0.045] hover:text-white'}`}
      onClick={onClick}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <img
        src={exampleUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40 grayscale"
      />
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/82 via-black/36 to-black/24" />
      <span className="relative z-10 grid justify-items-center gap-1.5 text-[10px] font-semibold">
        <ImagePlus className="h-5 w-5" />
        {dragActive ? `松开上传到${title}` : `上传${title}`}
        {!dragActive ? <span className="font-normal text-white/28">可选</span> : null}
      </span>
    </button>
  );
}

function ImagePreviewDialog({ reference, onClose }: { reference: ReferenceImage; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  if (typeof document === 'undefined') return null;
  const updateZoom = (next: number) => setZoom(Math.min(4, Math.max(0.5, next)));
  return createPortal(
    <div
      className="fixed inset-0 z-[180] grid place-items-center bg-black/78 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${reference.name} 预览`}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="grid h-[82vh] w-[min(92vw,1080px)] grid-rows-[44px_1fr] overflow-hidden rounded-xl border border-white/16 bg-[#0d0d16] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3">
          <span className="min-w-0 truncate text-xs font-semibold text-white/82">{reference.name}</span>
          <div className="flex items-center gap-1">
            <button type="button" className="grid h-7 w-7 place-items-center rounded text-white/58 hover:bg-white/8 hover:text-white" onClick={() => updateZoom(zoom - 0.25)} title="缩小">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="h-7 min-w-12 rounded px-2 text-[10px] text-white/60 hover:bg-white/8 hover:text-white" onClick={() => setZoom(1)} title="适合窗口">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="grid h-7 w-7 place-items-center rounded text-white/58 hover:bg-white/8 hover:text-white" onClick={() => updateZoom(zoom + 0.25)} title="放大">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="ml-1 grid h-7 w-7 place-items-center rounded text-white/58 hover:bg-white/8 hover:text-white" onClick={onClose} title="关闭">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div
          className="overflow-auto p-4"
          style={checkerboardStyle()}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            updateZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
          }}
        >
          <div className="flex min-h-full min-w-full items-center justify-center">
            <img
              src={reference.url}
              alt={reference.name}
              draggable={false}
              className="h-auto object-contain transition-[width] duration-150"
              style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ReferenceGroupPicker({
  disabled = false,
  generationState,
  onGenerateMultiview,
}: ReferenceGroupPickerProps) {
  const references = useReferenceStore((state) => state.references);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const setReferences = useReferenceStore((state) => state.setReferences);
  const setSelectedReferences = useReferenceStore((state) => state.setSelectedReferences);
  const addSingleInputRef = useRef<HTMLInputElement>(null);
  const addMultiviewInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const referenceMenuRef = useRef<HTMLDivElement>(null);
  const [uploadError, setUploadError] = useState<string>();
  const [previewReference, setPreviewReference] = useState<ReferenceImage>();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [openReferenceMenuId, setOpenReferenceMenuId] = useState<string>();
  const [referenceMenuPosition, setReferenceMenuPosition] = useState({ left: 8, top: 8 });
  const [containerDragActive, setContainerDragActive] = useState(false);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [addMenuOpen]);

  useEffect(() => {
    if (!openReferenceMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      if (!referenceMenuRef.current?.contains(event.target as Node)) {
        setOpenReferenceMenuId(undefined);
      }
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [openReferenceMenuId]);

  async function imageFromFile(
    file: File,
    fields: Pick<ReferenceImage, 'referenceGroupId' | 'referenceRole' | 'derivedFromReferenceId'>,
  ): Promise<ReferenceImage> {
    const url = await fileToDataUrl(file);
    const size = await getImageSize(url);
    return {
      id: createId('reference'),
      name: file.name.replace(/\.[^.]+$/, '') || '参考图',
      url,
      width: size.width,
      height: size.height,
      isPrimary: false,
      referenceSource: 'uploaded',
      ...fields,
    };
  }

  async function addReferenceFiles(files: File[], role: 'single-view' | 'multi-view') {
    const imageFiles = files.filter(isImageFile);
    if (!imageFiles.length) {
      setUploadError('请选择图片文件。');
      return;
    }
    const created = await Promise.all(
      imageFiles.map(async (file) => {
        const groupId = createId('reference-group');
        return imageFromFile(file, { referenceGroupId: groupId, referenceRole: role });
      }),
    );
    const next = [
      ...created.map((reference, index) => ({ ...reference, isPrimary: index === 0 })),
      ...references.map((reference) => ({ ...reference, isPrimary: false })),
    ];
    setReferences(next);
    if (created[0]) setSelectedReferences([created[0].id]);
    setUploadError(undefined);
    dispatchImmediateSave();
  }

  function selectReference(reference: ReferenceImage) {
    setSelectedReferences([reference.id]);
    setOpenReferenceMenuId(undefined);
    dispatchImmediateSave();
  }

  function duplicateReference(reference: ReferenceImage) {
    const duplicatedId = createId('reference');
    const duplicated: ReferenceImage = {
      ...reference,
      id: duplicatedId,
      name: `${reference.name} 副本`,
      isPrimary: true,
      referenceGroupId: createId('reference-group'),
      derivedFromReferenceId: undefined,
      generationId: undefined,
      referenceSource: 'uploaded',
    };
    const next = [
      duplicated,
      ...references.map((item) => ({ ...item, isPrimary: false })),
    ];
    setReferences(next);
    setSelectedReferences([duplicatedId]);
    setOpenReferenceMenuId(undefined);
    dispatchImmediateSave();
  }

  function deleteReference(reference: ReferenceImage) {
    const next = references.filter((item) => item.id !== reference.id);
    const wasSelected = selectedReferenceIds.includes(reference.id);
    const fallback = wasSelected ? next[0] : undefined;
    const nextSelectedIds = wasSelected
      ? fallback
        ? [fallback.id]
        : []
      : selectedReferenceIds.filter((id) => next.some((item) => item.id === id));
    setReferences(
      next.map((item) => ({
        ...item,
        isPrimary: nextSelectedIds.includes(item.id),
      })),
    );
    setSelectedReferences(nextSelectedIds);
    setOpenReferenceMenuId(undefined);
    dispatchImmediateSave();
  }

  function generateMultiviewFor(reference: ReferenceImage) {
    const sourceReference =
      referenceRole(reference) === 'single-view'
        ? reference
        : references.find(
            (item) =>
              referenceRole(item) === 'single-view' &&
              referenceGroupId(item) === referenceGroupId(reference),
          );
    if (!sourceReference) {
      setUploadError('该多视图没有关联的单视图，无法再次生成多视图。');
      setOpenReferenceMenuId(undefined);
      return;
    }
    setSelectedReferences([sourceReference.id]);
    setOpenReferenceMenuId(undefined);
    onGenerateMultiview(sourceReference);
  }

  function handleAddInput(event: ChangeEvent<HTMLInputElement>, role: 'single-view' | 'multi-view') {
    if (event.target.files?.length) void addReferenceFiles(Array.from(event.target.files), role);
    event.currentTarget.value = '';
  }

  function handleContainerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    setContainerDragActive(true);
  }

  function handleContainerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setContainerDragActive(true);
  }

  function handleContainerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setContainerDragActive(false);
  }

  function handleContainerDrop(
    event: ReactDragEvent<HTMLDivElement>,
    role: 'single-view' | 'multi-view',
  ) {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    setContainerDragActive(false);
    const files = imageFilesFromDrop(event);
    if (files.length) void addReferenceFiles(files, role);
  }

  return (
    <div
      className="relative grid gap-2"
      onDragEnter={handleContainerDragEnter}
      onDragOver={handleContainerDragOver}
      onDragLeave={handleContainerDragLeave}
    >
      <input ref={addSingleInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleAddInput(event, 'single-view')} />
      <input ref={addMultiviewInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleAddInput(event, 'multi-view')} />

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white/88">参考图</span>
        <div ref={addMenuRef} className="relative flex items-center gap-1.5">
          <span className="text-[9px] font-normal text-white/30">单图 / 多视图任选</span>
          <button
            type="button"
            disabled={disabled}
            className={`grid h-6 w-6 place-items-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-35 ${
              addMenuOpen
                ? 'bg-liclick-pink/16 text-liclick-pink'
                : 'text-white/45 hover:bg-white/[0.055] hover:text-white'
            }`}
            title="添加参考图"
            aria-label="添加参考图"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((open) => !open)}
          >
            <Plus className="h-4 w-4" />
          </button>
          {addMenuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-8 z-30 grid w-32 gap-1 rounded-lg bg-[#171322] p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.55)]"
            >
              <button
                type="button"
                role="menuitem"
                className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] font-semibold text-white/72 transition hover:bg-white/[0.065] hover:text-white"
                onClick={() => {
                  setAddMenuOpen(false);
                  addSingleInputRef.current?.click();
                }}
              >
                <ImagePlus className="h-3.5 w-3.5 text-liclick-pink" />添加单视图
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] font-semibold text-white/72 transition hover:bg-white/[0.065] hover:text-white"
                onClick={() => {
                  setAddMenuOpen(false);
                  addMultiviewInputRef.current?.click();
                }}
              >
                <ImagePlus className="h-3.5 w-3.5 text-liclick-pink" />添加多视图
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {references.length === 0 ? (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-black/18 p-2">
          <EmptyUploadTarget
            title="单视图"
            exampleUrl={SINGLE_REFERENCE_EXAMPLE_URL}
            disabled={disabled}
            onClick={() => addSingleInputRef.current?.click()}
            onFiles={(files) => void addReferenceFiles(files, 'single-view')}
          />
          <EmptyUploadTarget
            title="多视图"
            exampleUrl={MULTIVIEW_REFERENCE_EXAMPLE_URL}
            disabled={disabled}
            onClick={() => addMultiviewInputRef.current?.click()}
            onFiles={(files) => void addReferenceFiles(files, 'multi-view')}
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 px-0.5 py-1">
          {references.map((reference) => {
            const selected = selectedReferenceIds.includes(reference.id);
            const role = referenceRole(reference);
            const state =
              generationState?.groupId === referenceGroupId(reference)
                ? generationState
                : undefined;
            const menuOpen = openReferenceMenuId === reference.id;
            return (
              <div
                key={reference.id}
                className="group/reference relative min-w-0"
              >
                <button
                  type="button"
                  disabled={disabled}
                  className={`relative block aspect-square w-full overflow-hidden rounded-lg bg-[#101019] transition disabled:cursor-not-allowed disabled:opacity-55 ${
                    selected
                      ? 'shadow-[0_0_0_2px_rgba(238,72,197,0.92),0_0_18px_rgba(238,72,197,0.18)]'
                      : 'shadow-[0_0_0_1px_rgba(255,255,255,0.08)] hover:shadow-[0_0_0_1px_rgba(255,255,255,0.22)]'
                  }`}
                  style={checkerboardStyle()}
                  onClick={() => selectReference(reference)}
                  title={`选中${role === 'multi-view' ? '多视图' : '单视图'}`}
                >
                  <img
                    src={reference.url}
                    alt={reference.name}
                    draggable={false}
                    className="h-full w-full object-contain"
                  />
                  <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-white/82">
                    {role === 'multi-view' ? '多视图' : '单视图'}
                  </span>
                  {selected ? (
                    <span className="absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-liclick-pink text-white shadow-[0_0_10px_rgba(238,72,197,0.65)]">
                      <Check className="h-2.5 w-2.5" />
                    </span>
                  ) : null}
                  {state?.status === 'generating' ? (
                    <span className="absolute inset-0 grid place-items-center bg-black/58 text-liclick-pink backdrop-blur-[1px]">
                      <LoaderCircle className="h-5 w-5 animate-spin" />
                    </span>
                  ) : null}
                  {state?.status === 'failed' ? (
                    <span className="absolute bottom-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-rose-950/90 text-rose-200" title={state.error ?? '生成失败'}>
                      <AlertTriangle className="h-3 w-3" />
                    </span>
                  ) : null}
                </button>

                <button
                  type="button"
                  disabled={disabled}
                  className={`absolute right-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full bg-black/64 text-white transition duration-150 disabled:hidden ${
                    menuOpen
                      ? 'opacity-100 shadow-[0_0_14px_rgba(238,72,197,0.48)]'
                      : 'opacity-0 group-hover/reference:opacity-100 focus-visible:opacity-100'
                  }`}
                  aria-label="图片功能"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title="图片功能"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (openReferenceMenuId === reference.id) {
                      setOpenReferenceMenuId(undefined);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    const menuWidth = 144;
                    const menuHeight = 174;
                    const left = Math.max(
                      8,
                      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
                    );
                    const belowTop = rect.bottom + 6;
                    const top =
                      belowTop + menuHeight <= window.innerHeight - 8
                        ? belowTop
                        : Math.max(8, rect.top - menuHeight - 6);
                    setReferenceMenuPosition({ left, top });
                    setOpenReferenceMenuId(reference.id);
                  }}
                >
                  <MoreHorizontal className="h-3.5 w-3.5 drop-shadow-[0_0_5px_rgba(255,255,255,0.9)]" />
                </button>

                {menuOpen && typeof document !== 'undefined' ? createPortal(
                  <div
                    ref={referenceMenuRef}
                    role="menu"
                    className="fixed z-[190] grid w-36 gap-0.5 rounded-lg border border-white/10 bg-[#191720] p-1.5 shadow-[0_14px_42px_rgba(0,0,0,0.68)]"
                    style={referenceMenuPosition}
                  >
                    <button type="button" role="menuitem" className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] text-white/78 transition hover:bg-white/[0.07] hover:text-white" onClick={() => selectReference(reference)}>
                      <Check className="h-3.5 w-3.5 text-liclick-pink" />选中该图片
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={state?.status === 'generating'}
                      className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] text-white/78 transition hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => generateMultiviewFor(reference)}
                    >
                      {state?.status === 'generating' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-liclick-pink" /> : <Sparkles className="h-3.5 w-3.5 text-liclick-pink" />}
                      {state?.status === 'generating' ? '正在生成' : '生成多视图'}
                    </button>
                    <button type="button" role="menuitem" className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] text-white/78 transition hover:bg-white/[0.07] hover:text-white" onClick={() => { setPreviewReference(reference); setOpenReferenceMenuId(undefined); }}>
                      <Eye className="h-3.5 w-3.5" />预览图
                    </button>
                    <button type="button" role="menuitem" className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] text-white/78 transition hover:bg-white/[0.07] hover:text-white" onClick={() => duplicateReference(reference)}>
                      <Copy className="h-3.5 w-3.5" />复制新副本
                    </button>
                    <button type="button" role="menuitem" className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[10px] text-rose-200/82 transition hover:bg-rose-400/10 hover:text-rose-100" onClick={() => deleteReference(reference)}>
                      <Trash2 className="h-3.5 w-3.5" />删除
                    </button>
                  </div>,
                  document.body,
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {uploadError ? <p className="text-[10px] text-rose-200/72">{uploadError}</p> : null}
      {previewReference ? <ImagePreviewDialog reference={previewReference} onClose={() => setPreviewReference(undefined)} /> : null}
      {containerDragActive ? (
        <div className="absolute inset-0 z-40 grid grid-cols-2 overflow-hidden rounded-lg bg-[#0b0912]/92 p-2 backdrop-blur-sm">
          <div
            className="grid place-items-center rounded-l-lg bg-liclick-pink/[0.055] text-liclick-pink transition hover:bg-liclick-pink/12"
            onDragOver={handleContainerDragOver}
            onDrop={(event) => handleContainerDrop(event, 'single-view')}
          >
            <span className="grid justify-items-center gap-1.5 text-[10px] font-semibold">
              <ImagePlus className="h-5 w-5" />拖入为单视图
            </span>
          </div>
          <div
            className="grid place-items-center rounded-r-lg bg-violet-400/[0.055] text-violet-200 transition hover:bg-violet-400/12"
            onDragOver={handleContainerDragOver}
            onDrop={(event) => handleContainerDrop(event, 'multi-view')}
          >
            <span className="grid justify-items-center gap-1.5 text-[10px] font-semibold">
              <ImagePlus className="h-5 w-5" />拖入为多视图
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
