import { ImagePlus } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { useReferenceStore } from '@/stores/referenceStore';

export function ReferenceImagesPanel() {
  const references = useReferenceStore((state) => state.references);
  const selectedReferenceIds = useReferenceStore((state) => state.selectedReferenceIds);
  const toggleReference = useReferenceStore((state) => state.toggleReference);

  return (
    <Panel title="Reference Images" action={<Button variant="ghost" icon={<ImagePlus className="h-4 w-4" />} />}>
      <div className="grid grid-cols-2 gap-2">
        {references.map((reference) => {
          const selected = selectedReferenceIds.includes(reference.id);
          return (
            <button
              type="button"
              key={reference.id}
              onClick={() => toggleReference(reference.id)}
              className={`overflow-hidden rounded-md border text-left ${
                selected ? 'border-liclick-pink bg-liclick-pink/12' : 'border-white/10 bg-white/[0.045]'
              }`}
            >
              <img src={reference.url} alt="" className="h-20 w-full object-cover" />
              <div className="truncate px-2 py-1 text-xs text-white/74">{reference.name}</div>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
