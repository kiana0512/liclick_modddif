import type { ReactNode } from 'react';
import { ArrowLeft, Download, FileDown, FileUp, RotateCcw, RotateCw, Save } from 'lucide-react';
import { runComingSoonCommand } from '@/features/commandRegistry';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useSceneStore, type TransformMode } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';

type EditorShellProps = {
  projectName: string;
  workspaceLabel?: string;
  onBack: () => void;
  onImportModel: () => void;
  onSaveProject: () => void;
  onSaveAsProject: () => void;
  onLoadProject: () => void;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
};

export function EditorShell({
  projectName,
  workspaceLabel,
  onBack,
  onImportModel,
  onSaveProject,
  onSaveAsProject,
  onLoadProject,
  left,
  center,
  right,
}: EditorShellProps) {
  const resolution = useSettingsStore((state) => state.resolution);
  const setResolution = useSettingsStore((state) => state.setResolution);
  const transformMode = useSceneStore((state) => state.transformMode);
  const setTransformMode = useSceneStore((state) => state.setTransformMode);

  return (
    <main className="flex min-h-screen flex-col bg-ink text-white lg:h-screen lg:min-h-[720px]">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-[#111325] px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Liclick 3D Texture / {projectName}</div>
            <div className="text-[11px] text-white/42">{workspaceLabel ?? 'Editor workspace'}</div>
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
            onChange={(mode) => {
              if (mode === 'Normal') runComingSoonCommand('normalGeneration');
              if (mode === 'Segments') runComingSoonCommand('segments');
              if (mode === 'Export') runComingSoonCommand('exportGlb');
            }}
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
          <Button icon={<FileUp className="h-4 w-4" />} onClick={onImportModel}>
            Import Model
          </Button>
          <Button icon={<Save className="h-4 w-4" />} onClick={onSaveProject}>
            Save Project
          </Button>
          <Button icon={<Save className="h-4 w-4" />} onClick={onSaveAsProject}>
            Save As...
          </Button>
          <Button icon={<FileDown className="h-4 w-4" />} onClick={onLoadProject}>
            Load Project
          </Button>
          <Button
            icon={<Download className="h-4 w-4" />}
            variant="primary"
            onClick={() => runComingSoonCommand('exportGlb')}
          >
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
        {[
          ['select', 'Select'],
          ['translate', 'Move'],
          ['rotate', 'Rotate'],
          ['scale', 'Scale'],
        ].map(([mode, label]) => (
          <Button
            key={mode}
            variant={transformMode === mode ? 'primary' : 'secondary'}
            onClick={() => setTransformMode(mode as TransformMode)}
          >
            {label}
          </Button>
        ))}
        <Button variant="secondary" onClick={() => runComingSoonCommand('paint')}>
          Paint
        </Button>
        <Button variant="secondary" onClick={() => runComingSoonCommand('eraser')}>
          Eraser
        </Button>
        <Button variant="secondary" onClick={() => runComingSoonCommand('addLayer')}>
          Add Layer
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCcw className="h-4 w-4" />}
          title="Undo"
          onClick={() => runComingSoonCommand('undo')}
        />
        <Button
          variant="ghost"
          icon={<RotateCw className="h-4 w-4" />}
          title="Redo"
          onClick={() => runComingSoonCommand('redo')}
        />
      </footer>
    </main>
  );
}
