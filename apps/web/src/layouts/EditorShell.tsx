import type { ReactNode } from 'react';
import { ArrowLeft, Download, FileUp, RotateCcw, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useSettingsStore } from '@/stores/settingsStore';

type EditorShellProps = {
  projectName: string;
  onBack: () => void;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
};

export function EditorShell({ projectName, onBack, left, center, right }: EditorShellProps) {
  const resolution = useSettingsStore((state) => state.resolution);
  const setResolution = useSettingsStore((state) => state.setResolution);

  return (
    <main className="flex min-h-screen flex-col bg-ink text-white lg:h-screen lg:min-h-[720px]">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#111325] px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Liclick 3D Texture / {projectName}</div>
            <div className="text-[11px] text-white/42">Editor workspace</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            value="Texture"
            options={[
              { value: 'Texture', label: 'Texture' },
              { value: 'Normal', label: 'Normal' },
              { value: 'Segments', label: 'Segments' },
              { value: 'Export', label: 'Export' },
            ]}
            onChange={() => undefined}
            className="w-full sm:w-[320px]"
          />
          <SegmentedControl
            value={resolution}
            options={[
              { value: '1K', label: '1K' },
              { value: '2K', label: '2K' },
              { value: '4K', label: '4K' },
            ]}
            onChange={setResolution}
            className="w-36"
          />
          <Button icon={<FileUp className="h-4 w-4" />}>Import Model</Button>
          <Button icon={<Download className="h-4 w-4" />} variant="primary">
            Export
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[300px_minmax(0,1fr)_320px] lg:overflow-hidden">
        <aside className="min-h-0 border-b border-white/10 bg-[#121426] lg:overflow-y-auto lg:border-b-0 lg:border-r">
          {left}
        </aside>
        <section className="relative h-[420px] min-h-0 bg-[#080914] sm:h-[520px] lg:h-auto">
          {center}
        </section>
        <aside className="min-h-0 border-t border-white/10 bg-[#121426] lg:overflow-y-auto lg:border-l lg:border-t-0">
          {right}
        </aside>
      </div>

      <footer className="flex min-h-14 shrink-0 flex-wrap items-center justify-center gap-2 border-t border-white/10 bg-[#111325] px-3 py-2">
        {['Select', 'Paint', 'Eraser', 'Add Layer'].map((tool) => (
          <Button key={tool} variant={tool === 'Select' ? 'primary' : 'secondary'}>
            {tool}
          </Button>
        ))}
        <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} title="Undo" />
        <Button variant="ghost" icon={<RotateCw className="h-4 w-4" />} title="Redo" />
      </footer>
    </main>
  );
}
