// UV-GUTTER-TOPOLOGY/3: non-antialiased pixel-centre coverage, with the
// eight subpixel bits and top-left edge rule used by the UV render pass.
// Area coverage from Canvas2D is not a membership test at atlas boundaries.
export function rasterizeUvTriangleCenters(
  mask: Uint8Array, width: number, height: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
) {
  if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) return;
  ax = Math.round(ax * 256); ay = Math.round(ay * 256);
  bx = Math.round(bx * 256); by = Math.round(by * 256);
  cx = Math.round(cx * 256); cy = Math.round(cy * 256);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (!area) return;
  if (area < 0) { [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; }
  const left = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - 128) / 256));
  const right = Math.min(width - 1, Math.floor((Math.max(ax, bx, cx) - 128) / 256));
  const top = Math.max(0, Math.ceil((Math.min(ay, by, cy) - 128) / 256));
  const bottom = Math.min(height - 1, Math.floor((Math.max(ay, by, cy) - 128) / 256));
  const ab = by < ay || (by === ay && bx > ax);
  const bc = cy < by || (cy === by && cx > bx);
  const ca = ay < cy || (ay === cy && ax > cx);
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const px = x * 256 + 128, py = y * 256 + 128;
    const a = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const b = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    const c = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    if ((a > 0 || (a === 0 && ab)) && (b > 0 || (b === 0 && bc)) &&
        (c > 0 || (c === 0 && ca))) mask[y * width + x] = 1;
  }
}
