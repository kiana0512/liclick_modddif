export type ImagePreviewDimensions = {
  width: number;
  height: number;
};

export function fitImagePreview(
  source: ImagePreviewDimensions,
  viewport: ImagePreviewDimensions,
  zoom = 1,
) {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: 0, height: 0, fitScale: 0 };
  }
  const fitScale = Math.min(viewport.width / source.width, viewport.height / source.height);
  const displayScale = fitScale * zoom;
  return {
    width: Math.max(1, Math.round(source.width * displayScale)),
    height: Math.max(1, Math.round(source.height * displayScale)),
    fitScale,
  };
}
