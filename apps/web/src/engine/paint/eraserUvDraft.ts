type Rect = { x: number; y: number; width: number; height: number };
type Owner = { objectId: string; layerId: string; target: string; paintCanvas: HTMLCanvasElement;
  pendingPaintCommits: number };
let serial = 0;
let current: EraserUvDraft | undefined;

function canvas(width: number, height: number) {
  const result = document.createElement('canvas');
  result.width = width; result.height = height;
  if (!result.getContext('2d')) throw new Error('Cannot prepare eraser UV preview.');
  return result;
}
function copy(source: HTMLCanvasElement) {
  const result = canvas(source.width, source.height);
  result.getContext('2d')!.drawImage(source, 0, 0);
  return result;
}

/** Shared by the interactive draft and the durable history commit. */
export function applyEraserUvPatch(context: CanvasRenderingContext2D,
  patch: HTMLCanvasElement, bounds: Rect, projected: boolean, erase = true) {
  context.save();
  context.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  context.drawImage(patch, 0, 0, patch.width, patch.height,
    bounds.x, bounds.y, bounds.width, bounds.height);
  if (erase && projected) {
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#000000';
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
  context.restore();
}

/** Renderer-only full-resolution draft. Never writes LayerStore or history. */
export class EraserUvDraft {
  readonly id = ++serial;
  readonly image: HTMLCanvasElement;
  revision = 0;
  dirtyBounds?: Rect;
  private base?: HTMLCanvasElement;
  private pending?: { source: HTMLCanvasElement; bounds: Rect };
  private disposed = false;
  get drawing() { return Boolean(this.base); }
  constructor(readonly owner: Owner, source: HTMLCanvasElement) {
    this.image = copy(source);
  }
  begin() {
    this.flush();
    this.base = copy(this.image);
  }
  update(source: HTMLCanvasElement, bounds: Rect) {
    if (!this.base || this.disposed) return;
    this.pending = { source, bounds: { ...bounds } };
    // The single-flight compositor consumes this union when it is ready. Do
    // not redraw a full-resolution draft for input that it cannot yet display.
    this.revision++;
  }
  flush() {
    const pending = this.pending; this.pending = undefined;
    if (!pending || !this.base || this.disposed) return;
    const { source, bounds } = pending;
    // Copy exactly the same cropped union as pointer-up, including its filter
    // boundary. Reapply to the gesture base, never repeatedly erase feather.
    const patch = canvas(bounds.width, bounds.height);
    patch.getContext('2d')!.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height);
    const sx = this.image.width / source.width, sy = this.image.height / source.height;
    const x = Math.max(0, Math.floor(bounds.x * sx)), y = Math.max(0, Math.floor(bounds.y * sy));
    const region = { x, y,
      width: Math.max(1, Math.min(this.image.width, Math.ceil((bounds.x + bounds.width) * sx)) - x),
      height: Math.max(1, Math.min(this.image.height, Math.ceil((bounds.y + bounds.height) * sy)) - y) };
    const old = this.dirtyBounds;
    this.dirtyBounds = old ? { x: Math.min(old.x, x), y: Math.min(old.y, y),
      width: Math.max(old.x + old.width, x + region.width) - Math.min(old.x, x),
      height: Math.max(old.y + old.height, y + region.height) - Math.min(old.y, y) } : region;
    const context = this.image.getContext('2d')!;
    context.clearRect(x, y, region.width, region.height);
    context.drawImage(this.base, x, y, region.width, region.height, x, y, region.width, region.height);
    applyEraserUvPatch(context, patch, region, this.owner.target === 'projected-mask');
    patch.width = patch.height = 1;
  }
  finishStroke() { this.flush(); if (this.base) this.base.width = this.base.height = 1; this.base = undefined; }
  snapshot() {
    this.flush();
    return copy(this.image);
  }
  dispose() {
    this.disposed = true;
    this.pending = undefined;
    this.image.width = this.image.height = 1;
    if (this.base) this.base.width = this.base.height = 1;
  }
}

export function getEraserUvDraft(owner?: object) {
  return !owner || current?.owner === owner ? current : undefined;
}
export function clearEraserUvDraft(owner: object) {
  if (current?.owner !== owner) return;
  current.dispose(); current = undefined;
}
export function beginEraserUvDraft(owner: Owner) {
  if (current?.owner !== owner || owner.pendingPaintCommits === 0) {
    current?.dispose(); current = new EraserUvDraft(owner, owner.paintCanvas);
  }
  current!.begin();
}
