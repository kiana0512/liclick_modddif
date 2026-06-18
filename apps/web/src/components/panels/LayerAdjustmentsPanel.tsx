import { SlidersHorizontal } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';

export function LayerAdjustmentsPanel() {
  return (
    <Panel title="Layer Adjustments">
      <div className="space-y-3 text-sm text-white/60">
        {['Exposure', 'Contrast', 'Roughness Influence'].map((label) => (
          <label key={label} className="block">
            <div className="mb-1 flex items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {label}
            </div>
            <input type="range" min="0" max="1" step="0.01" defaultValue="0.5" className="w-full accent-liclick-pink" />
          </label>
        ))}
      </div>
    </Panel>
  );
}
