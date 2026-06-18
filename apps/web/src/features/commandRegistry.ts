import type { FeatureFlag } from './featureFlags';
import { featureFlags } from './featureFlags';
import { useToastStore } from '@/stores/toastStore';

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
  comingSoon: string;
};

export const commandRegistry: Record<CommandId, CommandDefinition> = {
  paint: { id: 'paint', label: 'Paint', feature: 'paint', comingSoon: 'Paint tool' },
  eraser: { id: 'eraser', label: 'Eraser', feature: 'eraser', comingSoon: 'Eraser tool' },
  quickMask: { id: 'quickMask', label: 'Quick Mask', feature: 'quickMask', comingSoon: 'Quick Mask' },
  segments: { id: 'segments', label: 'Segments', feature: 'segments', comingSoon: 'Segmentation view' },
  multiview: {
    id: 'multiview',
    label: 'Multiview',
    feature: 'multiview',
    comingSoon: 'Multiview generation',
  },
  normalGeneration: {
    id: 'normalGeneration',
    label: 'Normal',
    feature: 'normalGeneration',
    comingSoon: 'Normal generation',
  },
  exportGlb: { id: 'exportGlb', label: 'Export', feature: 'exportGlb', comingSoon: 'GLB export' },
  maxConnector: { id: 'maxConnector', label: '3ds Max', feature: 'maxConnector', comingSoon: '3ds Max connector' },
  blenderConnector: {
    id: 'blenderConnector',
    label: 'Blender',
    feature: 'blenderConnector',
    comingSoon: 'Blender connector',
  },
  renameLayer: { id: 'renameLayer', label: 'Rename', feature: 'paint', comingSoon: 'Layer rename' },
  undo: { id: 'undo', label: 'Undo', feature: 'paint', comingSoon: 'Undo history' },
  redo: { id: 'redo', label: 'Redo', feature: 'paint', comingSoon: 'Redo history' },
  addLayer: { id: 'addLayer', label: 'Add Layer', feature: 'paint', comingSoon: 'Manual layer creation' },
  newProject: { id: 'newProject', label: 'New Project', feature: 'paint', comingSoon: 'New project creation' },
  newFolder: { id: 'newFolder', label: 'New Folder', feature: 'paint', comingSoon: 'Project folders' },
  folderManagement: {
    id: 'folderManagement',
    label: 'Folders',
    feature: 'paint',
    comingSoon: 'Folder management',
  },
  projectLibrary: {
    id: 'projectLibrary',
    label: 'Project Library',
    feature: 'paint',
    comingSoon: 'Project library navigation',
  },
  referenceUpload: {
    id: 'referenceUpload',
    label: 'Upload Reference',
    feature: 'paint',
    comingSoon: 'Reference image upload',
  },
  settings: { id: 'settings', label: 'Settings', feature: 'paint', comingSoon: 'Workspace settings' },
};

export function isCommandEnabled(commandId: CommandId) {
  return featureFlags[commandRegistry[commandId].feature];
}

export function runComingSoonCommand(commandId: CommandId) {
  const command = commandRegistry[commandId];
  useToastStore.getState().pushToast({
    tone: 'info',
    title: `Coming soon: ${command.comingSoon}`,
    description: 'This command is visible for workflow planning but is not implemented in this MVP.',
  });
}
