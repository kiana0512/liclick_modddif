import type { Project } from '@/types/project';
import { mockLayers } from './mockLayers';
import { mockReferences } from './mockReferences';

const now = '2026-06-18T09:00:00.000Z';

export const mockProjects: Project[] = [
  {
    id: 'project-orchid-speaker',
    name: 'Orchid Speaker Concept',
    createdAt: '2026-06-10T09:00:00.000Z',
    updatedAt: now,
    thumbnail:
      'https://images.unsplash.com/photo-1618005198919-d3d4b5a92ead?auto=format&fit=crop&w=640&q=80',
    objects: [
      {
        id: 'object-demo-capsule',
        name: 'Demo capsule mesh',
        type: 'mesh',
        format: 'primitive',
        materialSlots: [{ id: 'mat-01', name: 'Main surface', baseColor: '#b9a3ff' }],
        uvSets: ['UV0'],
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        visible: true,
        selected: true,
      },
    ],
    references: mockReferences,
    captures: [],
    generations: [],
    layers: mockLayers,
    bakedTextures: [],
    workspaceMode: 'none',
    dirty: false,
    settings: {
      resolution: '2K',
      displayMode: 'pbr',
      projectionMode: 'perspective',
      colorManagement: 'srgb',
    },
  },
  {
    id: 'project-glossy-toy',
    name: 'Glossy Toy Material Pass',
    createdAt: '2026-06-12T09:00:00.000Z',
    updatedAt: '2026-06-17T16:30:00.000Z',
    thumbnail:
      'https://images.unsplash.com/photo-1634712282287-14ed57b9cc89?auto=format&fit=crop&w=640&q=80',
    objects: [],
    references: [],
    captures: [],
    generations: [],
    layers: mockLayers.slice(0, 1),
    bakedTextures: [],
    workspaceMode: 'none',
    dirty: false,
    settings: {
      resolution: '1K',
      displayMode: 'pbr',
      projectionMode: 'perspective',
      colorManagement: 'srgb',
    },
  },
];
