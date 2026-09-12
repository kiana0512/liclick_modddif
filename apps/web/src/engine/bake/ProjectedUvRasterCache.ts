import type * as THREE from 'three';
import { RedFormat } from 'three';
import type { GpuLayerSourceSize, GpuLayerRastersBakeOutput } from './gpuUvBakeRenderer';
import { ResidentQualityComposite } from './residentQualityComposite';
import { yieldToBrowserTask } from '@/utils/browserScheduling';

type Entry = {
  color: THREE.WebGLRenderTarget;
  quality?: THREE.WebGLRenderTarget;
  qualityTexture: THREE.Texture;
  sourceSize: GpuLayerSourceSize;
};

const entryBytes = (entry: Entry) => entry.color.width * entry.color.height *
  (entry.qualityTexture.format === RedFormat ? 5 : 8);
const disposeEntry = (entry: Entry) => {
  entry.color.dispose();
  if (entry.quality && entry.quality !== entry.color) entry.quality.dispose();
};

/** Derived, renderer-local full-resolution UV rasters. Never stores project assets.
 * Visibility changes reuse the exact quantized color/quality targets; all pixel
 * changes must change the key. A hard byte budget prevents unbounded VRAM growth.
 */
export class ProjectedUvRasterCache {
  private entries = new Map<string, Entry>();
  private renderer?: THREE.WebGLRenderer;
  private scope = '';
  private protectedKeys = new Set<string>();
  private bytes = 0;
  private disposed = false;
  private revision = 0;
  private resident?: ResidentQualityComposite;
  private residentKeys: string[] = [];
  private residentSourceSizes: GpuLayerSourceSize[] = [];
  private programs = new Map<string, THREE.ShaderMaterial>();
  private resolved = new Map<
    string,
    [result: GpuLayerRastersBakeOutput, bytes: number]
  >();
  private readonly contextLost = () => this.clear();
  constructor(private readonly budget = 256 * 1024 * 1024) {}

