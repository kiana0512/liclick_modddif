import * as THREE from 'three';
import { UvRepaint } from '../src/engine/localRepaint/uvRepaint.ts';

// Count every interior texel: sparse point assertions cannot detect pinholes.
export async function run(renderer) {
  const size = renderer.getSize(new THREE.Vector2());
  const source = new THREE.ShaderMaterial({
    vertexShader: 'void main(){gl_Position=vec4(uv*2.-1.,0.,1.);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.3,0.1,0.02,1.);}',
    side: THREE.DoubleSide,
  });
  const counts = [];
  const paint = async (engine, camera, viewport) => {
    await engine.prepare(source, camera);
    engine.begin();
    engine.stamp({ camera, to: new THREE.Vector2(.5, .5), viewport,
      radius: 2000, feather: 0, erase: false });
    const patches = await engine.end();
    engine.publish(patches, 'after');
  };
  try {
    for (const curved of [false, true]) {
      const geometry = new THREE.PlaneGeometry(2, 2, 128, 128);
      const p = geometry.getAttribute('position');
      if (curved) for (let i = 0; i < p.count; i++)
        p.setZ(i, .1 * Math.sin(p.getX(i) * 12) * Math.sin(p.getY(i) * 12));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, source);
      try {
        for (const perspective of [false, true]) {
          const camera = perspective ? new THREE.PerspectiveCamera(45, 1, .1, 100)
            : new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 100);
          camera.position.set(0, 0, 5);
          for (const width of [256, 1024, ...(curved && perspective ? [512] : [])]) {
            const high = width === 512, resolution = high ? 4096 : 1024;
            const height = high ? 256 : width;
            if (high) {
              camera.aspect = width / height;
              camera.updateProjectionMatrix();
              camera.position.set(.5, .3, 5);
              camera.lookAt(0, 0, 0);
            }
            renderer.setSize(width, height);
            const engine = new UvRepaint(renderer, [mesh], resolution);
            try {
              await paint(engine, camera, new THREE.Vector2(width, height));
              const margin = resolution / 32, interior = resolution - margin * 2;
              const rgba = engine.canvas.getContext('2d').getImageData(margin, margin, interior, interior).data;
              let missing = 0;
              for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) missing++;
              const entry = { curved, perspective, width, height, resolution, missing, interior: interior * interior };
              if (missing) throw Error(`UV visibility pinholes: ${JSON.stringify(entry)}`);
              counts.push(entry);
            } finally { engine.dispose(); }
          }
        }
      } finally { geometry.dispose(); }
    }
    // A small but resolvable gap must not be swallowed by the slope allowance.
    // Both surfaces slope in screen space; the rear has independent UVs.
    renderer.setSize(256, 256);
    const sheets = [0, -.01].map((z, index) => {
      const geometry = new THREE.PlaneGeometry(2, 2, 32, 32);
      const p = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
      for (let i = 0; i < p.count; i++) {
        p.setZ(i, p.getX(i) * .5 + z);
        uv.setX(i, uv.getX(i) * .4 + index * .6);
      }
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, source);
    });
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
    camera.position.z = 5;
    const engine = new UvRepaint(renderer, sheets, 1024);
    try {
      await paint(engine, camera, new THREE.Vector2(256, 256));
      const pixels = engine.canvas.getContext('2d').getImageData(672, 64, 288, 896).data;
      for (let i = 3; i < pixels.length; i += 4)
        if (pixels[i]) throw Error('Sloped thin rear sheet received paint through the front');
    } finally {
      engine.dispose();
      sheets.forEach(mesh => mesh.geometry.dispose());
    }
    return { visibility: counts, thinSlopedOccluder: 'passed' };
  } finally {
    renderer.setSize(size.x, size.y);
    source.dispose();
  }
}
