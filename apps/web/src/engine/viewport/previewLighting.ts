import * as THREE from 'three';
import type { ProjectionPreviewLighting } from '@/engine/projection/projectionTypes';

export function getPreviewLighting(input: {
  displayMode: string;
  environmentPreset: 'color' | 'studio' | 'soft' | 'dark';
  exposure: number;
  pbrEnvironmentIntensity: number;
  pbrKeyLightIntensity: number;
  pbrLightAzimuth: number;
}): ProjectionPreviewLighting {
  const effectivePreset =
    input.displayMode === 'pbr' && input.environmentPreset === 'color'
      ? 'studio'
      : input.environmentPreset;
  const environmentBase =
    effectivePreset === 'dark' ? 0.38 : effectivePreset === 'soft' ? 0.46 : 0.5;
  const keyBase = effectivePreset === 'dark' ? 1.05 : effectivePreset === 'soft' ? 1.12 : 1.22;
  const environmentScale = input.displayMode === 'pbr' ? input.pbrEnvironmentIntensity / 0.42 : 1;
  const azimuth = THREE.MathUtils.degToRad(input.pbrLightAzimuth);
  const direction = new THREE.Vector3(
    Math.sin(azimuth) * 4.5,
    5.2,
    Math.cos(azimuth) * 4.5,
  ).normalize();
  return {
    enabled: input.displayMode === 'pbr',
    exposure: input.exposure,
    ambientIntensity: environmentBase * input.exposure * environmentScale,
    keyLightIntensity:
      keyBase * input.exposure * (input.displayMode === 'pbr' ? input.pbrKeyLightIntensity : 1),
    keyLightDirection: direction.toArray() as [number, number, number],
  };
}
