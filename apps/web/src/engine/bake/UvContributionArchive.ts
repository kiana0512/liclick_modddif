import * as THREE from 'three';
import { uvTileIndex, uploadUvRgba, withUvRenderTarget, type UvContributionTiles } from './uvContributionTiles';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import { createId } from '@/utils/id';
import type { GpuLayerSourceSize } from './gpuUvBakeRenderer';

type Input = {
  color: THREE.WebGLRenderTarget;
  qualityTexture: THREE.Texture;
  sourceSize: GpuLayerSourceSize;
  tiles?: UvContributionTiles;
};
type Record = {
  bytes: Blob;
  width: number;
  height: number;
  compressed: boolean;
  sourceSize: GpuLayerSourceSize;
  tiles?: { data: Uint32Array<ArrayBuffer>; size: number; columns: number };
};

/** Session-owned, lossless spill tier. A known UV may fail restoration, but must
 * never silently fall through to projection. No project assets/commands change. */
export class UvContributionArchive {
  private readonly owner = createId();
  private known = new Set<string>();
  private db?: Promise<IDBDatabase>;
  private disposed = false;
  has(key: string) {
    return this.known.has(key);
  }
  private database() {
    return (this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('li3d-session-uv-contributions-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('uv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('UV contribution storage is blocked'));
    }));
  }
  private async access(key: string, value?: Record) {
    const db = await this.database();
    if (this.disposed) throw new DOMException('UV archive disposed', 'AbortError');
    return new Promise<Record | undefined>((resolve, reject) => {
      const tx = db.transaction('uv', value ? 'readwrite' : 'readonly'),
        store = tx.objectStore('uv');
      const request = value
        ? store.put(value, `${this.owner}:${key}`)
        : store.get(`${this.owner}:${key}`);
      tx.oncomplete = () => resolve(value ?? (request.result as Record | undefined));
      tx.onabort = tx.onerror = () => reject(tx.error ?? Error('UV contribution storage failed'));
    });
  }
  async store(key: string, input: Input, renderer: THREE.WebGLRenderer, check?: () => void) {
    if (this.has(key)) return;
    const { width, height } = input.color;
    const color = await read(renderer, input.color, check);
    const qualityTarget = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
      uniforms: {
        source: { value: input.qualityTexture },
        red: { value: input.qualityTexture.format === THREE.RedFormat },
      },
      vertexShader: 'in vec3 position;void main(){gl_Position=vec4(position,1.0);}',
      fragmentShader: `precision highp float;precision highp int;uniform sampler2D source;uniform bool red;
      out vec4 value;void main(){vec4 c=texelFetch(source,ivec2(gl_FragCoord.xy),0);value=vec4(red?c.r:c.a);}`,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    let quality: Uint8Array<ArrayBuffer>;
    try {
      withUvRenderTarget(renderer,qualityTarget,()=>renderer.render(mesh,new THREE.Camera()));
      quality = await read(renderer, qualityTarget, check);
    } finally {
      qualityTarget.dispose();
      geometry.dispose();
      material.dispose();
    }
    const raw = new Blob([color, quality]),
      compressed = typeof CompressionStream !== 'undefined';
    const bytes = compressed
      ? await new Response(raw.stream().pipeThrough(new CompressionStream('deflate'))).blob()
      : raw;
    check?.();
    await this.access(key, {
      bytes,
      width,
      height,
      compressed,
      sourceSize: input.sourceSize,
      tiles: input.tiles
        ? {
            data: (input.tiles.index.image.data as unknown as Uint32Array<ArrayBuffer>).slice(),
            size: input.tiles.index.image.width,
            columns: input.tiles.columns,
          }
        : undefined,
    });
    this.known.add(key);
  }
  async restore(key: string, renderer: THREE.WebGLRenderer, check?: () => void) {
    if (!this.has(key)) return;
    const record = await this.access(key);
    if (!record) throw Error('Saved UV contribution is missing; projection was not repeated.');
    const stream = record.compressed
      ? record.bytes.stream().pipeThrough(new DecompressionStream('deflate'))
      : record.bytes.stream();
    const bytes = await new Response(stream).arrayBuffer();
    const size = record.width * record.height * 4;
    if (bytes.byteLength !== size * 2) throw Error('Invalid saved UV contribution length');
    const textures: THREE.DataTexture[] = [];
    let tiles: UvContributionTiles | undefined;
    try {
      for (let offset = 0; offset < 2; offset++) {
        textures.push(await uploadUvRgba(renderer,new Uint8Array(bytes,offset*size,size),
          record.width,record.height,{check}));
      }
      check?.();
      if (record.tiles)
        tiles = {
          index: uvTileIndex(record.tiles.data, record.tiles.size, record.tiles.size),
          columns: record.tiles.columns,
        };
      return {
        color: textures[0],
        quality: textures[1],
        sourceSize: record.sourceSize,
        tiles,
        dispose() {
          textures.forEach((t) => t.dispose());
          tiles?.index.dispose();
        },
      };
    } catch (error) {
      textures.forEach((t) => t.dispose());
      tiles?.index.dispose();
      throw error;
    }
  }
  dispose() {
    this.disposed = true;
    this.known.clear();
    void this.db
      ?.then(
        (db) =>
          new Promise<void>((resolve) => {
            const tx = db.transaction('uv', 'readwrite');
            tx.objectStore('uv').delete(
              IDBKeyRange.bound(`${this.owner}:`, `${this.owner};`, false, true),
            );
            tx.oncomplete = tx.onabort = () => {
              db.close();
              resolve();
            };
          }),
      )
      .catch(() => {});
  }
}

async function read(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  check?: () => void,
) {
  const bytes = new Uint8Array(target.width * target.height * 4),
    rows = Math.max(1, Math.floor(1048576 / (target.width * 4)));
  for (let y = 0; y < target.height; y += rows) {
    check?.();
    const height = Math.min(rows, target.height - y),
      offset = y * target.width * 4;
    await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      y,
      target.width,
      height,
      bytes.subarray(offset, offset + height * target.width * 4),
    );
    await yieldToBrowserTask();
  }
  check?.();
  return bytes;
}
