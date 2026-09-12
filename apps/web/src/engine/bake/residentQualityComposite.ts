import * as THREE from 'three';
import { resolvePixelCpu } from './qualityBlendCpuPixel';
import type { QualityBlendWorkerResult } from './qualityBlendWorker';
import { readRenderTargetPixelsInStripes } from './gpuReadbackStripes';
import { yieldToBrowserTask } from '@/utils/browserScheduling';
import { isLegacyUvBakeDiagnosticEnabled } from './uvBakeDebugControls';

const approvals=new WeakMap<THREE.WebGLRenderer,Map<boolean,boolean>>();
export function residentQualityPolicy(renderer:THREE.WebGLRenderer,preserveAlpha:boolean) {
  const params=new URLSearchParams(window.location.search);
  if(isLegacyUvBakeDiagnosticEnabled() &&
    (params.get('perfResidentQuality')==='0' || params.get('perfQualityCpuGold')==='1')) return undefined;
  let modes=approvals.get(renderer);
  if(!modes) {
    modes=new Map();approvals.set(renderer,modes);
    renderer.domElement.addEventListener('webglcontextlost',()=>approvals.delete(renderer),{once:true});
  }
  if(modes.get(preserveAlpha)===false) throw new Error('GPU UV quality validation failed. Legacy bake is disabled.');
  return {preserveAlpha,retainRasters:modes.get(preserveAlpha)!==true || params.get('perfQualityGpuAb')==='1'};
}

export function verifyResidentQuality(renderer:THREE.WebGLRenderer,preserveAlpha:boolean,
  candidate:QualityBlendWorkerResult,reference:QualityBlendWorkerResult) {
  const a=candidate.imageData.data,b=reference.imageData.data;
  let byteMismatches=0,alphaByteMismatches=0,maximumByteDelta=0;
  for(let i=0;i<a.length;i++) {
    const delta=Math.abs(a[i]-b[i]);
    if(delta) {byteMismatches++;maximumByteDelta=Math.max(maximumByteDelta,delta);if(i%4===3)alphaByteMismatches++;}
  }
  const mismatchRatio=byteMismatches/a.length;
  const accepted=a.length===b.length && alphaByteMismatches===0 && maximumByteDelta<=1 && mismatchRatio<=0.00001;
  approvals.get(renderer)?.set(preserveAlpha,accepted);
  if(!accepted && !isLegacyUvBakeDiagnosticEnabled()) {
    throw new Error(`GPU UV quality validation failed (${byteMismatches} differing bytes). Legacy bake is disabled.`);
  }
  const result=accepted ? candidate : reference;
  result.verification={byteMismatches,alphaByteMismatches,maximumByteDelta,mismatchRatio,
    usedCpuOutput:!accepted,acceptedGpuOutput:accepted};
  return result;
}

