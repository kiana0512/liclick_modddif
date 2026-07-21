export type WorkflowModule = 'texture' | 'bake' | 'delivery';

export type WorkflowNavigation = {
  activeModule: WorkflowModule;
  onOpenTexture: () => void;
  onOpenBake: () => void;
  onOpenDelivery: () => void;
};
