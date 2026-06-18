export type LayerStackOperation = 'add' | 'delete' | 'reorder' | 'toggle' | 'set-opacity';

export type LayerStackCommand = {
  operation: LayerStackOperation;
  layerId: string;
  payload?: Record<string, unknown>;
};

export function sortLayerIdsByOrder<T extends { id: string; order: number }>(layers: T[]) {
  return [...layers].sort((a, b) => a.order - b.order).map((layer) => layer.id);
}
