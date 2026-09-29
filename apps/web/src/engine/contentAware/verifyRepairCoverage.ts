/** Verify selected texels after Worker transfer/accumulation, before publishing.
 * O(N), no extra RGBA copy; ambiguous/outside-atlas texels are not selected.
 * This checks full-resolution coverage, not arbitrary mip levels or RGB seams.
 */
export async function countUncoveredRepairTargets(
  targets: Uint8Array,
  rgba: Uint8ClampedArray,
  signal?: AbortSignal,
): Promise<number> {
  if (rgba.length !== targets.length * 4) throw new RangeError('Repair coverage dimensions differ.');
  let missing = 0;
  for (let start = 0; start < targets.length; start += 262144) {
    signal?.throwIfAborted();
    const end = Math.min(targets.length, start + 262144);
    for (let i = start; i < end; i += 1) {
      if (targets[i] && rgba[i * 4 + 3] !== 255) missing += 1;
    }
    if (end < targets.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return missing;
}
