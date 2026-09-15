import type * as THREE from 'three';
import { RedFormat } from 'three';
import type { GpuLayerSourceSize } from './gpuUvBakeRenderer';
import { ResidentQualityComposite } from './residentQualityComposite';
import { compactUvContribution, type UvContributionTiles } from './uvContributionTiles';
import { UvContributionArchive } from './UvContributionArchive';

type Entry = {
  color: THREE.WebGLRenderTarget;
  quality?: THREE.WebGLRenderTarget;
  qualityTexture: THREE.Texture;
  sourceSize: GpuLayerSourceSize;
  tiles?: UvContributionTiles;
};

type ResidentState = {
  keys: string[];
  sourceSizes: GpuLayerSourceSize[];
};

const entryBytes = (entry: Entry) => entry.color.width * entry.color.height *
  (entry.qualityTexture.format === RedFormat ? 5 : 8) + (entry.tiles?.index.image.data.byteLength ?? 0);
const disposeEntry = (entry: Entry) => {
  entry.color.dispose();
  if (entry.quality && entry.quality !== entry.color) entry.quality.dispose();
  entry.tiles?.index.dispose();
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
  private archive = new UvContributionArchive();
  private resident?: ResidentQualityComposite;
  private residentStates = new Map<number, ResidentState>();
  private residentWorkingStates = new Map<number, ResidentState>();
  private programs = new Map<string, THREE.ShaderMaterial>();
  private readonly contextLost = () => this.clear();
  constructor(private readonly budget = 256 * 1024 * 1024, private readonly contributions = false) {}

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
  getResident(renderer: THREE.WebGLRenderer, resolution: number) {
    this.prepareResident(renderer, resolution);
    this.residentStates.clear();
    this.residentWorkingStates.clear();
    this.resident!.reset();
    return this.resident!;
  }
  private prepareResident(renderer: THREE.WebGLRenderer, resolution: number) {
    if (this.resident?.resolution !== resolution) {
      this.resident?.dispose();
      this.resident = new ResidentQualityComposite(renderer, resolution);
      this.residentStates.clear(); this.residentWorkingStates.clear();
    }
  }
  leaseResident(renderer: THREE.WebGLRenderer, resolution: number, keys: string[]) {
    this.prepareResident(renderer, resolution);
    const resident = this.resident!;
    let matched: [number, ResidentState] | undefined;
    for (const state of this.residentStates) {
      if (state[1].keys.length > keys.length) continue;
      if (!state[1].keys.every((key, index) => key === keys[index])) continue;
      if (!matched || state[1].keys.length > matched[1].keys.length) matched = state;
    }
    const startIndex = matched?.[1].keys.length ?? 0;
    const sourceSizes = matched?.[1].sourceSizes.slice() ?? [];
    // The current candidate targets are leased to this calculation. If it is
    // cancelled or fails, no later request may treat the partial targets as a
    // completed prefix.
    this.residentWorkingStates = new Map(this.residentStates);
    this.residentStates.clear();
    if (matched) resident.selectSlot(matched[0]);
    else {
      this.residentWorkingStates.clear();
      resident.reset();
    }
    return { composite: resident, startIndex, sourceSizes };
  }
  recordResidentState(keys: string[], sourceSizes: GpuLayerSourceSize[]) {
    if (!this.resident || keys.length !== sourceSizes.length) return;
    this.residentWorkingStates.set(this.resident.getCurrentSlot(), {
      keys: keys.slice(),
      sourceSizes: sourceSizes.slice(),
    });
  }
  commitResident(keys: string[], sourceSizes: GpuLayerSourceSize[]) {
    if (this.disposed || keys.length !== sourceSizes.length) return;
    if (this.resident) {
      this.residentWorkingStates.set(this.resident.getCurrentSlot(), {
        keys: keys.slice(), sourceSizes: sourceSizes.slice(),
      });
    }
    this.residentStates.clear();
    for (const [slot, state] of this.residentWorkingStates) {
      if (
        state.keys.length <= keys.length &&
        state.keys.every((key, index) => key === keys[index])
      ) this.residentStates.set(slot, state);
    }
    this.residentWorkingStates.clear();
  }
  take(key: string, entry: Entry) {
    const bytes = entryBytes(entry);
    if (this.disposed || bytes > this.budget || this.entries.has(key)) return false;
    for (const [oldKey, old] of this.entries) {
      if (this.bytes + bytes <= this.budget) break;
      if (this.protectedKeys.has(oldKey)) continue;
      if (this.contributions && !this.archive.has(oldKey)) continue;
      this.bytes -= entryBytes(old);
      disposeEntry(old);
      this.entries.delete(oldKey);
    }
    if (this.bytes + bytes > this.budget) return false;
    this.entries.set(key, entry);
    this.bytes += bytes;
    return true;
  }
  async retainContribution(key: string, entry: Entry, resolution: number, checkCancelled?: () => void) {
    if (!this.contributions) return this.take(key, entry);
    const revision = this.revision;
    const check = () => {
      checkCancelled?.();
      if (this.disposed || revision !== this.revision) throw new DOMException('UV contribution owner changed.', 'AbortError');
    };
    const compact = await compactUvContribution(this.renderer!, entry.color.texture,
      entry.qualityTexture, resolution, check);
    const contribution = compact ? {...compact, sourceSize:entry.sourceSize} : entry;
    let retained = false;
    try {
      check();
      const bytes = entryBytes(contribution);
      // Spill before eviction. A visibility change never loses its quantized UV input.
      for (const [oldKey, old] of this.entries) {
        if (this.bytes + bytes <= this.budget) break;
        if (this.protectedKeys.has(oldKey)) continue;
        await this.archive.store(oldKey, old, this.renderer!, check);
        check();this.bytes -= entryBytes(old);disposeEntry(old);this.entries.delete(oldKey);
      }
      retained = this.take(key, contribution);
      if (!retained) { await this.archive.store(key, contribution, this.renderer!, check); check(); }
      document.body.dataset.residentUvContributionBytes = String(this.bytes);
      document.body.dataset.residentUvContributionCount = String(this.entries.size);
      return retained && !compact;
    } finally {
      if (compact && !retained) disposeEntry(contribution);
    }
  }
  hasArchivedContribution(key: string) { return this.contributions && this.archive.has(key); }
  async restoreContribution(key: string, checkCancelled?: () => void) {
    const revision=this.revision;
    return this.archive.restore(key,this.renderer!,()=>{
      checkCancelled?.();
      if(this.disposed || revision!==this.revision)throw new DOMException('UV contribution owner changed.','AbortError');
    });
  }
  private clear() {
    this.revision++;
    this.archive.dispose();this.archive = new UvContributionArchive();
    this.programs.forEach((material) => material.dispose());
    this.programs.clear();
    this.resident?.dispose();
    this.resident = undefined;
    this.residentStates.clear();
    this.residentWorkingStates.clear();
    for (const entry of this.entries.values()) {
      disposeEntry(entry);
    }
    this.entries.clear();
    this.bytes = 0;
  }
  dispose() {
    this.disposed = true;
    this.renderer?.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer = undefined;
    this.clear();
  }
}
