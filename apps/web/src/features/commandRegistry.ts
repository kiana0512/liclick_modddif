import type { FeatureFlag } from './featureFlags';
import { featureFlags } from './featureFlags';
import { useToastStore } from '@/stores/toastStore';
import type { WorkspaceMode } from '@/components/workspace/workspacePanelTypes';

export type CommandId =
  | 'paint'
  | 'eraser'
  | 'quickMask'
  | 'segments'
  | 'multiview'
  | 'normalGeneration'
  | 'exportGlb'
  | 'maxConnector'
  | 'blenderConnector'
  | 'renameLayer'
  | 'undo'
  | 'redo'
  | 'addLayer'
  | 'newProject'
  | 'newFolder'
  | 'folderManagement'
  | 'projectLibrary'
  | 'referenceUpload'
  | 'settings';

export type CommandDefinition = {
  id: CommandId;
  label: string;
  feature: FeatureFlag;
  enabled: boolean;
  comingSoon: string;
  message: string;
  mode?: WorkspaceMode;
  tooltip: string;
};

export const commandRegistry: Record<CommandId, CommandDefinition> = {
  paint: { id: 'paint', label: 'Paint', feature: 'paint', enabled: false, comingSoon: 'Paint', message: 'Coming soon: Paint', tooltip: 'Coming soon: Paint' },
  eraser: { id: 'eraser', label: 'Eraser', feature: 'eraser', enabled: false, comingSoon: 'Eraser', message: 'Coming soon: Eraser', tooltip: 'Coming soon: Eraser' },
  quickMask: { id: 'quickMask', label: 'Quick Mask', feature: 'quickMask', enabled: false, comingSoon: 'Quick Mask', message: 'Coming soon: Quick Mask', mode: 'segments', tooltip: 'Coming soon: Quick Mask' },
  segments: { id: 'segments', label: 'Segments', feature: 'segments', enabled: false, comingSoon: 'Segments', message: 'Coming soon: Segments', mode: 'segments', tooltip: 'Coming soon: Segments' },
  multiview: {
    id: 'multiview',
    label: 'Multiview',
    feature: 'multiview',
    enabled: false,
    comingSoon: 'Multiview',
    message: 'Coming soon: Multiview',
    tooltip: 'Coming soon: Multiview',
  },
  normalGeneration: {
    id: 'normalGeneration',
    label: 'Normal',
    feature: 'normalGeneration',
    enabled: false,
    comingSoon: 'Normal generation',
    message: 'Coming soon: Normal generation',
    mode: 'normal',
    tooltip: 'Coming soon: Normal generation',
  },
  exportGlb: { id: 'exportGlb', label: 'Export', feature: 'exportGlb', enabled: false, comingSoon: 'GLB export', message: 'Coming soon: GLB export', mode: 'export', tooltip: 'Coming soon: GLB export' },
  maxConnector: { id: 'maxConnector', label: '3ds Max', feature: 'maxConnector', enabled: false, comingSoon: '3ds Max connector', message: 'Coming soon: 3ds Max connector', tooltip: 'Coming soon: 3ds Max connector' },
  blenderConnector: {
    id: 'blenderConnector',
    label: 'Blender',
    feature: 'blenderConnector',
    enabled: false,
    comingSoon: 'Blender connector',
    message: 'Coming soon: Blender connector',
    tooltip: 'Coming soon: Blender connector',
  },
  renameLayer: { id: 'renameLayer', label: 'Rename', feature: 'paint', enabled: false, comingSoon: 'Layer rename', message: 'Coming soon: Layer rename', tooltip: 'Coming soon: Layer rename' },
  undo: { id: 'undo', label: 'Undo', feature: 'paint', enabled: false, comingSoon: 'Undo', message: 'Coming soon: Undo', tooltip: 'Coming soon: Undo' },
  redo: { id: 'redo', label: 'Redo', feature: 'paint', enabled: false, comingSoon: 'Redo', message: 'Coming soon: Redo', tooltip: 'Coming soon: Redo' },
  addLayer: { id: 'addLayer', label: 'Add Layer', feature: 'paint', enabled: false, comingSoon: 'Add Layer', message: 'Coming soon: Add Layer', tooltip: 'Coming soon: Add Layer' },
  newProject: { id: 'newProject', label: 'New Project', feature: 'paint', enabled: false, comingSoon: 'New project', message: 'Coming soon: New project', tooltip: 'Coming soon: New project' },
  newFolder: { id: 'newFolder', label: 'New Folder', feature: 'paint', enabled: false, comingSoon: 'New folder', message: 'Coming soon: New folder', tooltip: 'Coming soon: New folder' },
  folderManagement: {
    id: 'folderManagement',
    label: 'Folders',
    feature: 'paint',
    enabled: false,
    comingSoon: 'Folder management',
    message: 'Coming soon: Folder management',
    tooltip: 'Coming soon: Folder management',
  },
  projectLibrary: {
    id: 'projectLibrary',
    label: 'Project Library',
    feature: 'paint',
    enabled: false,
    comingSoon: 'Project library',
    message: 'Coming soon: Project library',
    tooltip: 'Coming soon: Project library',
  },
  referenceUpload: {
    id: 'referenceUpload',
    label: 'Upload Reference',
    feature: 'paint',
    enabled: false,
    comingSoon: 'Reference upload',
    message: 'Coming soon: Reference upload',
    tooltip: 'Coming soon: Reference upload',
  },
  settings: { id: 'settings', label: 'Settings', feature: 'paint', enabled: false, comingSoon: 'Settings', message: 'Coming soon: Settings', tooltip: 'Coming soon: Settings' },
};

export function isCommandEnabled(commandId: CommandId) {
  const command = commandRegistry[commandId];
  return command.enabled || featureFlags[command.feature];
}

export function runComingSoonCommand(commandId: CommandId) {
  const command = commandRegistry[commandId];
  useToastStore.getState().pushToast({
    tone: 'info',
    title: command.message,
    dedupeKey: `coming-soon:${commandId}`,
  });
}
