import * as THREE from 'three';
import { compactUvContribution, uploadUvRgba } from '../src/engine/bake/uvContributionTiles.ts';
import { ResidentQualityComposite } from '../src/engine/bake/residentQualityComposite.ts';
import { UvContributionArchive } from '../src/engine/bake/UvContributionArchive.ts';
import { padResidentUvGutterInWorker } from '../src/engine/bake/gpuReadbackConversionWorker.ts';
import { padUvIslandGuttersWithTopology as frozenGutter } from './fixtures/uv-gutter-b3431cb.ts';
import { ExactGpuUvGutter } from '../src/engine/bake/gpuUvGutter.ts';
import { compositeRgbaUrlUnderWithWebGpu, terminateWebGpuRgbaCompositeWorker } from '../src/engine/performance/webGpuRgbaComposite.ts';
import { compositeRgbaUnderInPlace } from '../src/engine/layers/mergeUvComposition.ts';

async function verifyUnderlayReuse() {
  const results=[];
  try {
    for(const size of [512,4096]) {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      const pixels=new Uint8ClampedArray(size*size*4),front=new Uint8ClampedArray(pixels.length);
      for(let i=0;i<pixels.length;i+=4){pixels.set([93,177,231,[0,128,255][(i/4)%3]],i);front.set([20,90,180,[255,0,99][(i/4)%3]],i);}
      context.putImageData(new ImageData(pixels,size,size),0,0);
      const expected=compositeRgbaUnderInPlace(front.slice(),context.getImageData(0,0,size,size).data,0.75);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),url=URL.createObjectURL(blob);
      try {
        for(let repeat=0;repeat<3;repeat++) {
          const input=front.slice(),start=performance.now();
          const actual=await compositeRgbaUrlUnderWithWebGpu(input,url,size,size,0.75);
          const ms=performance.now()-start;
          let differences=0;for(let i=0;i<expected.length;i++)if(expected[i]!==actual.data[i])differences++;
          if(differences)throw Error(`Underlay ${size}/${repeat}: ${differences} pixel differences`);
          results.push({size,repeat,ms,differences,metrics:actual.metrics});
        }
      } finally {URL.revokeObjectURL(url);canvas.width=canvas.height=1;}
    }
  } finally {terminateWebGpuRgbaCompositeWorker();}
  return results;
}

async function verifyGpuGutter(renderer) {
  const results=[];
  for(const size of [1,9,31,65,257,4096]) {
    const gutter=new ExactGpuUvGutter(renderer,size,size);
    try {
    for(const alphaMode of (size===4096?[true]:[true,false,'rgb-only'])) {
      for(const iterations of (size===4096?[8]:[1,2,4,8])) {
        const rgba=new Uint8ClampedArray(size*size*4),coverage=new Uint8Array(size*size),topology=new Uint8Array(size*size);
        let random=147+size;
        for(let i=0;i<coverage.length;i++) {
          random=(Math.imul(random,1664525)+1013904223)>>>0;
          const x=i%size,y=Math.floor(i/size);
          topology[i]=size===4096 ? +(x%67<54 && y%71<61) : +(random%7===0);
          coverage[i]=size===4096 ? topology[i] : random%9<2 ? (random%2)+1 : 0;
          rgba.set([random&255,(random>>>8)&255,(random>>>16)&255,(random>>>24)&255],i*4);
        }
        const expected=new ImageData(rgba.slice(),size,size),mask=coverage.slice();
        const cpuStarted=performance.now(),count=frozenGutter(expected,mask,topology,iterations,alphaMode);
        const cpuMs=performance.now()-cpuStarted;
        const textures=[new THREE.DataTexture(rgba,size,size),
          new THREE.DataTexture(coverage,size,size,THREE.RedFormat),new THREE.DataTexture(topology,size,size,THREE.RedFormat)];
        textures.forEach(t=>{t.unpackAlignment=1;t.needsUpdate=true;renderer.initTexture(t);});
        let target;
        try {
          const start=performance.now();
          target=gutter.render(...textures,iterations,alphaMode);
          const submitMs=performance.now()-start;
          const actual=new Uint8Array(rgba.length);
          await renderer.readRenderTargetPixelsAsync(target,0,0,size,size,actual);
          const completionMs=performance.now()-start;
          const actualMask=new Uint8Array(rgba.length),gl=renderer.getContext(),previous=renderer.getRenderTarget();
          try {
            renderer.setRenderTarget(target);gl.readBuffer(gl.COLOR_ATTACHMENT1);
            gl.readPixels(0,0,size,size,gl.RGBA,gl.UNSIGNED_BYTE,actualMask);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
          } finally {renderer.setRenderTarget(previous);}
          if(gl.getError()!==gl.NO_ERROR)throw Error('GPU gutter readback GL error');
          let differences=0,filled=0;
          for(let i=0;i<actual.length;i++)if(actual[i]!==expected.data[i])differences++;
          for(let i=0;i<mask.length;i++) {if(actualMask[i*4]!==mask[i])differences++;if(!coverage[i]&&actualMask[i*4])filled++;}
          if(differences||filled!==count)throw Error(`GPU gutter ${size}/${iterations}/${alphaMode}: ${differences} differences, count ${filled}/${count}`);
          results.push({size,iterations,alphaMode,differences,count,cpuMs,submitMs,completionMs});
        } finally {target?.dispose();textures.forEach(t=>t.dispose());}
      }
    }
    } finally {gutter.dispose();}
  }
  return results;
}

