import type { ReactNode } from 'react';

export type WorkspaceMode = 'texture' | 'normal' | 'segments' | 'export';

export type DockSide = 'left' | 'right';

export type PanelId =
  | 'objects'
  | 'generate'
  | 'references'
  | 'viewport'
  | 'layers'
  | 'layerAdjustments'
  | 'objectTransform'
  | 'quickMask'
  | 'segments'
  | 'normalVisualizer'
  | 'normalGeneration'
  | 'export';

export type WorkspacePanelMode = WorkspaceMode | 'all';

export interface WorkspacePanelState {
  id: PanelId;
  title: string;
  dock: DockSide;
  order: number;
  collapsed: boolean;
  visible: boolean;
  mode?: WorkspacePanelMode;
}

export type WorkspacePanelDefinition = WorkspacePanelState & {
  content: ReactNode;
  actions?: ReactNode;
};
