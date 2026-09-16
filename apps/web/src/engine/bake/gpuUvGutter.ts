import * as THREE from 'three';
import { withUvRenderTarget } from './uvContributionTiles';

// UV-GUTTER-ORDERED-GPU/1.0.0. Validation candidate, not a production route.
// Encode the CPU breadth-first discovery order, not Euclidean nearest colour.
// At depth d: rank = (row-major source + 1) * 8^d + neighbour path.
// The current frontier has equal depth, so unsigned rank order is queue order.
// Older frontiers cannot border an eligible empty texel: they visited it already.
const vertexShader = `in vec3 position;void main(){gl_Position=vec4(position,1.0);}`;
const common = `precision highp float;precision highp int;precision highp usampler2D;
uniform usampler2D ranks;uniform sampler2D coverage;uniform sampler2D topology;
uniform ivec2 dimensions;
uvec2 valueAt(ivec2 p){return texelFetch(ranks,p,0).rg;}
bool occupied(uvec2 v){return (v.x|v.y)!=0u;}
`;
const initializeShader = `${common}
layout(location=0) out uvec2 result;
void main(){ivec2 p=ivec2(gl_FragCoord.xy);
result=texelFetch(coverage,p,0).r>0.0?uvec2(uint(p.y*dimensions.x+p.x)+1u,0u):uvec2(0u);}
`;
const expandShader = `${common}
layout(location=0) out uvec2 result;
void main(){
ivec2 p=ivec2(gl_FragCoord.xy);result=valueAt(p);
if(occupied(result)||texelFetch(topology,p,0).r>0.0)return;
uvec2 best=uvec2(0xffffffffu);uint path=0u,depth=0u;int ordinal=0;
for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
if(x==0&&y==0)continue;
ivec2 q=p+ivec2(x,y);int step=ordinal++;
if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,dimensions)))continue;
uvec2 candidate=valueAt(q);if(!occupied(candidate))continue;
uint level=candidate.y>>28u;candidate.y&=0x0fffffffu;
if(candidate.y<best.y||(candidate.y==best.y&&candidate.x<best.x)){
best=candidate;path=uint(7-step);depth=level+1u;
}}
if(best.y==0xffffffffu)return;
result=uvec2((best.x<<3u)|path,((best.y<<3u)|(best.x>>29u))|(depth<<28u));
}
`;
const resolveShader = `${common}
uniform sampler2D color;uniform int alphaMode;
layout(location=0) out vec4 result;layout(location=1) out vec4 mask;
void main(){
ivec2 p=ivec2(gl_FragCoord.xy);uvec2 rank=valueAt(p);uint depth=rank.y>>28u;
result=texelFetch(color,p,0);mask=texelFetch(coverage,p,0);
if(depth==0u)return;
uint shift=depth*3u;rank.y&=0x0fffffffu;
uint index=((rank.x>>shift)|(rank.y<<(32u-shift)))-1u;
ivec2 source=ivec2(int(index%uint(dimensions.x)),int(index/uint(dimensions.x)));
result=texelFetch(color,source,0);
if(alphaMode!=1)result.a=alphaMode==2?0.0:1.0;
mask=vec4((alphaMode==2?2.0:1.0)/255.0);
}
`;

/** Exact full-resolution GPU gutter, with GPU-owned output and no readback.
 * Inputs use the same row order; color must contain untransformed RGBA bytes.
 * Caller must validate against the canonical CPU path before production use.
 * Scratch: two RG32UI ranks (16 B/texel); returned RGBA8+R8 (5 B/texel).
 */
export class ExactGpuUvGutter {
  private readonly ranks: THREE.WebGLRenderTarget[]=[];
  private readonly geometry=new THREE.BufferGeometry();
  private readonly uniforms={ranks:{value:null as THREE.Texture|null},coverage:{value:null as THREE.Texture|null},
    topology:{value:null as THREE.Texture|null},color:{value:null as THREE.Texture|null},
    dimensions:{value:new THREE.Vector2()},alphaMode:{value:1}};
  private readonly materials=[initializeShader,expandShader,resolveShader].map(fragmentShader=>new THREE.RawShaderMaterial({
    glslVersion:THREE.GLSL3,vertexShader,fragmentShader,uniforms:this.uniforms,depthTest:false,depthWrite:false,
    blending:THREE.NoBlending,toneMapped:false,
  }));
  private readonly scene=new THREE.Scene();
  private readonly camera=new THREE.Camera();
  private readonly mesh=new THREE.Mesh(this.geometry,this.materials[0]);
  private disposed=false;
  constructor(private readonly renderer: THREE.WebGLRenderer,private readonly width: number,private readonly height: number) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096)
      throw new RangeError('Exact GPU gutter supports dimensions 1..4096.');
    this.uniforms.dimensions.value.set(width,height);
    this.geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    this.mesh.frustumCulled=false;this.scene.add(this.mesh);
    for(let i=0;i<2;i++)this.ranks.push(new THREE.WebGLRenderTarget(width,height,{
      format:THREE.RGIntegerFormat,type:THREE.UnsignedIntType,internalFormat:'RG32UI',
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,
    }));
  }
  render(color: THREE.Texture,coverage: THREE.Texture,topology: THREE.Texture,
    iterations: number,alphaMode: boolean | 'rgb-only',check?: () => void) {
    if(this.disposed)throw new Error('GPU gutter is disposed.');
    if(!Number.isInteger(iterations)||iterations<1||iterations>8)
      throw new RangeError('Exact GPU gutter supports 1..8 iterations.');
    if([color,coverage,topology].some(texture=>texture.colorSpace!==THREE.NoColorSpace ||
      texture.image?.width!==this.width || texture.image?.height!==this.height))
      throw new Error('Exact GPU gutter requires matching raw byte textures.');
    const {renderer,width,height,ranks,materials,uniforms}=this;
    uniforms.color.value=color;uniforms.coverage.value=coverage;uniforms.topology.value=topology;
    uniforms.alphaMode.value=alphaMode===true?1:alphaMode==='rgb-only'?2:0;
    let output: THREE.WebGLRenderTarget | undefined;
    const draw=(target:THREE.WebGLRenderTarget,material:THREE.RawShaderMaterial)=>{
      check?.();this.mesh.material=material;
      withUvRenderTarget(renderer,target,()=>renderer.render(this.scene,this.camera));
    };
    try {
    draw(ranks[0],materials[0]);
    let current=0;
    for(let i=0;i<iterations;i++){
      uniforms.ranks.value=ranks[current].texture;
      draw(ranks[1-current],materials[1]);current=1-current;
    }
    output=new THREE.WebGLRenderTarget(width,height,{count:2,depthBuffer:false,
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    output.textures[1].format=THREE.RedFormat;output.textures[1].internalFormat='R8';
    uniforms.ranks.value=ranks[current].texture;draw(output,materials[2]);
    check?.();
    return output;
    } catch(error) {output?.dispose();throw error;}
    finally {uniforms.color.value=uniforms.coverage.value=uniforms.topology.value=uniforms.ranks.value=null;}
  }
  dispose() {
    this.disposed=true;this.ranks.forEach(target=>target.dispose());
    this.materials.forEach(material=>material.dispose());this.geometry.dispose();this.scene.clear();
  }
}
