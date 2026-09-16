import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';
import { createUvOverlayPreviewMaterial, createProjectedLayerMaterial,
  createProjectedLayerStackMaterial, disposeGeneratedMaterialTree } from '../src/engine/projection/ProjectedLayerMaterial.ts';
import { serializeCamera } from '../src/engine/projection/ProjectionCamera.ts';
import { registerLiveUvRenderTarget, unregisterLiveUvRenderTarget, getLiveProjectedTexture,
  getLiveProjectedTextureBlob, releaseLiveProjectedCanvasTexture } from '../src/engine/projection/liveProjectedCanvasTextureRegistry.ts';
import { compositeUvLayersInWorker } from '../src/engine/layers/uvLayerCompositeWorker.ts';
import { createWorkerBackedPreviewTexture, uploadPreviewTextureInStripes } from '../src/engine/viewport/previewTextureCache.ts';

/* global createImageBitmap */
export async function run(feather = 0) {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(128, 128);
  renderer.toneMapping = THREE.NoToneMapping;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2; camera.updateMatrixWorld();
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const source = new THREE.ShaderMaterial({
    uniforms: { transparentProjectionOnly: { value: 1 } },
    vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.5,0.5,0.5,1.0);}',
  });
  const bake = createUvRepaintSourceMaterial(source);
  const engine = new UvRepaint(renderer, [mesh], 32);
  await engine.prepare(bake, camera);
  engine.begin();
  engine.stamp({ camera, to: new THREE.Vector2(0.5, 0.5), viewport: new THREE.Vector2(128, 128),
    radius: 40, feather, erase: false });
  engine.publish(await engine.end(), 'after');
  const canvasBefore = engine.canvas.getContext('2d').getImageData(0, 0, 32, 32).data;
  const url = registerLiveUvRenderTarget('alpha-edge-regression', engine.canvas, engine.texture);
  const target = new THREE.WebGLRenderTarget(128, 128);
  const base = new THREE.DataTexture(new Uint8Array([188, 188, 188, 255]), 1, 1);
  base.colorSpace = THREE.SRGBColorSpace; base.needsUpdate = true;
  const attribution = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  attribution.needsUpdate = true;
  const scene = new THREE.Scene(); scene.add(mesh);
  const previewLighting = { enabled: false, exposure: 1, ambientIntensity: 0.5,
    keyLightIntensity: 1.22, keyLightDirection: [0.35, 0.7, 0.45] };
  const render = material => {
    mesh.material = material;
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    const pixels = new Uint8Array(128 * 128 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
    disposeGeneratedMaterialTree(material);
    return pixels;
  };
  const draw = (texture, live) => {
    const material = createUvOverlayPreviewMaterial({ displayMode: 'flat', selected: false, showEmptyUvChecker: false,
      previewLighting,
      baseTexture: base, baseTextureOpacity: 1, baseRenderedColorMaskTexture: attribution,
      ...(live ? { liveUvOverlayTexture: texture, liveUvOverlayOpacity: 1, liveUvOverlayRenderedColor: true }
        : { uvOverlayTexture: texture, uvOverlayOpacity: 1, uvOverlayRenderedColor: true }),
    });
    return render(material);
  };
  const reference = draw(undefined, true);
  const rows = [];
  const check = (name, texture, live = true) => {
    const pixels = draw(texture, live);
    let maxDarkening = 0;
    for (let i = 0; i < pixels.length; i += 4) maxDarkening = Math.max(maxDarkening, reference[i] - pixels[i]);
    rows.push({ name, maxDarkening });
  };
  check('live GPU', getLiveProjectedTexture(url));
  const png = await getLiveProjectedTextureBlob(url);
  unregisterLiveUvRenderTarget(url, engine.texture);
  check('retired GPU / canvas', getLiveProjectedTexture(url));
  const bitmap = await createImageBitmap(png, { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
  const reopened = new THREE.Texture(bitmap); reopened.flipY = false;
  reopened.colorSpace = THREE.SRGBColorSpace; reopened.needsUpdate = true;
  check('reopened PNG', reopened);
  const blank = document.createElement('canvas'); blank.width = blank.height = 32;
  const composed = await compositeUvLayersInWorker([
    { bitmap: await createImageBitmap(engine.canvas), opacity: 1 },
    { bitmap: await createImageBitmap(blank), opacity: 1 },
  ], 'alpha-edge-regression');
  const lower = await createWorkerBackedPreviewTexture(composed);
  await uploadPreviewTextureInStripes(renderer, lower);
  check('added upper layer / lower composite', lower, false);
  check('removed upper layer / original restored', getLiveProjectedTexture(url));
  const fallback = document.createElement('canvas'); fallback.width = fallback.height = 32;
  const fallbackContext = fallback.getContext('2d');
  fallbackContext.drawImage(engine.canvas, 0, 0);
  fallbackContext.drawImage(blank, 0, 0);
  const fallbackTexture = new THREE.CanvasTexture(fallback);
  check('CPU canvas composite', fallbackTexture, false);
  const canvasAfter = engine.canvas.getContext('2d').getImageData(0, 0, 32, 32).data;
  if (canvasBefore.some((value, i) => value !== canvasAfter[i])) throw Error('Authored RGBA changed');
  releaseLiveProjectedCanvasTexture(url, engine.canvas);
  reopened.dispose(); lower.dispose(); fallbackTexture.dispose(); bitmap.close(); composed.close();
  // Independent numerical oracle: alpha-weighted linear RGB over a black base.
  // Non-square, coloured texels exercise orientation, clamp edges, opaque colour
  // interpolation, partial alpha, hidden RGB at zero alpha and layer opacity.
  const sampling = [];
  const layer = { layerId: 'empty-projection', objectId: 'fixture', imageUrl: blank.toDataURL(),
    camera: serializeCamera(camera, 1, new THREE.Vector3()), opacity: 1, visible: true,
    strength: 1, useDepthCheck: false, useNormalCheck: false, useMask: false, ignoreSourceAlpha: false };
  const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  base.image.data.set([0, 0, 0, 255]); base.needsUpdate = true;
  for (const opaque of [false, true]) {
    const rgba = new Uint8Array([255, 0, 0, 0, 20, 160, 240, 64, 250, 190, 80, 255,
      180, 70, 30, 128, 30, 220, 60, 255, 0, 0, 255, 0]);
    if (opaque) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const texture = new THREE.DataTexture(rgba, 3, 2);
    texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
    for (const opacity of [1, 0.4]) {
      const common = { baseTexture: base, baseTextureOpacity: 1, baseColor: 0, previewLighting };
      const uv = { uvOverlayTexture: texture, uvOverlayOpacity: opacity };
      const top = { topUvOverlayTexture: texture, topUvOverlayOpacity: opacity };
      const factories = {
        'UV lower': () => createUvOverlayPreviewMaterial({ ...common, ...uv, displayMode: 'flat', selected: false, showEmptyUvChecker: false }),
        'UV live': () => createUvOverlayPreviewMaterial({ ...common, liveUvOverlayTexture: texture, liveUvOverlayOpacity: opacity, displayMode: 'flat', selected: false, showEmptyUvChecker: false }),
        'projection UV': () => createProjectedLayerMaterial({ ...common, ...layer, ...uv }),
        'projection top': () => createProjectedLayerMaterial({ ...common, ...layer, ...top }),
        'stack UV': () => createProjectedLayerStackMaterial({ ...common, ...uv, layers: [layer, { ...layer, layerId: 'empty-2' }] }),
        'stack top': () => createProjectedLayerStackMaterial({ ...common, ...top, layers: [layer, { ...layer, layerId: 'empty-2' }] }),
      };
      for (const [name, create] of Object.entries(factories)) {
        const pixels = render(await create());
        let maxError = 0;
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
          const u = (x + 0.5) * 3 / 128 - 0.5, v = (y + 0.5) * 2 / 128 - 0.5;
          const left = Math.floor(u), bottom = Math.floor(v), fx = u - left, fy = v - bottom;
          for (let channel = 0; channel < 3; channel++) {
            let expected = 0;
            for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
              const offset = (Math.max(0, Math.min(1, bottom + dy)) * 3 + Math.max(0, Math.min(2, left + dx))) * 4;
              expected += linear(rgba[offset + channel] / 255) * rgba[offset + 3] / 255 *
                (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * opacity;
            }
            maxError = Math.max(maxError, Math.abs(pixels[(y * 128 + x) * 4 + channel] - Math.round(expected * 255)));
          }
        }
        sampling.push({ name, opaque, opacity, maxError });
      }
    }
    texture.dispose();
  }
  target.dispose(); base.dispose(); attribution.dispose(); engine.dispose(); source.dispose(); bake.dispose(); geometry.dispose(); renderer.dispose();
  if (rows.some(row => row.maxDarkening > 1)) throw Error(`Transparent UV edge darkening: ${JSON.stringify(rows)}`);
  if (sampling.some(row => row.maxError > 1)) throw Error(`UV sampling error: ${JSON.stringify(sampling)}`);
  return { feather, rows, sampling, authoredPixelsUnchanged: true };
}
