export type WorkflowModule = 'texture' | 'retopology' | 'uv' | 'bake';

export type WorkflowNavigation = {
  activeModule: WorkflowModule;
  onOpenTexture: () => void;
  onOpenRetopology: () => void;
  onOpenUv: () => void;
  onOpenBake: () => void;
};
