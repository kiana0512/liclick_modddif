import * as THREE from 'three';
import { createProjectedLayerMaterial, createProjectedLayerStackMaterial } from '../src/engine/projection/ProjectedLayerMaterial';

// Isolated WebGL fixture: no editor, stores, paid generation or project writes.
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(256, 256);
document.body.appendChild(renderer.domElement);
const sourceCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
sourceCamera.position.z = 5;
sourceCamera.updateMatrixWorld(true);
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 8;
const context = canvas.getContext('2d')!;
function colorUrl(color: string) {
  context.fillStyle = color;
  context.fillRect(0, 0, 8, 8);
  return canvas.toDataURL();
}
const input = {
  layerId: 'test-repaint', imageUrl: colorUrl('#ff0000'), objectId: 'fixture',
  camera: { projectionMatrix: sourceCamera.projectionMatrix.toArray(), matrixWorld: sourceCamera.matrixWorld.toArray(),
    viewMatrix: sourceCamera.matrixWorldInverse.toArray(), position: [0, 0, 5], near: 0.1, far: 100 },
  opacity: 1, visible: true, depthTest: true, ignoreSourceAlpha: true,
  projectionVisibilityPolicy: 'surface-locked-v1', minimumProjectionFacing: 0.08,
  compositeRole: 'overlay', previewLighting: { enabled: false, exposure: 1, ambientIntensity: 1,
    keyLightIntensity: 0, keyLightDirection: [0, 0, 1] },
} as Parameters<typeof createProjectedLayerMaterial>[0];
const overlayMaterial = await createProjectedLayerMaterial({ ...input, transparentProjectionOnly: true });
const blue = { ...input, layerId: 'base', imageUrl: colorUrl('#0000ff') };
const direct = await createProjectedLayerMaterial(blue);
const diagnostic = await createProjectedLayerMaterial({ ...blue, layerId: 'diagnostic', opacity: 0 });
const stackInput = { ...blue, layers: [blue, { ...blue, layerId: 'second' }] };
const stack = await createProjectedLayerStackMaterial(stackInput, { renderer, preferTextureArrays: false });
const array = await createProjectedLayerStackMaterial(stackInput, { renderer, preferTextureArrays: true });
if (!stack || !array) throw new Error('Both production stack paths must be available');

// Known capture-visible plane at viewDepth=5, independently occluded in the
// inspection view. Keep the production capture-depth gate ON throughout.
const metric = (5 - 0.1) / (100 - 0.1);
const depth = new THREE.DataTexture(new Uint8Array([
  Math.floor(metric * 256), Math.floor(metric * 65536) % 256,
  Math.round((metric * 65536 % 1) * 255), 255,
]), 1, 1);
depth.needsUpdate = true;
const mask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
mask.needsUpdate = true;
Object.assign(overlayMaterial.uniforms, {
  depthMap: { value: depth }, useDepthCheck: { value: 1 }, depthIsLinearView: { value: 1 },
  maskMap: { value: mask }, useMask: { value: 1 },
});
const scene = new THREE.Scene();
const geometry = new THREE.PlaneGeometry(2, 2, 8, 8);
const base = new THREE.Mesh(geometry, direct);
const shell = new THREE.Mesh(new THREE.PlaneGeometry(1, 2), new THREE.MeshBasicMaterial({ color: '#ffff00' }));
shell.position.x = 0.5;
const overlay = new THREE.Mesh(geometry, overlayMaterial);
overlay.renderOrder = 999999;
const coincident = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), diagnostic);
coincident.renderOrder = 1;
scene.add(base, shell, overlay, coincident);
const target = new THREE.WebGLRenderTarget(256, 256);
const pixels = new Uint8Array(256 * 256 * 4);
const sourceShaders = new Map([overlayMaterial, direct, stack, array, diagnostic].map(m => [m, m.fragmentShader]));
const results: Record<string, unknown>[] = [];
const failures: Record<string, unknown>[] = [];
for (const mode of ['legacy', 'current']) {
  // Frozen old depth formulas are a negative control, not a second algorithm.
  for (const material of sourceShaders.keys()) {
    material.fragmentShader = sourceShaders.get(material)!;
    if (mode === 'legacy') material.fragmentShader = material.fragmentShader.replace(
      /projectedRasterDepth\(gl_FragCoord.z, projectedDepthPriority\)/g,
      `clamp(gl_FragCoord.z + mix(0.000006, ${material === overlayMaterial ? '-0.000080' : '-0.000006'}, projectedDepthPriority), 0.0, 1.0)`,
    );
    material.needsUpdate = true;
  }
  overlayMaterial.polygonOffset = mode === 'legacy';
  overlayMaterial.polygonOffsetFactor = overlayMaterial.polygonOffsetUnits = mode === 'legacy' ? -1 : 0;
  for (const [path, material] of [['direct', direct], ['stack', stack], ['array', array]] as const) {
    base.material = material;
    for (const projection of ['perspective', 'orthographic'])
    for (const elevation of [-45, 0, 45])
    for (const distance of [3, 5, 10]) for (const degrees of [-75, -35, 0, 35, 75]) {
      const camera = projection === 'perspective' ? sourceCamera.clone()
        : new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 100);
      const angle = degrees * Math.PI / 180;
      const tilt = elevation * Math.PI / 180;
      camera.position.set(Math.sin(angle) * Math.cos(tilt) * distance, Math.sin(tilt) * distance,
        Math.cos(angle) * Math.cos(tilt) * distance);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      for (const gap of [0.001, 0.005, 0.02]) {
        shell.position.z = gap;
        for (const state of ['painted', 'hidden', 'mask-cleared', 'restored']) {
          overlay.visible = state !== 'hidden';
          mask.image.data.fill(state === 'mask-cleared' ? 0 : 255, 0, 3);
          mask.needsUpdate = true;
          renderer.setRenderTarget(target);
          renderer.render(scene, camera);
          renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
          const sample = (x: number, z: number, y = 0) => {
            const p = new THREE.Vector3(x, y, z).project(camera);
            const index = (Math.floor((p.y + 1) * 128) * 256 + Math.floor((p.x + 1) * 128)) * 4;
            return [...pixels.slice(index, index + 3)];
          };
          const hidden = sample(0.45, gap);
          const exposed = sample(-0.45, 0);
          const wantExposed = state === 'hidden' || state === 'mask-cleared' ? '0,0,255' : '255,0,0';
          const badPoints = [-0.7, -0.45, -0.2].flatMap(x =>
            [-0.7, 0, 0.7].map(y => ({ x, y, pixel: sample(x, 0, y) }))).filter(p => p.pixel.join() !== wantExposed);
          const coplanarMismatch = badPoints.length > 0;
          const row = { mode, path, projection, elevation, distance, degrees, gap, state, hidden, exposed, coplanarMismatch };
          results.push(row);
          if (hidden.join() !== '255,255,0' || exposed.join() !== wantExposed || coplanarMismatch) failures.push({ ...row, badPoints });
        }
      }
    }
  }
}
const gl = renderer.getContext();
const debug = gl.getExtension('WEBGL_debug_renderer_info');
(window as unknown as { __occlusionResult: unknown }).__occlusionResult = {
  renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown', cases: results.length,
  legacyFailures: failures.filter(f => f.mode === 'legacy').length,
  currentFailureCount: failures.filter(f => f.mode === 'current').length,
  currentFailures: failures.filter(f => f.mode === 'current').slice(0, 4),
};
