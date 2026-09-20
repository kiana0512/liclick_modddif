import * as THREE from 'three';
import { yieldToBrowserTask } from '@/utils/browserScheduling';

// UV-LAYER-CONTRIBUTION/1.0.4: lossless 64² tiles of quantized UV color + quality.
// Alpha 1..5 still contributes to coverage counts, so only alpha == 0 is absent.
export type UvContributionTiles = { index: THREE.DataTexture; columns: number };

/** Exact RGBA rows, bounded transfers, no full-frame ImageBitmap/Worker roundtrip. */
type UvUploadOptions = {flipRows?: boolean; beforeStripe?: () => Promise<void>;
  check?: () => void; configure?: (texture: THREE.DataTexture) => void};

async function uploadUvBytes(renderer: THREE.WebGLRenderer,
  pixels: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>, width: number, height: number,
  bytesPerPixel: 1 | 4, format: THREE.PixelFormat, options: UvUploadOptions = {}) {
  const texture=new THREE.DataTexture(null,width,height,format);
  texture.unpackAlignment=1;
  options.configure?.(texture);texture.source.dataReady=false;texture.needsUpdate=true;
  const rows=Math.max(1,Math.floor(1048576/(width*bytesPerPixel))),rowBytes=width*bytesPerPixel;
  try {
    await options.beforeStripe?.();options.check?.();
    const allocationStarted=performance.now();renderer.initTexture(texture);
    const allocationMs=performance.now()-allocationStarted;
    let maximumStripeMs=0,copyMs=0;
    let started=performance.now();
    for(let y=0;y<height;y+=rows) {
      await options.beforeStripe?.();options.check?.();
      const count=Math.min(rows,height-y);
      let data: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>;
      if(options.flipRows) {
        data=new Uint8Array(count*rowBytes);
        for(let row=0;row<count;row++) {
          const offset=(height-1-y-row)*rowBytes;
          data.set(pixels.subarray(offset,offset+rowBytes),row*rowBytes);
        }
      } else data=pixels.subarray(y*rowBytes,(y+count)*rowBytes);
      const stripe=new THREE.DataTexture(data,width,count,format);
      stripe.unpackAlignment=1;
      const copyStarted=performance.now();
      try {renderer.copyTextureToTexture(stripe,texture,null,new THREE.Vector2(0,y));}
      finally {stripe.dispose();}
      const elapsed=performance.now()-copyStarted;
      copyMs+=elapsed;maximumStripeMs=Math.max(maximumStripeMs,elapsed);
      if(performance.now()-started>=4) {await yieldToBrowserTask();started=performance.now();}
    }
    options.check?.();
    if(typeof document!=='undefined') document.body.dataset.residentUvUploadStages=JSON.stringify({allocationMs,copyMs,maximumStripeMs});
    return texture;
  } catch(error) {texture.dispose();throw error;}
}

/** Exact RGBA rows, bounded transfers, no full-frame ImageBitmap/Worker roundtrip. */
export function uploadUvRgba(renderer: THREE.WebGLRenderer,
  pixels: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>, width: number, height: number,
  options: UvUploadOptions = {}) {
  return uploadUvBytes(renderer,pixels,width,height,4,THREE.RGBAFormat,options);
}

/** UV-CONTRIBUTION-ARCHIVE/1.1.0: quality remains its canonical one-byte R8 value. */
export function uploadUvRed(renderer: THREE.WebGLRenderer, pixels: Uint8Array<ArrayBuffer>,
  width: number, height: number, options: UvUploadOptions = {}) {
  return uploadUvBytes(renderer,pixels,width,height,1,THREE.RedFormat,options);
}
const vertexShader = `precision highp float; in vec3 position;
void main(){gl_Position=vec4(position,1.0);}`;
const header = `precision highp float; precision highp int; precision highp usampler2D;
uniform sampler2D source; uniform sampler2D quality;
uniform usampler2D tileMap; uniform bool first; uniform bool qualityIsRed;
uniform int columns; uniform int sourceColumns;`;
const reduceShader = `${header}
layout(location=0) out vec4 result;
void main(){
  ivec2 start=ivec2(gl_FragCoord.xy)*8, size=textureSize(source,0);
  float occupied=0.0;
  for(int y=0;y<8;y++)for(int x=0;x<8;x++){
    ivec2 p=start+ivec2(x,y);
    if(any(greaterThanEqual(p,size)))continue;
    vec4 c=texelFetch(source,p,0);
    if((first?c.a:c.r)>0.0)occupied=1.0;
  }
  result=vec4(occupied);
}`;
const packShader = `${header}
layout(location=0) out vec4 colorOut; layout(location=1) out vec4 qualityOut;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy), tile=p/64;
  uint address=texelFetch(tileMap,tile,0).r;
  colorOut=vec4(0.0);qualityOut=vec4(0.0);
  if(address==0u)return;
  int n=int(address)-1;
  ivec2 q=ivec2(n%sourceColumns,n/sourceColumns)*64+p%64;
  if(any(greaterThanEqual(q,textureSize(source,0))))return;
  colorOut=texelFetch(source,q,0);
  vec4 v=texelFetch(quality,q,0);
  qualityOut=vec4(qualityIsRed?v.r:v.a);
}`;
export function uvTileIndex(data: Uint32Array<ArrayBuffer>, width: number, height: number) {
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedIntegerFormat,
    THREE.UnsignedIntType,
  );
  texture.internalFormat = 'R32UI';
  texture.needsUpdate = true;
  return texture;
}

