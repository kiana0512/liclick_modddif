import * as THREE from 'three';
import { rasterizeUvTopologyMask, padUvIslandGuttersWithTopology } from '../src/engine/bake/dilation.ts';
import { rasterizeUvTopologyMaskWithWebGpu } from '../src/engine/bake/webGpuUvTopologyRaster.ts';

// Three windshield triangles from the reported 2K atlas, including edges
// where Canvas area coverage reaches 128 but WebGL covers no pixel centre.
export async function run() {
  const points = [1940.695068359,703.987731934,1944.487915039,702.140441895,1944.508422852,706.082824707,
    216.13772583,1801.631713867,213.233657837,1796.440063477,218.398727417,1801.838623047,
    235.470840454,1847.478271484,235.610107422,1842.716674805,239.302658081,1843.638305664];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(points.map(v=>v/2048),2));
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Array(27).fill(0),3));
  const material = new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=vec4(uv*2.0-1.0,0,1);}',
    fragmentShader:'void main(){gl_FragColor=vec4(0.2,0.2,0.2,1);}',side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;
  const scene=new THREE.Scene();scene.add(mesh);
  const renderer=new THREE.WebGLRenderer();const target=new THREE.WebGLRenderTarget(2048,2048);
  renderer.setRenderTarget(target);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,new THREE.Camera());
  const raw=new Uint8Array(2048*2048*4);renderer.readRenderTargetPixels(target,0,0,2048,2048,raw);
  const rgba=new Uint8ClampedArray(raw.length),coverage=new Uint8Array(2048*2048);
  for(let y=0;y<2048;y++)for(let x=0;x<2048;x++){
    const i=(y*2048+x)*4,j=((2047-y)*2048+x)*4;rgba.set(raw.subarray(j,j+4),i);coverage[i/4]=Number(raw[j+3]>0);
  }
  const masks=[['CPU',rasterizeUvTopologyMask(scene,2048,2048)],['Worker',(await rasterizeUvTopologyMaskWithWebGpu(scene,2048,2048)).mask]];
  const rows=[];
  for(const [name,mask] of masks){
    let falseInterior=0,missedInterior=0;
    for(let i=0;i<coverage.length;i++){if(mask[i]&&!coverage[i])falseInterior++;if(!mask[i]&&coverage[i])missedInterior++;}
    const image=new ImageData(rgba.slice(),2048,2048);
    padUvIslandGuttersWithTopology(image,coverage.slice(),mask,2,true);
    const pinhole=((2047-703)*2048+1944)*4;
    rows.push({name,falseInterior,missedInterior,edgeAlpha:image.data[pinhole+3]});
    // A genuine unpainted surface texel must remain transparent: gutter
    // correction is not permission to grow the authored paint footprint.
    const interior=coverage.findIndex((value,i)=>value&&mask[i]);
    const erased=coverage.slice();erased[interior]=0;
    image.data.fill(0,interior*4,interior*4+4);
    padUvIslandGuttersWithTopology(image,erased,mask,2,true);
    if(image.data[interior*4+3]!==0)throw Error('Gutter painted an unpainted surface: '+JSON.stringify({name,interior,mask:mask[interior],alpha:image.data[interior*4+3],rows}));
  }
  geometry.dispose();material.dispose();target.dispose();renderer.dispose();
  if(rows.some(r=>r.falseInterior||r.missedInterior||r.edgeAlpha!==255))throw Error('UV gutter raster mismatch: '+JSON.stringify(rows));
  return rows;
}
