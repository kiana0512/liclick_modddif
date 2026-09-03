export type StrokeTile<Bounds, Pixels> = { bounds: Bounds; before: Pixels; after: Pixels };

// Replay each stroke from the earliest tile checkpoint, never attribute a batch
// to its last stroke. All pixels/history stay private until the caller publishes.
export async function stageRefinedStrokeHistory<Bounds, Pixels>(options: {
  histories: Array<Array<StrokeTile<Bounds, Pixels>>>;
  bounds: Bounds[];
  key: (bounds: Bounds) => string;
  read: (bounds: Bounds) => Pixels;
  copy: (pixels: Pixels) => Pixels;
  affects: (stroke: number, bounds: Bounds) => boolean;
  isApplied?: (stroke: number) => boolean;
  apply: (stroke: number, pixels: Pixels, bounds: Bounds) => void;
  yieldWork: () => Promise<void>;
  isCurrent: () => boolean;
}) {
  const { histories, key, copy } = options;
  const maps = histories.map((tiles) => new Map(tiles.map((tile) => [key(tile.bounds), tile])));
  const updates = histories.map(() => [] as Array<StrokeTile<Bounds, Pixels>>);
  const output: Array<{ bounds: Bounds; pixels: Pixels }> = [];
  for (const bounds of options.bounds) {
    if (!options.isCurrent()) return undefined;
    const tileKey = key(bounds);
    const first = maps.find((map) => map.has(tileKey))?.get(tileKey);
    const pixels = copy(first ? first.before : options.read(bounds));
    let visible = copy(pixels);
    for (let index = 0; index < histories.length; index += 1) {
      if (!maps[index].has(tileKey) && !options.affects(index, bounds)) continue;
      const before = copy(pixels);
      options.apply(index, pixels, bounds);
      updates[index].push({ bounds, before, after: copy(pixels) });
      if (options.isApplied?.(index) !== false) visible = copy(pixels);
    }
    output.push({ bounds, pixels: visible });
    if (output.length % 4 === 0) await options.yieldWork();
  }
  if (!options.isCurrent()) return undefined;
  return { updates, output };
}
