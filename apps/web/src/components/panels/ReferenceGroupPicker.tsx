import { createPortal } from 'react-dom';
import { useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent } from 'react';
import {
  AlertTriangle,
  Check,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { IMMEDIATE_PROJECT_SAVE_EVENT } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import type { ReferenceImage } from '@/types/project';
import { createId } from '@/utils/id';

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

type ReferenceGroup = {
  id: string;
  single?: ReferenceImage;
  multiview?: ReferenceImage;
};

function referenceRole(reference: ReferenceImage) {
  return reference.referenceRole ?? 'single-view';
}

export function referenceGroupId(reference: ReferenceImage) {
  return reference.referenceGroupId ?? reference.id;
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

function CompactImageSlot({
  title,
  reference,
  inputId,
  emptyLabel,
  disabled,
  generating,
  generationFailed,
  generationError,
  canGenerate,
  onFile,
  onPreview,
  onGenerate,
}: {
  title: string;
  reference?: ReferenceImage;
  inputId: string;
  emptyLabel: string;
  disabled?: boolean;
  generating?: boolean;
  generationFailed?: boolean;
  generationError?: string;
  canGenerate?: boolean;
  onFile: (file: File) => void;
  onPreview: (reference: ReferenceImage) => void;
  onGenerate?: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);

  function handleDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (disabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragActive(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const file = imageFilesFromDrop(event)[0];
    if (file) onFile(file);
  }

  return (
    <div
      className={`group/slot relative min-w-0 overflow-hidden rounded-lg border bg-[#11111b] transition ${dragActive ? 'border-liclick-pink bg-liclick-pink/10 shadow-[0_0_0_1px_rgba(238,72,197,0.32),0_0_22px_rgba(238,72,197,0.16)]' : 'border-white/11'}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        id={inputId}
        type="file"
        accept="image/*"
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = '';
        }}
      />
      {reference ? (
        <div className="relative h-[64px]" style={checkerboardStyle()}>
          <img src={reference.url} alt={reference.name} draggable={false} className="h-full w-full object-contain" />
          <span className="absolute left-1.5 top-1.5 rounded bg-black/72 px-1.5 py-0.5 text-[10px] font-semibold text-white/86">
            {title}
          </span>
          <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition group-hover/slot:opacity-100">
            {canGenerate && onGenerate ? (
              <button
                type="button"
                disabled={disabled || generating}
                className="grid h-6 w-6 place-items-center rounded bg-black/72 text-liclick-pink hover:bg-black/90 disabled:opacity-50"
                title={generationFailed ? generationError ?? '重新生成多视图' : '重新生成多视图'}
                onClick={onGenerate}
              >
                {generating ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              </button>
            ) : null}
            <button
              type="button"
              className="grid h-6 w-6 place-items-center rounded bg-black/72 text-white/72 hover:bg-black/90 hover:text-white"
              title="放大预览"
              onClick={() => onPreview(reference)}
            >
              <Maximize2 className="h-3 w-3" />
            </button>
            <label
              htmlFor={inputId}
              className="grid h-6 cursor-pointer place-items-center rounded bg-black/72 px-1.5 text-[9px] text-white/72 hover:bg-black/90 hover:text-white"
            >
              替换
            </label>
          </div>
        </div>
      ) : (
        <div className="relative flex h-[64px] items-center justify-center">
          <span className="absolute left-1.5 top-1.5 text-[9px] font-semibold text-white/42">{title}</span>
          <div className="flex items-center gap-1.5 pt-2">
            <label
              htmlFor={inputId}
              title={emptyLabel}
              className={`flex h-7 cursor-pointer items-center gap-1 rounded-md border border-white/10 px-2 text-[9px] font-semibold transition ${disabled ? 'cursor-not-allowed text-white/22' : 'text-white/55 hover:border-white/24 hover:bg-white/[0.05] hover:text-white'}`}
            >
              <Upload className="h-3 w-3" />上传
            </label>
            {canGenerate && onGenerate ? (
              <button
                type="button"
                disabled={disabled || generating}
                title={generationError ?? '根据单视图自动生成多视图'}
                className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[9px] font-semibold transition ${generationFailed ? 'border-rose-300/20 bg-rose-400/8 text-rose-100' : 'border-liclick-pink/20 bg-liclick-pink/8 text-liclick-pink hover:bg-liclick-pink/15'} disabled:cursor-not-allowed disabled:opacity-55`}
                onClick={onGenerate}
              >
                {generating ? <LoaderCircle className="h-3 w-3 animate-spin" /> : generationFailed ? <AlertTriangle className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                {generating ? '生成中' : generationFailed ? '重试' : '生成'}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#100c19]/88 backdrop-blur-[2px]">
          <span className="grid justify-items-center gap-1 text-[10px] font-semibold text-liclick-pink">
            <ImagePlus className="h-5 w-5" />
            松开上传到{title}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function EmptyUploadTarget({
  title,
  disabled,
  onClick,
  onFiles,
}: {
  title: string;
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
      <span className="grid justify-items-center gap-1.5 text-[10px] font-semibold">
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
  const [uploadError, setUploadError] = useState<string>();
  const [previewReference, setPreviewReference] = useState<ReferenceImage>();

  const groups = useMemo(() => {
    const byId = new Map<string, ReferenceGroup>();
    references.forEach((reference) => {
      const id = referenceGroupId(reference);
      const group = byId.get(id) ?? { id };
      if (referenceRole(reference) === 'multi-view') group.multiview = reference;
      else group.single = reference;
      byId.set(id, group);
    });
    return Array.from(byId.values());
  }, [references]);

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

  async function replaceSlot(group: ReferenceGroup, role: 'single-view' | 'multi-view', file: File) {
    if (!isImageFile(file)) return;
    const existing = role === 'single-view' ? group.single : group.multiview;
    const replacement = await imageFromFile(file, {
      referenceGroupId: group.id,
      referenceRole: role,
      derivedFromReferenceId: role === 'multi-view' ? group.single?.id : undefined,
    });
    if (existing) replacement.id = existing.id;
    const groupIsSelected = [group.single?.id, group.multiview?.id].some(
      (id) => id && selectedReferenceIds.includes(id),
    );
    replacement.isPrimary = groupIsSelected;
    let next = references
      .filter((reference) => reference.id !== existing?.id)
      .filter(
        (reference) =>
          !(
            role === 'single-view' &&
            referenceRole(reference) === 'multi-view' &&
            referenceGroupId(reference) === group.id &&
            reference.referenceSource === 'generated'
          ),
      );
    next = [replacement, ...next].map((reference) => ({
      ...reference,
      isPrimary: groupIsSelected ? reference.id === replacement.id : reference.isPrimary,
    }));
    setReferences(next);
    setSelectedReferences([replacement.id]);
    dispatchImmediateSave();
  }

  function selectGroup(group: ReferenceGroup) {
    const selection = group.single ?? group.multiview;
    if (selection) setSelectedReferences([selection.id]);
  }

  function deleteGroup(group: ReferenceGroup) {
    const next = references.filter((reference) => referenceGroupId(reference) !== group.id);
    const nextReference = next[0];
    setReferences(next.map((reference) => ({ ...reference, isPrimary: reference.id === nextReference?.id })));
    setSelectedReferences(nextReference ? [nextReference.id] : []);
    dispatchImmediateSave();
  }

  function handleAddInput(event: ChangeEvent<HTMLInputElement>, role: 'single-view' | 'multi-view') {
    if (event.target.files?.length) void addReferenceFiles(Array.from(event.target.files), role);
    event.currentTarget.value = '';
  }

  return (
    <div className="grid gap-2">
      <input ref={addSingleInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleAddInput(event, 'single-view')} />
      <input ref={addMultiviewInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleAddInput(event, 'multi-view')} />

      {groups.length === 0 ? (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-dashed border-white/14 bg-black/18 p-2">
          <EmptyUploadTarget
            title="单视图"
            disabled={disabled}
            onClick={() => addSingleInputRef.current?.click()}
            onFiles={(files) => void addReferenceFiles(files, 'single-view')}
          />
          <EmptyUploadTarget
            title="多视图"
            disabled={disabled}
            onClick={() => addMultiviewInputRef.current?.click()}
            onFiles={(files) => void addReferenceFiles(files, 'multi-view')}
          />
        </div>
      ) : (
        groups.map((group, index) => {
          const selected = [group.single?.id, group.multiview?.id].some(
            (id) => id && selectedReferenceIds.includes(id),
          );
          const state = generationState?.groupId === group.id ? generationState : undefined;
          return (
            <section
              key={group.id}
              className={`py-1.5 transition ${selected ? 'bg-liclick-pink/[0.045]' : 'hover:bg-white/[0.018]'}`}
            >
              <div className="flex h-7 items-center justify-between gap-2 px-1">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-semibold text-white/76" onClick={() => selectGroup(group)}>
                  <span className={`grid h-4 w-4 place-items-center rounded-full border ${selected ? 'border-liclick-pink bg-liclick-pink text-white' : 'border-white/22 text-transparent'}`}>
                    <Check className="h-2.5 w-2.5" />
                  </span>
                  参考图 {index + 1}
                </button>
                <button type="button" className="grid h-6 w-6 place-items-center rounded text-white/35 transition hover:bg-rose-400/12 hover:text-rose-200" onClick={() => deleteGroup(group)} title="删除参考图">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 px-1">
                <CompactImageSlot
                  title="单视图"
                  reference={group.single}
                  inputId={`single-reference-${group.id}`}
                  emptyLabel="上传单视图"
                  disabled={disabled}
                  onFile={(file) => void replaceSlot(group, 'single-view', file)}
                  onPreview={setPreviewReference}
                />
                <CompactImageSlot
                  title="多视图"
                  reference={group.multiview}
                  inputId={`multi-reference-${group.id}`}
                  emptyLabel="上传多视图"
                  disabled={disabled || state?.status === 'generating'}
                  generating={state?.status === 'generating'}
                  generationFailed={state?.status === 'failed'}
                  generationError={state?.error}
                  canGenerate={Boolean(group.single)}
                  onFile={(file) => void replaceSlot(group, 'multi-view', file)}
                  onPreview={setPreviewReference}
                  onGenerate={group.single ? () => onGenerateMultiview(group.single!) : undefined}
                />
              </div>
            </section>
          );
        })
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" disabled={disabled} className="flex h-7 items-center justify-center gap-1 rounded-md border border-dashed border-white/13 text-[10px] font-semibold text-white/45 transition hover:border-white/26 hover:bg-white/[0.035] hover:text-white disabled:cursor-not-allowed disabled:opacity-45" onClick={() => addSingleInputRef.current?.click()}>
          <Plus className="h-3 w-3" />新增单视图
        </button>
        <button type="button" disabled={disabled} className="flex h-7 items-center justify-center gap-1 rounded-md border border-dashed border-white/13 text-[10px] font-semibold text-white/45 transition hover:border-white/26 hover:bg-white/[0.035] hover:text-white disabled:cursor-not-allowed disabled:opacity-45" onClick={() => addMultiviewInputRef.current?.click()}>
          <Plus className="h-3 w-3" />新增多视图
        </button>
      </div>
      {uploadError ? <p className="text-[10px] text-rose-200/72">{uploadError}</p> : null}
      {previewReference ? <ImagePreviewDialog reference={previewReference} onClose={() => setPreviewReference(undefined)} /> : null}
    </div>
  );
}
