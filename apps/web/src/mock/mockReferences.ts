import type { ReferenceImage } from '@/types/project';

export const mockReferences: ReferenceImage[] = [
  {
    id: 'ref-marble-01',
    name: 'Soft lilac ceramic',
    url: 'https://images.unsplash.com/photo-1618220179428-22790b461013?auto=format&fit=crop&w=640&q=80',
    width: 640,
    height: 427,
    isPrimary: true,
  },
  {
    id: 'ref-fabric-01',
    name: 'Textile grain',
    url: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=640&q=80',
    width: 640,
    height: 960,
    isPrimary: false,
  },
];