/** Owns only scratch targets; returned atlas and index are transferred to the cache.
 * All awaits occur after restoring renderer state. No source asset is re-encoded.
 */
export async function compactUvContribution(
  renderer: THREE.WebGLRenderer,
  color: THREE.Texture,
  quality: THREE.Texture,
  resolution: number,
  checkCancelled?: () => void,
) {
  const scene = new THREE.Scene(),
    camera = new THREE.Camera();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
  );
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: reduceShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    uniforms: {
      source: { value: color },
      quality: { value: quality },
      first: { value: true },
      tileMap: { value: null },
      qualityIsRed: { value: quality.format === THREE.RedFormat },
      columns: { value: 0 },
      sourceColumns: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const targets: THREE.WebGLRenderTarget[] = [];
  const makeTarget = (width: number, height: number, count = 1) =>
    new THREE.WebGLRenderTarget(width, height, {
      count,
      depthBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
  const draw = (target: THREE.WebGLRenderTarget) => {
    checkCancelled?.();
    withUvRenderTarget(renderer,target,()=>renderer.render(scene,camera));
  };
  let reverse: THREE.DataTexture | undefined, index: THREE.DataTexture | undefined;
  let atlas: THREE.WebGLRenderTarget | undefined;
  try {
    let size = resolution;
    // Two exact 8x8 reductions cover the same 64x64 source tile as the old
    // three 4x4 reductions. This removes one render target/pass/yield without
    // changing the boolean occupancy or the packed colour/quality bytes.
    for (let level = 0; level < 2; level++) {
      size = Math.ceil(size / 8);
      const target = makeTarget(size, size);
      targets.push(target);
      draw(target);
      material.uniforms.source.value = target.texture;
      material.uniforms.first.value = false;
      // The final reduction is followed by an asynchronous GPU readback, which
      // already yields while preserving command order. Only the intermediate
      // level needs an explicit cooperative task boundary.
      if (level + 1 < 2) {
        await yieldToBrowserTask();
        checkCancelled?.();
      }
    }
    checkCancelled?.();
    const occupancy = new Uint8Array(size * size * 4);
    await renderer.readRenderTargetPixelsAsync(targets[targets.length - 1], 0, 0, size, size, occupancy);
    checkCancelled?.();
    const addresses = new Uint32Array(size * size),
      active: number[] = [];
    for (let i = 0; i < addresses.length; i++)
      if (occupancy[i * 4]) {
        active.push(i + 1);
        addresses[i] = active.length;
      }
    const columns = Math.max(1, Math.ceil(Math.sqrt(active.length))),
      rows = Math.max(1, Math.ceil(active.length / columns));
    // Dense layers stay in their original targets: never increase resident bytes.
    if (columns * rows * 4096 * 5 + addresses.byteLength >= resolution * resolution * 5)
      return undefined;
    index = uvTileIndex(addresses, size, size);
    // Reverse map is 2D too: supports 8K/16K without exceeding maxTextureSize.
    const reverseData = new Uint32Array(columns * rows);
    reverseData.set(active);
    reverse = uvTileIndex(reverseData, columns, rows);
    material.fragmentShader = packShader;
    material.needsUpdate = true;
    material.uniforms.source.value = color;
    material.uniforms.tileMap.value = reverse;
    material.uniforms.columns.value = columns;
    material.uniforms.sourceColumns.value = size;
    atlas = makeTarget(columns * 64, rows * 64, 2);
    atlas.textures[1].format = THREE.RedFormat;
    draw(atlas);
    checkCancelled?.();
    const result = { color: atlas, qualityTexture: atlas.textures[1], tiles: { index, columns } };
    atlas = undefined;
    index = undefined;
    return result;
  } finally {
    atlas?.dispose();
    index?.dispose();
    reverse?.dispose();
    targets.forEach((t) => t.dispose());
    material.dispose();
    geometry.dispose();
    scene.clear();
  }
}

export function withUvRenderTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, draw: () => void) {
    const previous=renderer.getRenderTarget();
    const face=renderer.getActiveCubeFace(), mip=renderer.getActiveMipmapLevel();
    const viewport=renderer.getViewport(new THREE.Vector4());
    const scissor=renderer.getScissor(new THREE.Vector4());
    const scissorTest=renderer.getScissorTest(), autoClear=renderer.autoClear;
    const xr=renderer.xr.enabled;
    try {
      renderer.xr.enabled=false; renderer.autoClear=false;
      renderer.setRenderTarget(target); renderer.setViewport(0,0,target.width,target.height);
      renderer.setScissorTest(false);
      if (renderer.getContext().checkFramebufferStatus(renderer.getContext().FRAMEBUFFER) !== renderer.getContext().FRAMEBUFFER_COMPLETE) {
        throw new Error('Resident quality framebuffer is incomplete.');
      }
      draw();
    } finally {
      renderer.setRenderTarget(previous,face,mip); renderer.setViewport(viewport);
      renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
      renderer.autoClear=autoClear; renderer.xr.enabled=xr;
    }
  }
