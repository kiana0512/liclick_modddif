import type { ModelBoundingBox, Transform } from '@/types/model';

function validUnitScaleFactor(value?: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

/** Converts an FBX source-space box to a shared centimeter coordinate system. */
export function canonicalizeFbxBoundingBox(box: ModelBoundingBox, unitScaleFactor?: number) {
  const scale = validUnitScaleFactor(unitScaleFactor);
  if (scale === 1) return box;
  return {
    min: box.min.map((value) => value * scale) as ModelBoundingBox['min'],
    max: box.max.map((value) => value * scale) as ModelBoundingBox['max'],
    center: box.center.map((value) => value * scale) as ModelBoundingBox['center'],
    size: box.size.map((value) => value * scale) as ModelBoundingBox['size'],
  };
}

/** Maps a low/cage FBX source unit into the high-poly object's source coordinate system. */
export function bakeOverlayScale(
  highScale: Transform['scale'],
  highUnitScaleFactor?: number,
  overlayUnitScaleFactor?: number,
): Transform['scale'] {
  const ratio =
    validUnitScaleFactor(overlayUnitScaleFactor) / validUnitScaleFactor(highUnitScaleFactor);
  return highScale.map((value) => value * ratio) as Transform['scale'];
}
