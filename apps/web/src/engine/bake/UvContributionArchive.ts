import * as THREE from 'three';
import { uvTileIndex, uploadUvRed, uploadUvRgba, withUvRenderTarget, type UvContributionTiles } from './uvContributionTiles';
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
  qualityChannels?: 1 | 4;
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
    // WebGLRenderer's asynchronous readback accepts RGBA targets only. Pack
    // four canonical R8 values into each RGBA texel instead of expanding every
    // quality value to four identical bytes.
    const qualityTarget = new THREE.WebGLRenderTarget(Math.ceil(width / 4), height, {
      depthBuffer: false,
    });
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
      out vec4 value;float q(ivec2 p){if(p.x>=textureSize(source,0).x)return 0.0;
      vec4 c=texelFetch(source,p,0);return red?c.r:c.a;}
      void main(){ivec2 p=ivec2(gl_FragCoord.xy);p.x*=4;
      value=vec4(q(p),q(p+ivec2(1,0)),q(p+ivec2(2,0)),q(p+ivec2(3,0)));}`,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    let quality: Uint8Array<ArrayBuffer>;
    try {
      withUvRenderTarget(renderer,qualityTarget,()=>renderer.render(mesh,new THREE.Camera()));
      const packedQuality = await read(renderer, qualityTarget, check);
      if (width % 4 === 0) quality = packedQuality;
      else {
        quality = new Uint8Array(width * height);
        const stride = qualityTarget.width * 4;
        for (let y = 0; y < height; y++)
          quality.set(packedQuality.subarray(y * stride, y * stride + width), y * width);
      }
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
      qualityChannels: 1,
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
    const size = record.width * record.height * 4,
      qualityChannels = record.qualityChannels ?? 4,
      qualitySize = record.width * record.height * qualityChannels;
    if (bytes.byteLength !== size + qualitySize) throw Error('Invalid saved UV contribution length');
    const textures: THREE.DataTexture[] = [];
    let tiles: UvContributionTiles | undefined;
    try {
      textures.push(await uploadUvRgba(renderer,new Uint8Array(bytes,0,size),
        record.width,record.height,{check}));
      textures.push(qualityChannels === 1
        ? await uploadUvRed(renderer,new Uint8Array(bytes,size,qualitySize),record.width,record.height,{check})
        : await uploadUvRgba(renderer,new Uint8Array(bytes,size,qualitySize),record.width,record.height,{check}));
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
