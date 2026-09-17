import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';
import { createUvOverlayPreviewMaterial, disposeGeneratedMaterialTree } from '../src/engine/projection/ProjectedLayerMaterial.ts';

// A continuous surface split into two UV islands must not reveal its black
// underlay along the split. The original flat-brush fixture has no UV seams.
export async function run(resolution = 64, angle = 0) {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(512, 256);
  renderer.toneMapping = THREE.NoToneMapping;
  const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 10);
  camera.position.z = 2; camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const meshes = [-0.5, 0.5].map((x, j) => {
    const geometry = new THREE.PlaneGeometry(1, 1), uv = geometry.attributes.uv;
    // At 512 this also exercises gutter writes across a 256-texel history tile.
    const end = resolution === 512 && j === 0 ? 0.5 : 0.4 + j * 0.5;
    const start = 0.1 + j * 0.5;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, start + uv.getX(i) * (end - start), 0.1 + uv.getY(i) * 0.8);
    if (angle) for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i) - (start + end) / 2, v = (uv.getY(i) - 0.5) * 0.5;
      uv.setXY(i, (start + end) / 2 + u * Math.cos(angle) - v * Math.sin(angle),
        0.5 + u * Math.sin(angle) + v * Math.cos(angle));
    }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.x = x; mesh.updateMatrixWorld(); scene.add(mesh); return mesh;
  });
  const source = new THREE.ShaderMaterial({
    uniforms: { transparentProjectionOnly: { value: 1 } },
    vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.5,0.5,0.5,1.0);}',
  });
  const bake = createUvRepaintSourceMaterial(source), engine = new UvRepaint(renderer, meshes, resolution);
  const target = new THREE.WebGLRenderTarget(512, 256);
  const base = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  base.colorSpace = THREE.SRGBColorSpace; base.needsUpdate = true;
  let material;
  const render = texture => {
    if (material) disposeGeneratedMaterialTree(material);
    material = createUvOverlayPreviewMaterial({ displayMode: 'flat', selected: false,
      showEmptyUvChecker: false, baseTexture: base, baseTextureOpacity: 1,
      liveUvOverlayTexture: texture, liveUvOverlayOpacity: 1,
      previewLighting: { enabled: false, exposure: 1, ambientIntensity: 0,
        keyLightIntensity: 0, keyLightDirection: [0, 0, 1] } });
    meshes.forEach(mesh => { mesh.material = material; });
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    const pixels = new Uint8Array(512 * 256 * 4);
    renderer.readRenderTargetPixels(target, 0, 0, 512, 256, pixels);
    return pixels;
  };
  const stamp = async erase => {
    engine.begin(); engine.stamp({ camera, to: new THREE.Vector2(0.5, 0.5),
      viewport: new THREE.Vector2(512, 256), radius: 500, feather: 0, erase });
    const patches = await engine.end(); engine.publish(patches, 'after'); return patches;
  };
  try {
    await engine.prepare(bake, camera);
    const patches = await stamp(false), live = render(engine.texture);
    const reference = live[(128 * 512 + 128) * 4];
    if (reference !== 128) throw Error(`Authored core colour changed: ${reference}`);
    let maxDarkening = 0;
    for (let x = 248; x < 264; x++)
      maxDarkening = Math.max(maxDarkening, reference - live[(128 * 512 + x) * 4]);
    if (maxDarkening > 1) throw Error(`UV island edge darkening: ${maxDarkening} at ${resolution}`);
    const canvasTexture = new THREE.CanvasTexture(engine.canvas);
    canvasTexture.colorSpace = THREE.SRGBColorSpace;
    const reopened = render(canvasTexture); canvasTexture.dispose();
    if (live.some((v, i) => v !== reopened[i])) throw Error('Published canvas differs from live gutter');
    engine.publish(patches, 'before', true);
    if (render(engine.texture).some((v, i) => i % 4 !== 3 && v)) throw Error('Undo left a gutter');
    engine.publish(patches, 'after', true);
    const restored = render(engine.texture);
    if (live.some((v, i) => v !== restored[i])) throw Error('Redo differs');
    await stamp(true);
    if (render(engine.texture).some((v, i) => i % 4 !== 3 && v)) throw Error('Erase left a gutter');
    return { resolution, angle, maxDarkening, canvasMatches: true, undoRedoErase: true };
  } finally {
    if (material) disposeGeneratedMaterialTree(material);
    engine.dispose(); source.dispose(); bake.dispose(); target.dispose(); base.dispose();
    meshes.forEach(mesh => mesh.geometry.dispose()); renderer.dispose();
  }
}
