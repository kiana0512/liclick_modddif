import type { Layer } from '@/types/layer';

export const mockLayers: Layer[] = [
  {
    id: 'layer-base-ceramic',
    name: 'Base ceramic wash',
    type: 'uv',
    imageUrl:
      'https://images.unsplash.com/photo-1618220179428-22790b461013?auto=format&fit=crop&w=320&q=80',
    visible: true,
    opacity: 0.9,
    blendMode: 'normal',
    order: 0,
    createdAt: '2026-06-01T10:00:00.000Z',
  },
  {
    id: 'layer-projected-pink',
    name: 'Projected pink highlights',
    type: 'projected',
    imageUrl:
      'https://images.unsplash.com/photo-1557682250-33bd709cbe85?auto=format&fit=crop&w=320&q=80',
    visible: true,
    opacity: 0.72,
    blendMode: 'soft-light',
    order: 1,
    createdAt: '2026-06-02T10:00:00.000Z',
  },
];
