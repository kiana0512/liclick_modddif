import * as THREE from 'three';
import {UvRepaint} from '../src/engine/localRepaint/uvRepaint.ts';
import {UvRepaint as Reference} from 'virtual:uv-brush-reference';
import {compositeRgbaUrlUnderWithWebGpu,terminateWebGpuRgbaCompositeWorker} from '../src/engine/performance/webGpuRgbaComposite.ts';
import {compositeRgbaUnderInPlace} from '../src/engine/layers/mergeUvComposition.ts';
const check=(value,message)=>{if(!value)throw Error(message);};
const frame=()=>new Promise(resolve=>window.requestAnimationFrame(resolve));
function difference(a,b){let count=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])count++;return count;}

export async function merge(width=4,height=1) {
  // Known exact PNG bytes (opaque/half/transparent), not a duplicated blend formula.
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');
  const pattern=[0,255,0,255,255,0,0,128,0,0,0,0,64,128,192,255];
  const base=[255,0,0,255,0,0,255,255,0,0,255,255,120,80,40,0];
  const input=new Uint8ClampedArray(width*height*4),background=new Uint8ClampedArray(input.length);
  for(let i=0;i<input.length;i++){input[i]=pattern[i%16];background[i]=base[i%16];}
  ctx.putImageData(new ImageData(input,width,height),0,0);
  const source=ctx.getImageData(0,0,width,height).data;
  const results=[];
  try {for(const interactive of [false,true]) for(const opacity of (height===1?[0,0.37,1]:[0.37])) {
    document.body.dataset.perfSimulatedViewportInteraction=interactive?'1':'0';
    const result=await compositeRgbaUrlUnderWithWebGpu(background.slice(),canvas.toDataURL(),width,height,opacity,undefined,true);
    const expected=opacity===0?background:compositeRgbaUnderInPlace(source.slice(),background,1,opacity);
    const mismatches=difference(result.data,expected);
    check(!mismatches,`Native UV Worker source-over mismatch: ${JSON.stringify({interactive,opacity,mismatches,actual:[...result.data.slice(0,16)],expected:[...expected.slice(0,16)],verification:result.verification,metrics:result.metrics})}`);
    check(!result.verification?.byteMismatches,'WebGPU/CPU parity failed');
    results.push({interactive,opacity,backend:result.metrics.backend,mismatches});
  }}finally{delete document.body.dataset.perfSimulatedViewportInteraction;terminateWebGpuRgbaCompositeWorker();}
  return {merge:results,width,height,...(height===1?{fullSize:await merge(4096,4096)}:{})};
}

export async function brush(resolution=1024,segments=2,dpr=1) {
  const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setPixelRatio(dpr);renderer.setSize(512,512);
  const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=2;camera.updateMatrixWorld();
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2,segments,segments),new THREE.MeshBasicMaterial());mesh.updateMatrixWorld();
  const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,
    vertexShader:'varying vec2 p;void main(){p=uv;gl_Position=vec4(uv*2.0-1.0,0.,1.);}',
    fragmentShader:'varying vec2 p;void main(){gl_FragColor=vec4(p.x,p.y,0.4,0.8);}'});
  const rows=[];
  try {for(const Engine of [Reference,UvRepaint]) {
    const engine=new Engine(renderer,[mesh],resolution);await engine.prepare(material,camera);
    const output=()=>{const bytes=new Uint8Array(resolution*resolution*4);renderer.readRenderTargetPixels(engine.output,0,0,resolution,resolution,bytes);return bytes;};
    let geometryDraws=0;const samples=[],gaps=[];let last;
    const render=renderer.render.bind(renderer);
    renderer.render=(scene,c)=>{if(scene===engine.scene)geometryDraws++;return render(scene,c);};
    const states=[];
    try {for(const erase of [false,true]) {
      engine.begin();
      for(let i=0;i<8;i++) {
        const timestamp=await frame();if(last!==undefined)gaps.push(timestamp-last);last=timestamp;
        const start=performance.now();
        engine.stamp({camera,from:new THREE.Vector2(.25+i*.04,.43),to:new THREE.Vector2(.29+i*.04,.46),
          viewport:new THREE.Vector2(512,512),radius:erase?40:65,feather:.37,erase});
        samples.push(performance.now()-start);
      }
      const patches=await engine.end();engine.publish(patches,'after');states.push(output());
      if(erase){engine.publish(patches,'before',true);states.push(output());engine.publish(patches,'after',true);states.push(output());}
      last=undefined;
    }}finally{renderer.render=render;engine.dispose();}
    rows.push({states,geometryDraws,submissionMedianMs:samples.sort((a,b)=>a-b)[8],maxFrameGapMs:Math.max(...gaps)});
  }
  const mismatches=rows[0].states.map((bytes,i)=>difference(bytes,rows[1].states[i]));
  check(mismatches.every(n=>!n),`Brush frozen RGBA mismatch ${mismatches}`);
  check(!difference(rows[1].states[0],rows[1].states[2]),'Undo must restore exact paint');
  check(!difference(rows[1].states[1],rows[1].states[3]),'Redo must restore exact erase');
  check(rows[1].geometryDraws<rows[0].geometryDraws,'Expected fewer geometry draws');
  return {brush:{resolution,triangles:segments*segments*2,dpr,mismatches,
    rows:rows.map(row=>({geometryDraws:row.geometryDraws,submissionMedianMs:row.submissionMedianMs,maxFrameGapMs:row.maxFrameGapMs})),scope:'Synthetic multi-tile brush; submission and frame spacing, not user-project FPS'}};
  }finally{renderer.dispose();mesh.geometry.dispose();mesh.material.dispose();material.dispose();}
}