export async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  const results = [];
  try {
    results.push({underlay:await verifyUnderlayReuse()});
    results.push({gpuGutter:await verifyGpuGutter(renderer)});
    for(const size of [65,4096]) {
      const pixels=new Uint8ClampedArray(size*size*4),topology=new Uint8Array(size*size);
      for(let y=4;y<size-4;y++)for(let x=4;x<size-4;x++) {
        if(x%67<54 && y%71<61) {const i=y*size+x;topology[i]=1;pixels.set([i%256,(i*37)%256,(i*19)%256,9+i%247],i*4);}
      }
      const expected=new ImageData(pixels.slice(),size,size),goldMask=topology.slice();
      const count=frozenGutter(expected,goldMask,topology,4,true);
      const start=performance.now();
      const actual=await padResidentUvGutterInWorker(new ImageData(pixels,size,size),topology.slice(),topology,4,true);
      let differences=0;
      for(let i=0;i<expected.data.length;i++)if(expected.data[i]!==actual.imageData.data[i])differences++;
      for(let i=0;i<goldMask.length;i++)if(goldMask[i]!==actual.coverage[i])differences++;
      if(differences || count!==actual.paddedPixels) throw Error(`Worker gutter ${size}: output mismatch`);
      results.push({workerGutter:size,differences,count,ms:performance.now()-start});
    }
    for(const size of [65,512,4096]) {
      const rgba=new Uint8ClampedArray(size*size*4);
      for(let i=0;i<rgba.length;i++)rgba[i]=(i*71+(i/size|0))&255;
      const bitmap=await window.createImageBitmap(new ImageData(rgba,size,size),{imageOrientation:'flipY',premultiplyAlpha:'none'});
      const reference=new THREE.Texture(bitmap);reference.flipY=false;reference.generateMipmaps=false;
      reference.minFilter=THREE.NearestFilter;reference.colorSpace=THREE.SRGBColorSpace;reference.needsUpdate=true;
      const start=performance.now();
      const uploaded=await uploadUvRgba(renderer,rgba,size,size,{flipRows:true,configure:t=>{t.colorSpace=THREE.SRGBColorSpace;}});
      const uploadMs=performance.now()-start;
      const q=new THREE.DataTexture(new Uint8Array(size*size).fill(255),size,size,THREE.RedFormat);q.needsUpdate=true;
      const composite=new ResidentQualityComposite(renderer,size);
      try {
        composite.push(reference,q);const old=(await composite.readCorrected(true)).output;
        composite.reset();composite.push(uploaded,q);const next=(await composite.readCorrected(true)).output;
        let differences=0;for(let i=0;i<old.length;i++)if(old[i]!==next[i])differences++;
        if(differences)throw Error(`Direct upload ${size}: ${differences} differences`);
        results.push({directUpload:size,differences,uploadMs});
      } finally {composite.dispose();reference.dispose();bitmap.close();uploaded.dispose();q.dispose();}
    }
    for (const resolution of [65, 128, 257, 512, 4096]) {
      const original = new ResidentQualityComposite(renderer, resolution);
      const tiled = new ResidentQualityComposite(renderer, resolution);
      const inputs = [];
      const packed = [];
      const archive = new UvContributionArchive();
      try {
        const layerCount = resolution === 4096 ? 4 : 7;
        for (let layer = 0; layer < layerCount; layer++) {
          const color = new Uint8Array(resolution * resolution * 4),
            quality = new Uint8Array(resolution * resolution);
          for (let y = 0; y < resolution; y++)
            for (let x = 0; x < resolution; x++) {
              const i = y * resolution + x;
              if ((((x / 64) | 0) + ((y / 64) | 0) * 3 + layer) % 4 !== 0 && x !== resolution - 1)
                continue;
              const alpha = [0, 1, 5, 6, 66, 128, 255][(x + y + layer) % 7];
              color.set(
                [
                  Math.min(alpha, (i * 17) & 255),
                  Math.min(alpha, (i * 31) & 255),
                  Math.min(alpha, (i * 59) & 255),
                  alpha,
                ],
                i * 4,
              );
              quality[i] = (i * 113 + layer * 71) & 255;
            }
          const c = new THREE.DataTexture(color, resolution, resolution),
            q = new THREE.DataTexture(quality, resolution, resolution, THREE.RedFormat);
          c.needsUpdate = q.needsUpdate = true;
          inputs.push([c, q]);
          packed.push(await compactUvContribution(renderer, c, q, resolution));
        }
        // Hidden/reordered/re-enabled layers: compare actual GPU output + all-alpha coverage.
        const orders =
          resolution === 4096
            ? [
                [0, 1, 2, 3],
                [0, 2, 3],
                [3, 2, 1, 0],
              ]
            : [
                [0, 1, 2, 3, 4, 5, 6],
                [0, 2, 3, 5, 6],
                [6, 5, 4, 3, 2, 1, 0],
                [2],
                [0, 1, 2, 3, 4, 5, 6],
              ];
        if (resolution >= 512)
          for (let i = 0; i < packed.length; i++)
            if (packed[i])
              await archive.store(
                String(i),
                { ...packed[i], sourceSize: { fixture: i } },
                renderer,
              );
        const started = performance.now();
        for (const order of orders) {
          original.reset();
          tiled.reset();
          for (const i of order) {
            original.push(...inputs[i]);
            const p = packed[i];
            const restored = await archive.restore(String(i), renderer);
            if (restored) {
              try {
                tiled.push(restored.color, restored.quality, restored.tiles);
              } finally {
                restored.dispose();
              }
            } else if (p) tiled.push(p.color.texture, p.qualityTexture, p.tiles);
            else tiled.push(...inputs[i]);
          }
          for (const alpha of [false, true]) {
            const a = (await original.readCorrected(alpha)).output,
              b = (await tiled.readCorrected(alpha)).output;
            let differences = 0;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences++;
            if (differences)
              throw Error(`${resolution} ${order} alpha=${alpha}: ${differences} differing bytes`);
          }
          if ((await original.countLayerCoverage()) !== (await tiled.countLayerCoverage()))
            throw Error('Coverage mismatch');
        }
        results.push({
          resolution,
          combinations: orders.length,
          differences: 0,
          compacted: packed.filter(Boolean).length,
          restored: resolution >= 512,
          comparisonMs: Math.round(performance.now() - started),
          fullBytes: resolution * resolution * 5 * layerCount,
          compactBytes: packed.reduce(
            (n, p) =>
              n +
              (p
                ? p.color.width * p.color.height * 5 + p.tiles.index.image.data.byteLength
                : resolution * resolution * 5),
            0,
          ),
        });
      } finally {
        archive.dispose();
        original.dispose();
        tiled.dispose();
        inputs.flat().forEach((t) => t.dispose());
        packed.forEach((p) => {
          p?.color.dispose();
          p?.tiles.index.dispose();
        });
      }
    }
    return results;
  } finally {
    renderer.dispose();
  }
}
