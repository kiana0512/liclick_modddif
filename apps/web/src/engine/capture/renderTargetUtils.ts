import * as THREE from 'three';
import type { CapturePassRequest, SceneMaterialSnapshot } from './captureTypes';

export function renderSceneToDataUrl(request: CapturePassRequest) {
  const target = new THREE.WebGLRenderTarget(request.width, request.height, {
    samples: 4,
    colorSpace: THREE.SRGBColorSpace,
  });
  const previousTarget = request.gl.getRenderTarget();
  const previousClearColor = new THREE.Color();
  request.gl.getClearColor(previousClearColor);
  const previousClearAlpha = request.gl.getClearAlpha();

  request.gl.setRenderTarget(target);
  request.gl.setClearColor('#000000', 1);
  request.gl.clear();
  request.gl.render(request.scene, request.camera);

  const pixels = new Uint8Array(request.width * request.height * 4);
  request.gl.readRenderTargetPixels(target, 0, 0, request.width, request.height, pixels);

  request.gl.setRenderTarget(previousTarget);
  request.gl.setClearColor(previousClearColor, previousClearAlpha);
  target.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create 2D canvas context for capture.');

  const imageData = context.createImageData(request.width, request.height);
  const rowStride = request.width * 4;
  for (let y = 0; y < request.height; y += 1) {
    const sourceStart = (request.height - y - 1) * rowStride;
    const targetStart = y * rowStride;
    imageData.data.set(pixels.subarray(sourceStart, sourceStart + rowStride), targetStart);
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

export function applyTargetOnlyMaterial(
  scene: THREE.Scene,
  objectId: string,
  materialFactory: () => THREE.Material,
) {
  const snapshots: SceneMaterialSnapshot[] = [];

  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const isTarget = object.userData.liclickObjectId === objectId;
    snapshots.push({ object, visible: object.visible, material: object.material });
    object.visible = isTarget;
    if (isTarget) object.material = materialFactory();
  });

  return () => {
    snapshots.forEach((snapshot) => {
      snapshot.object.visible = snapshot.visible;
      if (snapshot.object instanceof THREE.Mesh && snapshot.material) {
        snapshot.object.material = snapshot.material;
      }
    });
  };
}
