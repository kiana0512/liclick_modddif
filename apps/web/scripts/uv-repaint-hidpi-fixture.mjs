import * as THREE from 'three';
import { UvRepaint, createUvRepaintSourceMaterial } from '../src/engine/localRepaint/uvRepaint.ts';

function check(value, message) {
  if (!value) throw Error(message);
}

// Partial/nonzero tiles expose DPR scaling that a full-frame stamp can conceal.
export async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(256, 256);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  camera.updateMatrixWorld();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  const source = new THREE.ShaderMaterial({
    uniforms: { transparentProjectionOnly: { value: 1 } },
    vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.2,0.1,0.4,1.0);}',
  });
  const bake = createUvRepaintSourceMaterial(source);
  const size = 640; // Last row/column are 128 texels, not a full 256 tile.
  const gl = renderer.getContext();
  const render = renderer.render.bind(renderer);
  const baseline = [];
  const results = [];
  let engine;
  function gpuBytes() {
    const bytes = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(engine.output, 0, 0, size, size, bytes);
    return bytes;
  }
  function verifyPublished(bytes) {
    const cpu = engine.canvas.getContext('2d').getImageData(0, 0, size, size).data;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4,
          j = ((size - y - 1) * size + x) * 4;
        check(bytes[i + 3] === cpu[j + 3], 'GPU/CPU alpha mismatch outside published tiles');
        for (let c = 0; c < 3; c++)
          check(
            (Math.abs(bytes[i + c] - cpu[j + c]) * bytes[i + 3]) / 255 <= 1,
            'GPU/CPU color mismatch',
          ); // Canvas premultiplied-alpha quantization.
      }
  }
  try {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      renderer.setPixelRatio(dpr);
      engine = new UvRepaint(renderer, [mesh], size);
      await engine.prepare(bake, camera);
      let passes = 0;
      renderer.render = (scene, view) => {
        if ([engine.source, engine.output].includes(renderer.getRenderTarget())) {
          const [x, y, width, height] = gl.getParameter(gl.SCISSOR_BOX);
          check(
            gl.isEnabled(gl.SCISSOR_TEST) &&
              x % 256 === 0 &&
              y % 256 === 0 &&
              width === Math.min(256, size - x) &&
              height === Math.min(256, size - y),
            `DPR ${dpr}: UV scissor is not physical tile bounds: ${[x, y, width, height]}`,
          );
          passes++;
        }
        return render(scene, view);
      };
      const coverage = [];
      for (const [index, [x, y, erase]] of [
        [0.15, 0.15],
        [0.5, 0.5],
        [0.9, 0.9],
        [0.6, 0.5],
        [0.5, 0.5, true],
      ].entries()) {
        const before = gpuBytes();
        engine.begin();
        engine.stamp({
          camera,
          to: new THREE.Vector2(x, y),
          viewport: new THREE.Vector2(256, 256),
          radius: 18,
          feather: 0.35,
          erase: Boolean(erase),
        });
        const patches = await engine.end();
        check(patches.length > 0, `DPR ${dpr}: stroke ${index} was lost`);
        engine.publish(patches, 'after');
        const after = gpuBytes();
        verifyPublished(after);
        if (dpr === 1) baseline.push(after);
        else
          check(
            after.every((v, i) => v === baseline[index][i]),
            `DPR ${dpr}: stroke ${index} differs from DPR 1`,
          );
        engine.publish(patches, 'before', true);
        check(
          gpuBytes().every((v, i) => v === before[i]),
          'undo changed physical UV pixels',
        );
        engine.publish(patches, 'after', true);
        check(
          gpuBytes().every((v, i) => v === after[i]),
          'redo changed physical UV pixels',
        );
        coverage.push(after.filter((v, i) => i % 4 === 3 && v > 0).length);
      }
      renderer.render = render;
      const saved = engine.canvas;
      engine.dispose();
      engine = new UvRepaint(renderer, [mesh], size);
      await engine.prepare(bake, camera, saved);
      verifyPublished(gpuBytes());
      engine.dispose();
      results.push({ dpr, passes, coverage });
    }
    return {
      hidpi: 'physical scissor / exact RGBA / partial tiles / undo / redo / erase / reopen',
      results,
    };
  } finally {
    renderer.render = render;
    engine?.dispose();
    bake.dispose();
    source.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    renderer.dispose();
  }
}
