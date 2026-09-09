// Frozen b3431cb cleanup oracle.
const UNPROJECTED_TEXTURE_FILL=[8,9,13], MIN_TRANSPARENT_OUTPUT_ALPHA=8, BAKE_PIXELS_PER_YIELD=32768;
const yieldToBakeUi=async()=>{};
export async function fillTransparentTexelsForViewport(imageData) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (offset > 0 && offset % (BAKE_PIXELS_PER_YIELD * 4) === 0) {
      await yieldToBakeUi();
    }
    if (imageData.data[offset + 3] !== 0) continue;
    imageData.data[offset] = UNPROJECTED_TEXTURE_FILL[0];
    imageData.data[offset + 1] = UNPROJECTED_TEXTURE_FILL[1];
    imageData.data[offset + 2] = UNPROJECTED_TEXTURE_FILL[2];
    imageData.data[offset + 3] = 255;
  }
}

export async function clearWeakTransparentTexels(imageData, coverage) {
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    if (offset > 0 && offset % (BAKE_PIXELS_PER_YIELD * 4) === 0) {
      await yieldToBakeUi();
    }
    if (imageData.data[offset + 3] > MIN_TRANSPARENT_OUTPUT_ALPHA) continue;
    const pixelIndex = offset / 4;
    // `padUvIslandGutters(..., 'rgb-only')` marks filter-only gutter texels
    // with coverage value 2. Keep their hidden RGB while alpha remains zero.
    if (imageData.data[offset + 3] === 0 && coverage?.[pixelIndex] === 2) continue;
    imageData.data[offset] = 0;
    imageData.data[offset + 1] = 0;
    imageData.data[offset + 2] = 0;
    imageData.data[offset + 3] = 0;
    // Keep the logical coverage mask in lockstep with the exported alpha.
    // Otherwise an alpha<=8 edge sample is treated as a valid wall/donor by
    // the UV-hole pass and is only erased afterwards, leaving 1px cracks in
    // the final PNG even though coverage still says that texel is occupied.
    if (coverage) coverage[pixelIndex] = 0;
  }
}

