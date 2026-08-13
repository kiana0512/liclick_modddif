import type { ModelBoundingBox, ModelFormat, Transform } from '@/types/model';

/**
 * Returns physical centimeters represented by one source-space unit.
 *
 * Older projects do not persist this field for GLB/GLTF, so format is kept as
 * a deterministic fallback. OBJ is intentionally left at 1 because the format
 * does not define a physical unit.
 */
export function bakeSourceUnitScaleFactor(format?: ModelFormat, unitScaleFactor?: number) {
  if (unitScaleFactor !== undefined && Number.isFinite(unitScaleFactor) && unitScaleFactor > 0) {
    return unitScaleFactor;
  }
  return format === 'glb' || format === 'gltf' ? 100 : 1;
}

/** Converts source-space bounds to Li3D's shared centimeter bake space. */
export function canonicalizeBakeBoundingBox(
  box: ModelBoundingBox,
  format?: ModelFormat,
  unitScaleFactor?: number,
) {
  const scale = bakeSourceUnitScaleFactor(format, unitScaleFactor);
  if (scale === 1) return box;
  return {
    min: box.min.map((value) => value * scale) as ModelBoundingBox['min'],
    max: box.max.map((value) => value * scale) as ModelBoundingBox['max'],
    center: box.center.map((value) => value * scale) as ModelBoundingBox['center'],
    size: box.size.map((value) => value * scale) as ModelBoundingBox['size'],
  };
}

/**
 * Applies physical units only when the high mesh has not already been import-
 * normalized. Normalized models are already fitted to their target size.
 */
export function bakeHighDisplayScale(
  highScale: Transform['scale'],
  highFormat?: ModelFormat,
  highUnitScaleFactor?: number,
  highWasNormalized = true,
): Transform['scale'] {
  if (highWasNormalized) return highScale;
  const scale = bakeSourceUnitScaleFactor(highFormat, highUnitScaleFactor);
  return highScale.map((value) => value * scale) as Transform['scale'];
}

/** Maps a low/cage source unit into the displayed high-poly coordinate system. */
export function bakeOverlayScale(
  highScale: Transform['scale'],
  highFormat?: ModelFormat,
  highUnitScaleFactor?: number,
  highWasNormalized = true,
  overlayFormat?: ModelFormat,
  overlayUnitScaleFactor?: number,
): Transform['scale'] {
  const displayedHighScale = bakeHighDisplayScale(
    highScale,
    highFormat,
    highUnitScaleFactor,
    highWasNormalized,
  );
  const ratio =
    bakeSourceUnitScaleFactor(overlayFormat, overlayUnitScaleFactor) /
    bakeSourceUnitScaleFactor(highFormat, highUnitScaleFactor);
  return displayedHighScale.map((value) => value * ratio) as Transform['scale'];
}
