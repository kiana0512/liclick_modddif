export const featureFlags = {
  modelImport: true,
  capture: true,
  generateMock: true,
  projectedLayer: true,
  uvBake: true,
  localSave: true,
  transformControls: true,
  paint: false,
  eraser: false,
  quickMask: false,
  segments: false,
  multiview: false,
  normalGeneration: false,
  exportGlb: false,
  maxConnector: false,
  blenderConnector: false,
} as const;

export type FeatureFlag = keyof typeof featureFlags;
