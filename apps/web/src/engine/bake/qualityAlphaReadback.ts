import * as THREE from 'three';
import { readRenderTargetPixelsInStripes } from './gpuReadbackStripes';
import { convertQualityGpuReadbackInWorker } from './gpuReadbackConversionWorker';

// UV-QUALITY-READBACK-PACK/1.0.0: four original alpha bytes per RGBA texel.
// This changes transfer layout only; the full-resolution CPU QA is unchanged.
export class QualityAlphaReadback {
  private target?: THREE.WebGLRenderTarget;
  private material?: THREE.RawShaderMaterial;
  private mesh?: THREE.Mesh;
  private readonly camera = new THREE.Camera();

  constructor(private renderer: THREE.WebGLRenderer, private resolution: number) {}

  async read(source: THREE.WebGLRenderTarget, texture = source.texture) {
    const { renderer, resolution } = this;
    if (!renderer.capabilities.isWebGL2 || resolution % 2) {
      return convertQualityGpuReadbackInWorker(
        await readRenderTargetPixelsInStripes(renderer, source, resolution), resolution,
      );
    }
    const size = resolution / 2;
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(size, size, {
        depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      this.material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
        blending: THREE.NoBlending, toneMapped: false,
        uniforms: { source: { value: texture }, width: { value: resolution }, redChannel: { value: false } },
        vertexShader: `in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }`,
        fragmentShader: `precision highp float;
precision highp int;
uniform sampler2D source;
uniform int width;
uniform bool redChannel;
out vec4 outColor;
float alphaAt(int i) {
  vec4 value = texelFetch(source, ivec2(i % width, i / width), 0);
  return redChannel ? value.r : value.a;
}
void main() {
  int i = (int(gl_FragCoord.y) * (width / 2) + int(gl_FragCoord.x)) * 4;
  outColor = vec4(alphaAt(i), alphaAt(i + 1), alphaAt(i + 2), alphaAt(i + 3));
}`,
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0], 3));
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.frustumCulled = false;
    }
    this.material!.uniforms.source.value = texture;
    this.material!.uniforms.redChannel.value = texture.format === THREE.RedFormat;
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear, xr = renderer.xr.enabled;
    const pixelRatio = renderer.getPixelRatio();
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      renderer.setPixelRatio(1);
      renderer.setRenderTarget(this.target);
      renderer.setViewport(0, 0, size, size);
      renderer.setScissorTest(false);
      renderer.render(this.mesh!, this.camera);
    } finally {
      // Never hold the viewport framebuffer across an asynchronous readback.
      renderer.setPixelRatio(pixelRatio);
      renderer.setRenderTarget(target, face, mip);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xr;
    }
    const pixels = await readRenderTargetPixelsInStripes(renderer, this.target, size);
    return convertQualityGpuReadbackInWorker(pixels, resolution, true);
  }

  dispose() {
    this.target?.dispose();
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
