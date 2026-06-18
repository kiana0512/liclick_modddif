export type UvBakeResolution = 1024 | 2048 | 4096;

export type UvBakeRequest = {
  objectId: string;
  layerIds: string[];
  resolution: UvBakeResolution;
  output: 'basecolor' | 'normal' | 'mask';
};

export type UvBakeResult = {
  url: string;
  width: UvBakeResolution;
  height: UvBakeResolution;
  createdAt: string;
};