// ALG-UV-003 v2.1.0: keep the canonical, quantized per-layer rasters in WebGL.
// Three RGBA candidates and their three quality bytes fit in one RGBA32UI texel.
// No candidate image crosses the GPU/CPU boundary between layers.
const vertexShader = `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }
`;
const common = `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D previousCandidates;
uniform sampler2D scoreTable;
vec4 score(uint rgba, uint quality) {
  return texelFetch(scoreTable, ivec2(int(quality), int(rgba >> 24u)), 0);
}
uvec3 rgb(uint value) { return uvec3(value, value >> 8u, value >> 16u) & 255u; }
`;
const accumulateShader = `${common}
uniform sampler2D layerColor;
uniform sampler2D layerQuality;
uniform bool qualityIsRed;
uniform sampler2D unpremultiplyTable;
layout(location=0) out uvec4 result;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  result = texelFetch(previousCandidates, p, 0);
  uvec4 selected = result;
  uvec4 color = uvec4(floor(texelFetch(layerColor, p, 0) * 255.0 + 0.5));
  if (color.a>0u) { result.w+=0x01000000u; selected.w=result.w; }
  if (color.a <= 5u) return;
  vec4 qualityTexel = texelFetch(layerQuality, p, 0);
  uint quality = uint(floor((qualityIsRed ? qualityTexel.r : qualityTexel.a) * 255.0 + 0.5));
  // Preserve JavaScript double rounding: 38 byte pairs differ from exact
  // integer division at half-integer ties (for example RGB=11, alpha=66).
  uvec3 straight=uvec3(
    floor(texelFetch(unpremultiplyTable,ivec2(int(color.r),int(color.a)),0).r*255.0+0.5),
    floor(texelFetch(unpremultiplyTable,ivec2(int(color.g),int(color.a)),0).r*255.0+0.5),
    floor(texelFetch(unpremultiplyTable,ivec2(int(color.b),int(color.a)),0).r*255.0+0.5));
  uint packed = straight.r | (straight.g << 8u) | (straight.b << 16u) | (color.a << 24u);
  uvec3 qualities = uvec3(result.w, result.w >> 8u, result.w >> 16u) & 255u;
  float candidateRank = score(packed, quality).x;
  int insertAt = -1;
  for (int i=0; i<3; ++i) {
    if (candidateRank > score(selected[i], qualities[i]).y) { insertAt=i; break; }
  }
  if (insertAt < 0) return;
  for (int i=2; i>0; --i) {
    if (i>insertAt) { selected[i]=selected[i-1]; qualities[i]=qualities[i-1]; }
  }
  selected[insertAt]=packed; qualities[insertAt]=quality;
  selected.w=(selected.w&0xff000000u) | qualities.x | (qualities.y << 8u) | (qualities.z << 16u);
  result=selected;
}
`;
const resolveShader = `${common}
uniform sampler2D linearTable;
uniform bool preserveAlpha;
uniform bool markUncertain;
layout(location=0) out vec4 result;
vec3 linearColor(uint packed) {
  uvec3 c=rgb(packed);
  return vec3(texelFetch(linearTable,ivec2(int(c.r),0),0).r,
    texelFetch(linearTable,ivec2(int(c.g),0),0).r,
    texelFetch(linearTable,ivec2(int(c.b),0),0).r);
}
float srgbByte(float value) {
  float c=clamp(value,0.0,1.0);
  float s=c<=0.0031308 ? c*12.92 : 1.055*pow(c,1.0/2.4)-0.055;
  return clamp(s*255.0,0.0,255.0);
}
float stepExact(float lo,float hi,float value) {
  float t=clamp((value-lo)/max(hi-lo,0.000001),0.0,1.0);
  return t*t*(3.0-2.0*t);
}
void main() {
  ivec2 position=ivec2(gl_FragCoord.xy);
  uvec4 packed=texelFetch(previousCandidates,position,0);
  if ((packed.x >> 24u)==0u) { result=vec4(0.0); return; }
  ivec2 previousPosition=position.x>0 ? position-ivec2(1,0) :
    ivec2(textureSize(previousCandidates,0).x-1,position.y-1);
  bool repeated=position.x+position.y>0 && all(equal(packed,texelFetch(previousCandidates,previousPosition,0)));
  vec4 correctionMarker=vec4(repeated ? 254.0/255.0 : 1.0,0,1,0);
  uvec3 qs=uvec3(packed.w,packed.w >> 8u,packed.w >> 16u)&255u;
  vec4 a=score(packed.x,qs.x), b=score(packed.y,qs.y), c=score(packed.z,qs.z);
  vec3 coverage=vec3(a.w,b.w,c.w);
  float rawAlpha=preserveAlpha ? (1.0-(1.0-a.w)*(1.0-b.w)*(1.0-c.w))*255.0 : 255.0;
  float alpha=floor(rawAlpha+0.5);
  bool uncertainAlpha=abs(fract(rawAlpha)-0.5)<0.01;
  if ((packed.y >> 24u)==0u) {
    result=markUncertain && uncertainAlpha ? correctionMarker : vec4(vec3(rgb(packed.x)),alpha)/255.0;
    return;
  }
  vec3 ca=linearColor(packed.x), cb=linearColor(packed.y), cc=linearColor(packed.z);
  float totalQ=a.z+b.z+c.z;
  vec3 base=(ca*a.z+cb*b.z+cc*c.z)/max(totalQ,0.000001);
  vec3 q=vec3(a.z,b.z,c.z)* (vec3(0.35)+0.65*exp(-vec3(
    dot(ca-base,ca-base),dot(cb-base,cb-base),dot(cc-base,cc-base))/0.0484));
  vec3 strong=pow(max(q,vec3(0.0)),vec3(2.4));
  vec3 weights=strong/max(strong.x+strong.y+strong.z,0.000001)*0.8+
    coverage/max(coverage.x+coverage.y+coverage.z,0.000001)*0.2;
  vec3 blended=ca*weights.x+cb*weights.y+cc*weights.z;
  float dominance=stepExact(1.45,2.6,q.x/max(q.y,0.000001))*stepExact(0.05,0.2,q.x-q.y);
  vec3 color=blended*(1.0-dominance)+ca*dominance;
  vec3 bytes=vec3(srgbByte(color.r),srgbByte(color.g),srgbByte(color.b));
  bool uncertain=uncertainAlpha || any(lessThan(abs(fract(bytes)-vec3(0.5)),vec3(0.01)));
  // This internal sentinel never leaves readCorrected(): only rounding-boundary
  // candidates are gathered for the canonical double-precision CPU resolver.
  result=markUncertain && uncertain ? correctionMarker : vec4(floor(bytes+0.5),alpha)/255.0;
}
`;
const gatherShader = `${common}
uniform usampler2D coordinates;
uniform uint resolution;
layout(location=0) out vec4 result;
void main() {
  ivec2 p=ivec2(gl_FragCoord.xy);
  uint index=texelFetch(coordinates,ivec2(p.x/4,p.y),0).r;
  uint value=texelFetch(previousCandidates,ivec2(int(index%resolution),int(index/resolution)),0)[p.x%4];
  result=vec4(uvec4(value,value>>8u,value>>16u,value>>24u)&255u)/255.0;
}
`;
const countShader = `${common}
uniform sampler2D counts;
uniform bool firstCount;
layout(location=0) out vec4 result;
void main() {
  ivec2 size=firstCount ? textureSize(previousCandidates,0) : textureSize(counts,0);
  ivec2 start=ivec2(gl_FragCoord.xy)*4;
  uint sum=0u;
  for(int y=0;y<4;y++) for(int x=0;x<4;x++) {
    ivec2 p=start+ivec2(x,y);
    if(any(greaterThanEqual(p,size))) continue;
    if(firstCount) sum+=texelFetch(previousCandidates,p,0).w>>24u;
    else {
      uvec4 b=uvec4(floor(texelFetch(counts,p,0)*255.0+0.5));
      sum+=b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u);
    }
  }
  result=vec4(uvec4(sum,sum>>8u,sum>>16u,sum>>24u)&255u)/255.0;
}
`;

