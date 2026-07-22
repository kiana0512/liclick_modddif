export type WorkflowModule = 'texture' | 'bake';

export type WorkflowNavigation = {
  activeModule: WorkflowModule;
  onOpenTexture: () => void;
  onOpenBake: () => void;
};
