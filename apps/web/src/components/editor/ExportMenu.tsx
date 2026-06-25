import { useState } from 'react';
import { Camera, Check, Download, Film, Package, Triangle, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/common/cn';
import { IconTooltip } from '@/components/common/IconTooltip';
import type { ExportFormat, ExportTarget } from '@/engine/export/exportTypes';

type ExportActionId =
  | `scene-${ExportFormat}`
  | `object-${ExportFormat}`
  | 'texture-color'
  | 'texture-normal'
  | 'viewport-png'
  | 'turntable-webm';

type ExportMenuProps = {
  canExportScene: boolean;
  canExportObject: boolean;
  canExportColor: boolean;
  canExportNormal: boolean;
  canRecordTurntable: boolean;
  onExport: (actionId: ExportActionId) => void;
  labels: {
    export: string;
    scene: string;
    object: string;
    texture: string;
    video: string;
    viewportSnapshot: string;
    turntable: string;
    color: string;
    normal: string;
    bakeFirst: string;
    importModelFirst: string;
    selectObjectFirst: string;
    browserUnsupported: string;
  };
};

type ExportMenuRow = {
  id?: ExportActionId;
  label: string;
  status?: string;
  disabled?: boolean;
  disabledReason?: string;
};

function modelRows(target: ExportTarget, canExport: boolean, disabledReason: string): ExportMenuRow[] {
  return [
    { id: `${target}-glb`, label: 'GLB', disabled: !canExport, disabledReason },
    { id: `${target}-fbx`, label: 'FBX', disabled: !canExport, disabledReason },
    { id: `${target}-obj`, label: 'OBJ', disabled: !canExport, disabledReason },
    { id: `${target}-stl`, label: 'STL', disabled: !canExport, disabledReason },
  ];
}

export function ExportMenu({
  canExportScene,
  canExportObject,
  canExportColor,
  canExportNormal,
  canRecordTurntable,
  onExport,
  labels,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const groups: Array<{ label: string; icon: typeof Package; rows: ExportMenuRow[] }> = [
    {
      label: labels.scene,
      icon: Package,
      rows: [
        { id: 'viewport-png', label: labels.viewportSnapshot, disabled: !canExportScene, disabledReason: labels.importModelFirst },
        ...modelRows('scene', canExportScene, labels.importModelFirst),
      ],
    },
    {
      label: labels.object,
      icon: Triangle,
      rows: modelRows('object', canExportObject, labels.selectObjectFirst),
    },
    {
      label: labels.texture,
      icon: Camera,
      rows: [
        { id: 'texture-color', label: labels.color, disabled: !canExportColor, disabledReason: labels.bakeFirst },
        { id: 'texture-normal', label: labels.normal, disabled: !canExportNormal, disabledReason: labels.importModelFirst },
      ],
    },
    {
      label: labels.video,
      icon: Film,
      rows: [
        {
          id: 'turntable-webm',
          label: labels.turntable,
          disabled: !canExportScene || !canRecordTurntable,
          disabledReason: !canRecordTurntable ? labels.browserUnsupported : labels.importModelFirst,
        },
      ],
    },
  ];

  return (
    <div className="relative hidden sm:block" onBlur={() => window.setTimeout(() => setOpen(false), 140)}>
      <IconTooltip label={labels.export} side="bottom">
        <Button
          className="h-9 w-9 px-0"
          icon={<Download className="h-4 w-4" />}
          variant="secondary"
          onClick={() => setOpen((value) => !value)}
          aria-label={labels.export}
        />
      </IconTooltip>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 overflow-hidden rounded-lg border border-white/10 bg-[#15182a] p-2 shadow-[0_18px_42px_rgba(0,0,0,0.42)]">
          {groups.map(({ label, icon: Icon, rows }) => (
            <div key={label} className="mb-2 last:mb-0">
              <div className="flex items-center gap-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/42">
                <Icon className="h-3.5 w-3.5 text-liclick-pink" />
                {label}
              </div>
              {rows.map((row) => (
                <button
                  key={`${label}-${row.label}`}
                  type="button"
                  disabled={row.disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!row.id || row.disabled) return;
                    onExport(row.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-white/74 transition hover:bg-white/8 hover:text-white disabled:cursor-not-allowed disabled:text-white/30',
                  )}
                  title={row.disabled ? row.disabledReason ?? row.status : undefined}
                >
                  <span>{row.label}</span>
                  <span className="ml-3 inline-flex items-center gap-1 text-[10px] uppercase text-white/34">
                    {row.status ?? (row.disabled ? <X className="h-3 w-3" /> : <Check className="h-3 w-3 text-liclick-pink" />)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type { ExportActionId };
