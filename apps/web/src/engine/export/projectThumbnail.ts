import * as THREE from 'three';

export function renderProjectThumbnail(root: THREE.Object3D, width = 640, height = 420) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const renderer = new THREE.WebGLRenderer({
    alpha: false,
    antialias: true,
    canvas,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#343434');

  const clone = root.clone(true);
  const box = new THREE.Box3().setFromObject(clone);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  clone.position.sub(center);
  scene.add(clone);

  scene.add(new THREE.AmbientLight('#fff0e8', 0.7));
  scene.add(new THREE.HemisphereLight('#fff4ee', '#594033', 0.58));
  const key = new THREE.DirectionalLight('#fff7f0', 1.08);
  key.position.set(3, 4, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight('#d8e6ff', 0.3);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(28, width / height, 0.01, Math.max(1000, maxDimension * 100));
  const distance = maxDimension * 1.58;
  camera.position.set(distance * 0.7, distance * 0.4, distance * 1.02);
  camera.lookAt(0, size.y * 0.03, 0);
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL('image/png');
  renderer.dispose();
  return dataUrl;
}
