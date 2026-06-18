import { useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Plus } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { useT } from '@/stores/i18nStore';
import { useReferenceStore } from '@/stores/referenceStore';
import type { ReferenceImage } from '@/types/project';

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

export function ReferenceImagesPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const t = useT();
  const references = useReferenceStore((state) => state.references);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const addReferences = useReferenceStore((state) => state.addReferences);
  const toggleReference = useReferenceStore((state) => state.toggleReference);

  async function importFiles(files: FileList | File[]) {
    const imageFiles = Array.isArray(files) ? files.filter((file) => file.type.startsWith('image/')) : getImageFiles(files);
    if (imageFiles.length === 0) return;
    const nextReferences: ReferenceImage[] = await Promise.all(
      imageFiles.map(async (file, index) => {
        const url = await fileToDataUrl(file);
        const size = await getImageSize(url);
        return {
          id: `reference-${crypto.randomUUID()}`,
          name: file.name.replace(/\.[^.]+$/, '') || `Reference ${index + 1}`,
          url,
          width: size.width,
          height: size.height,
          isPrimary: index === 0,
        };
      }),
    );
    addReferences(nextReferences);
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

  return (
    <Panel
      title={t('referenceImages')}
      action={
        <Button
          variant="ghost"
          title={t('uploadReference')}
          onClick={() => inputRef.current?.click()}
          icon={<ImagePlus className="h-4 w-4" />}
        />
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files);
          event.currentTarget.value = '';
        }}
      />
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingImage(false);
        }}
        onDrop={handleDrop}
        className={`min-h-24 rounded-md border border-dashed p-2 transition ${
          isDraggingImage
            ? 'border-liclick-pink bg-liclick-pink/14'
            : 'border-white/14 bg-black/18 hover:border-white/32 hover:bg-white/[0.045]'
        }`}
      >
        {references.length === 0 ? (
          <div className="flex h-20 items-center justify-center gap-2 text-xs font-semibold text-white/50">
            <Plus className="h-4 w-4" />
            {t('dropReferenceImages')}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {references.map((reference) => {
              const selected = selectedReferenceIds.includes(reference.id);
              return (
                <button
                  type="button"
                  key={reference.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleReference(reference.id);
                  }}
                  className={`overflow-hidden rounded-md border text-left ${
                    selected ? 'border-liclick-pink bg-liclick-pink/12' : 'border-white/10 bg-white/[0.045]'
                  }`}
                >
                  <img src={reference.url} alt="" className="h-16 w-full object-cover" />
                  <div className="truncate px-2 py-1 text-xs text-white/74">{reference.name}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
