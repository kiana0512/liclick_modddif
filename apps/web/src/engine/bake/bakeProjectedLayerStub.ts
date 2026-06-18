import type { UvBakeRequest, UvBakeResult } from './uvBakeTypes';

export async function bakeProjectedLayerStub(request: UvBakeRequest): Promise<UvBakeResult> {
  return {
    url: '',
    width: request.resolution,
    height: request.resolution,
    createdAt: new Date().toISOString(),
  };
}