  prepare(renderer: THREE.WebGLRenderer, scope: string, keys: string[]) {
    if (this.disposed) throw new DOMException('UV raster owner disposed.', 'AbortError');
    if (renderer !== this.renderer || scope !== this.scope) {
      this.clear();
      this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost);
      this.renderer = renderer;
      this.scope = scope;
      renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
    }
    this.protectedKeys = new Set(keys);
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }
  releaseMaterial(material: THREE.ShaderMaterial) {
    const key = `${material.blending}:${material.depthTest}:${material.transparent}:${JSON.stringify(material.defines)}`;
    if (this.disposed || this.programs.has(key)) material.dispose();
    else this.programs.set(key, material);
  }
  async getResolved(key: string) {
    const entry = this.resolved.get(key);
    if (!entry) return undefined;
    this.resolved.delete(key);
    this.resolved.set(key, entry);
    const revision = this.revision;
    const result = await this.copyResolved(entry[0]);
    return !this.disposed &&
      revision === this.revision &&
      this.resolved.get(key) === entry
      ? result
      : undefined;
  }
  async retainResolved(key: string, result: GpuLayerRastersBakeOutput) {
    const base = result.residentQuality;
    if (!base) return;
    const bytes =
      base.imageData.data.byteLength + base.coverage.byteLength + base.renderedColorMask.byteLength;
    if (bytes > this.budget) return;
    const revision = this.revision;
    const copy = await this.copyResolved(result);
    if (this.disposed || revision !== this.revision) return;
    const existing = this.resolved.get(key);
    if (existing) {
      this.bytes -= existing[1];
      this.resolved.delete(key);
    }
    // Aggregate UV replaces individual rasters within the same hard budget.
    for (const [oldKey, old] of this.entries) {
      if (this.bytes + bytes <= this.budget) break;
      this.bytes -= entryBytes(old);
      disposeEntry(old);
      this.entries.delete(oldKey);
    }
    // Eye toggles most often alternate between exactly two authored states.
    // Retain both inside the existing hard byte budget; a third state evicts
    // the least recently used result before it can increase memory ownership.
    while (this.resolved.size >= 2 || this.bytes + bytes > this.budget) {
      const oldest = this.resolved.entries().next().value;
      if (!oldest) break;
      this.bytes -= oldest[1][1];
      this.resolved.delete(oldest[0]);
    }
    if (this.bytes + bytes > this.budget) return;
    this.resolved.set(key, [copy, bytes]);
    this.bytes += bytes;
  }
  private async copyResolved(result: GpuLayerRastersBakeOutput) {
    const base = result.residentQuality!;
    const color = new Uint8ClampedArray(base.imageData.data.length);
    const coverage = new Uint8Array(base.coverage.length);
    const mask = new Uint8Array(base.renderedColorMask.length);
    let started = performance.now();
    for (const [target, source] of [
      [color, base.imageData.data],
      [coverage, base.coverage],
      [mask, base.renderedColorMask],
    ]) {
      for (let offset = 0; offset < source.length; offset += 1048576) {
        target.set(source.subarray(offset, offset + 1048576), offset);
        if (performance.now() - started >= 4) {
          await yieldToBrowserTask();
          started = performance.now();
        }
      }
    }
    return {
      ...result,
      rasters: [],
      sourcePreparationWaitMs: 0,
      textureUploadMs: 0,
      layerReadbackWaitMs: 0,
      residentQuality: {
        ...base,
        imageData: new ImageData(color, base.imageData.width, base.imageData.height),
        coverage,
        renderedColorMask: mask,
        accumulateMs: 0,
        resolveMs: 0,
        totalMs: 0,
      },
    };
  }
  getResident(renderer: THREE.WebGLRenderer, resolution: number) {
    this.resident ??= new ResidentQualityComposite(renderer, resolution);
    this.residentKeys = [];
    this.residentSourceSizes = [];
    this.resident.reset();
    return this.resident;
  }
  leaseResident(renderer: THREE.WebGLRenderer, resolution: number, keys: string[]) {
    this.resident ??= new ResidentQualityComposite(renderer, resolution);
    const canResume = this.residentKeys.length > 0 &&
      this.residentKeys.length <= keys.length &&
      this.residentKeys.every((key, index) => key === keys[index]);
    const startIndex = canResume ? this.residentKeys.length : 0;
    const sourceSizes = canResume ? this.residentSourceSizes.slice() : [];
    // The current candidate targets are leased to this calculation. If it is
    // cancelled or fails, no later request may treat the partial targets as a
    // completed prefix.
    this.residentKeys = [];
    this.residentSourceSizes = [];
    if (!canResume) this.resident.reset();
    return { composite: this.resident, startIndex, sourceSizes };
  }
  commitResident(keys: string[], sourceSizes: GpuLayerSourceSize[]) {
    if (this.disposed || keys.length !== sourceSizes.length) return;
    this.residentKeys = keys.slice();
    this.residentSourceSizes = sourceSizes.slice();
  }
  take(key: string, entry: Entry) {
    const bytes = entryBytes(entry);
    if (this.disposed || bytes > this.budget || this.entries.has(key)) return false;
    for (const [oldKey, old] of this.entries) {
      if (this.bytes + bytes <= this.budget) break;
      if (this.protectedKeys.has(oldKey)) continue;
      this.bytes -= entryBytes(old);
      disposeEntry(old);
      this.entries.delete(oldKey);
    }
    if (this.bytes + bytes > this.budget) return false;
    this.entries.set(key, entry);
    this.bytes += bytes;
    return true;
  }
  private clear() {
    this.revision++;
    this.programs.forEach((material) => material.dispose());
    this.programs.clear();
    this.resident?.dispose();
    this.resident = undefined;
    this.residentKeys = [];
    this.residentSourceSizes = [];
    for (const entry of this.entries.values()) {
      disposeEntry(entry);
    }
    this.entries.clear();
    this.resolved.clear();
    this.bytes = 0;
  }
  dispose() {
    this.disposed = true;
    this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer = undefined;
    this.clear();
  }
}