/** CPU accumulation compares a double candidate against a stored Float32.
 * Ranks preserve that asymmetric comparison, including coverage-floor ties.
 * Comparing two rounded shader scores would silently reorder some candidates.
 */
export function createResidentQualityScoreTable() {
  const raw = new Float64Array(65536);
  const values = new Set<number>([0]);
  for (let alpha = 0; alpha < 256; alpha += 1) {
    for (let quality = 0; quality < 256; quality += 1) {
      const value = Math.max(Math.fround(quality / 255), alpha / 255 * 0.08);
      raw[alpha * 256 + quality] = value;
      values.add(value); values.add(Math.fround(value));
    }
  }
  const ranks = new Map([...values].sort((a,b) => a-b).map((value,index) => [value,index]));
  const table = new Float32Array(65536 * 4);
  for (let index = 0; index < raw.length; index += 1) {
    table[index * 4] = ranks.get(raw[index])!;
    table[index * 4 + 1] = ranks.get(Math.fround(raw[index]))!;
    table[index * 4 + 2] = Math.fround(raw[index]);
    table[index * 4 + 3] = Math.fround(Math.floor(index / 256) / 255);
  }
  return table;
}

function tableTexture(data: Float32Array<ArrayBuffer>, width: number, height: number) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

export class ResidentQualityComposite {
  readonly output: THREE.WebGLRenderTarget;
  private readonly targets: THREE.WebGLRenderTarget[] = [];
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly scoreTexture: THREE.DataTexture;
  private readonly linearTexture: THREE.DataTexture;
  private readonly unpremultiplyTexture: THREE.DataTexture;
  private readonly accumulateMaterial: THREE.RawShaderMaterial;
  private readonly resolveMaterial: THREE.RawShaderMaterial;
  private readonly gatherMaterial: THREE.RawShaderMaterial;
  private readonly countMaterial: THREE.RawShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private current = 0;
  private initialized = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, readonly resolution: number) {
    this.output = new THREE.WebGLRenderTarget(resolution, resolution, { depthBuffer: false });
    for (let index=0; index<2; index+=1) {
      this.targets.push(new THREE.WebGLRenderTarget(resolution, resolution, {
        format: THREE.RGBAIntegerFormat, type: THREE.UnsignedIntType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      }));
    }
    this.scoreTexture = tableTexture(createResidentQualityScoreTable(),256,256);
    const linear = new Float32Array(256 * 4);
    for (let i=0; i<256; i+=1) {
      const c=i/255;
      linear[i*4]=c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4;
    }
    this.linearTexture=tableTexture(linear,256,1);
    const unpremultiply=new Uint8Array(65536);
    for (let a=1; a<256; a+=1) for (let c=0; c<256; c+=1) {
      unpremultiply[a*256+c]=Math.min(255,Math.round(c/(a/255)));
    }
    this.unpremultiplyTexture=new THREE.DataTexture(unpremultiply,256,256,THREE.RedFormat);
    this.unpremultiplyTexture.needsUpdate=true;
    const material = (fragmentShader: string) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader, fragmentShader,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
      uniforms: {
        previousCandidates:{value:null}, scoreTable:{value:this.scoreTexture},
        layerColor:{value:null}, layerQuality:{value:null}, qualityIsRed:{value:false},
        linearTable:{value:this.linearTexture}, preserveAlpha:{value:false},
        markUncertain:{value:false}, coordinates:{value:null}, resolution:{value:resolution},
        counts:{value:null},firstCount:{value:true},
        unpremultiplyTable:{value:this.unpremultiplyTexture},
      },
    });
    this.accumulateMaterial=material(accumulateShader);
    this.resolveMaterial=material(resolveShader);
    this.gatherMaterial=material(gatherShader);
    this.countMaterial=material(countShader);
    this.geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    this.mesh=new THREE.Mesh(this.geometry,this.accumulateMaterial);
    this.mesh.frustumCulled=false;
    this.scene.add(this.mesh);
  }

  private withTarget(target: THREE.WebGLRenderTarget, draw: () => void) {
    const renderer=this.renderer;
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

  push(color: THREE.Texture, quality: THREE.Texture) {
    if (!this.initialized) {
      this.withTarget(this.targets[this.current],() => {
        const gl=this.renderer.getContext() as WebGL2RenderingContext;
        gl.clearBufferuiv(gl.COLOR,0,new Uint32Array(4));
      });
      this.initialized=true;
    }
    const next=1-this.current;
    this.accumulateMaterial.uniforms.previousCandidates.value=this.targets[this.current].texture;
    this.accumulateMaterial.uniforms.layerColor.value=color;
    this.accumulateMaterial.uniforms.layerQuality.value=quality;
    this.accumulateMaterial.uniforms.qualityIsRed.value=quality.format===THREE.RedFormat;
    this.mesh.material=this.accumulateMaterial;
    this.withTarget(this.targets[next],() => this.renderer.render(this.scene,this.camera));
    this.current=next;
  }

  getCurrentSlot() { return this.current; }

  selectSlot(slot: number) {
    if (slot !== 0 && slot !== 1) throw new Error('Invalid resident quality slot.');
    this.current=slot;
    this.initialized=true;
  }

  resolve(preserveAlpha: boolean, markUncertain = false) {
    if (!this.initialized) throw new Error('Resident quality composite has no layers.');
    this.resolveMaterial.uniforms.previousCandidates.value=this.targets[this.current].texture;
    this.resolveMaterial.uniforms.preserveAlpha.value=preserveAlpha;
    this.resolveMaterial.uniforms.markUncertain.value=markUncertain;
    this.mesh.material=this.resolveMaterial;
    this.withTarget(this.output,() => this.renderer.render(this.scene,this.camera));
    return this.output;
  }

  /** GPU-order RGBA. The caller performs the existing final Y flip once. */
  async readCorrected(preserveAlpha: boolean) {
    const bytes=await readRenderTargetPixelsInStripes(this.renderer,this.resolve(preserveAlpha,true),this.resolution);
    const output=new Uint8ClampedArray(bytes.buffer);
    const indices:number[]=[];
    for(let first=0;first<output.length;first+=1048576) {
      const end=Math.min(output.length,first+1048576);
      for(let i=first;i<end;i+=4) {
        if(output[i+3]===0 && output[i]===255 && output[i+2]===255) indices.push(i/4);
      }
      if(end<output.length) await yieldToBrowserTask();
    }
    if(!indices.length) return {output,correctedPixels:0};
    const width=Math.min(indices.length,Math.floor(this.renderer.capabilities.maxTextureSize/4)), height=Math.ceil(indices.length/width);
    const coordinates=new Uint32Array(width*height);
    coordinates.set(indices);
    const texture=new THREE.DataTexture(coordinates,width,height,THREE.RedIntegerFormat,THREE.UnsignedIntType);
    texture.needsUpdate=true;
    const target=new THREE.WebGLRenderTarget(width*4,height,{
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,
    });
    try {
      this.gatherMaterial.uniforms.previousCandidates.value=this.targets[this.current].texture;
      this.gatherMaterial.uniforms.coordinates.value=texture;
      this.mesh.material=this.gatherMaterial;
      this.withTarget(target,()=>this.renderer.render(this.scene,this.camera));
      const bytes=new Uint8Array(width*height*16);
      await this.renderer.readRenderTargetPixelsAsync(target,0,0,width*4,height,bytes);
      const selected=new Uint32Array(bytes.buffer);
      const top={colors:[new Uint32Array(1),new Uint32Array(1),new Uint32Array(1)],
        coverages:[new Float32Array(1),new Float32Array(1),new Float32Array(1)],
        qualities:[new Float32Array(1),new Float32Array(1),new Float32Array(1)],
        coverage:new Uint8Array([1]),writtenTexels:1};
      const pixel=new Uint8ClampedArray(4);
      const pixelWord = new Uint32Array(pixel.buffer);
      const outputWords = new Uint32Array(output.buffer, output.byteOffset, output.length / 4);
      const repeatedMarker = new Uint32Array(new Uint8Array([254, 0, 255, 0]).buffer)[0];
      const previous = new Uint32Array(4);
      let lastYield = performance.now();
      let correctedPixels = 0;
      for(let i=0;i<indices.length;i+=1) {
        const offset = i * 4;
        if (i === 0 || selected[offset] !== previous[0] || selected[offset + 1] !== previous[1] ||
            selected[offset + 2] !== previous[2] || selected[offset + 3] !== previous[3]) {
          for(let slot=0;slot<3;slot+=1) {
            const color=selected[offset+slot], coverage=(color>>>24)/255;
            const quality=(selected[offset+3]>>>(slot*8))&255;
            top.colors[slot][0]=color&0xffffff;
            top.coverages[slot][0]=coverage;
            top.qualities[slot][0]=Math.max(Math.fround(quality/255),coverage*0.08);
          }
          resolvePixelCpu(top,0,preserveAlpha,pixel);
          previous.set(selected.subarray(offset, offset + 4));
        }
        // 254 marks an adjacent texel with the identical integer candidate tuple.
        // Correct its run without gathering duplicate candidates across the bus.
        let destination = indices[i];
        let more = true;
        do {
          const first = destination++;
          const limit = Math.min(outputWords.length, first + 65536);
          while (destination < limit && outputWords[destination] === repeatedMarker) destination++;
          more = destination < outputWords.length && outputWords[destination] === repeatedMarker;
          outputWords.fill(pixelWord[0], first, destination);
          correctedPixels += destination - first;
          if(performance.now() - lastYield >= 4) {
            await yieldToBrowserTask(); lastYield = performance.now();
          }
        } while(more);
      }
      return {output,correctedPixels};
    } finally {texture.dispose();target.dispose();}
  }

  reset() { this.initialized=false; this.current=0; }

  async countLayerCoverage() {
    let size=this.resolution;
    let previous:THREE.WebGLRenderTarget|undefined;
    this.countMaterial.uniforms.previousCandidates.value=this.targets[this.current].texture;
    this.mesh.material=this.countMaterial;
    try {
      do {
        size=Math.ceil(size/4);
        const target=new THREE.WebGLRenderTarget(size,size,{depthBuffer:false});
        this.countMaterial.uniforms.firstCount.value=!previous;
        this.countMaterial.uniforms.counts.value=previous?.texture ?? null;
        try {this.withTarget(target,()=>this.renderer.render(this.scene,this.camera));}
        catch(error) {target.dispose();throw error;}
        previous?.dispose();previous=target;
      } while(size>1);
      const bytes=new Uint8Array(4);
      await this.renderer.readRenderTargetPixelsAsync(previous,0,0,1,1,bytes);
      return new DataView(bytes.buffer).getUint32(0,true);
    } finally {previous?.dispose();}
  }

  dispose() {
    this.targets.forEach(target => target.dispose()); this.output.dispose();
    this.scoreTexture.dispose(); this.linearTexture.dispose();
    this.unpremultiplyTexture.dispose();
    this.accumulateMaterial.dispose(); this.resolveMaterial.dispose();
    this.gatherMaterial.dispose();
    this.countMaterial.dispose();
    this.geometry.dispose(); this.scene.clear();
  }
}
