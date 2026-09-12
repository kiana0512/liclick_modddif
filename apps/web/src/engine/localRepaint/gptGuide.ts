// GPT-REPAINT-GUIDE/1.0.0. This guide is NOT the UV write authorization mask.
// Coverage comes from the renderer, never from color (white textures are valid).
export function composeGptRepaintGuide(
  current: Uint8ClampedArray,
  clay: Uint8ClampedArray,
  authoredMask: Uint8ClampedArray,
) {
  if (current.length !== clay.length || current.length !== authoredMask.length || current.length % 4)
    throw new Error('GPT repaint guide dimensions differ.');
  const output = new Uint8ClampedArray(current);
  for (let offset = 0; offset < current.length; offset += 4) {
    const selected = authoredMask[offset + 3] > 0 && Math.max(
      authoredMask[offset], authoredMask[offset + 1], authoredMask[offset + 2],
    ) > 0;
    // Hard clay replacement avoids retaining dark/striped partial-coverage pixels.
    // The aligned clay pass also preserves the background and silhouette.
    if (selected || current[offset + 3] < 255) {
      output[offset] = clay[offset];
      output[offset + 1] = clay[offset + 1];
      output[offset + 2] = clay[offset + 2];
      output[offset + 3] = clay[offset + 3];
    }
  }
  return output;
}
