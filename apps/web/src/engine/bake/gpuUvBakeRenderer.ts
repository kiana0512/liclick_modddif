import * as THREE from 'three';
import type { BakeProgress, UvBakeResolution } from './uvBakeTypes';
import { buildProjectionMatrixBundle } from '@/engine/projection/projectionMath';
import type { Layer } from '@/types/layer';

const NDV_HARD_REJECT = -0.35;
const NDV_COVERAGE_START = -0.25;
const NDV_COVERAGE_END = 0.08;
const BASE_ANGLE_GAMMA = 4;
const MAX_STRENGTH_FOR_ANGLE = 3;
const SHARPEN_AMOUNT = 0.24;
const SHARPEN_DETAIL_THRESHOLD = 5 / 255;
const MAX_GPU_SHARPEN_RESOLUTION = 4096;
const CLAY_TEXTURE_FILL: [number, number, number] = [244, 245, 242];

type GpuLayerStackBakeInput = {
  renderer: THREE.WebGLRenderer;
  group: THREE.Group;
  layers: Layer[];
  resolution: UvBakeResolution;
  enableBackfaceCulling: boolean;
  enableDilation: boolean;
  dilationPixels: number;
  onProgress?: (progress: BakeProgress) => void;
};

export type GpuLayerStackBakeOutput = {
  canvas: HTMLCanvasElement;
  coverage: Uint8Array;
  postProcessedOnGpu: boolean;
  opaqueBaseColorReady: boolean;
  totalTriangles: number;
  processedTriangles: number;
  coveredPixels: number;
  skippedPixels: number;
  inFrustumPixels: number;
  maskRejectedPixels: number;
  depthRejectedPixels: number;
  backfaceRejectedPixels: number;
  warnings: string[];
};

type PreparedMesh = {
  source: THREE.Mesh;
  triangleCount: number;
};

type LoadedLayerTextures = {
  projectedTexture: THREE.Texture;
  maskTexture: THREE.Texture;
  depthTexture: THREE.Texture;
  useMask: boolean;
  useDepthCheck: boolean;
  disposableTextures: THREE.Texture[];
};

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(normalMatrix * normal);
    gl_Position = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D projectedMap;
  uniform sampler2D maskMap;
  uniform sampler2D depthMap;
  uniform mat4 projectorMatrix;
  uniform mat4 objectMatrixDelta;
  uniform mat3 objectNormalDelta;
  uniform vec3 projectorPosition;
  uniform float layerOpacity;
  uniform float layerStrength;
  uniform float useMask;
  uniform float useDepthCheck;
  uniform float enableBackfaceCulling;
  uniform float depthBias;
  uniform float hueShift;
  uniform float saturationShift;
  uniform float lightnessShift;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  float hueToRgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0 / 2.0) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
  }

  vec3 rgbToHsl(vec3 color) {
    float maxChannel = max(color.r, max(color.g, color.b));
    float minChannel = min(color.r, min(color.g, color.b));
    float lightness = (maxChannel + minChannel) * 0.5;
    if (maxChannel == minChannel) return vec3(0.0, 0.0, lightness);

    float delta = maxChannel - minChannel;
    float saturation = lightness > 0.5
      ? delta / (2.0 - maxChannel - minChannel)
      : delta / (maxChannel + minChannel);
    float hue = 0.0;
    if (maxChannel == color.r) hue = (color.g - color.b) / delta + (color.g < color.b ? 6.0 : 0.0);
    if (maxChannel == color.g) hue = (color.b - color.r) / delta + 2.0;
    if (maxChannel == color.b) hue = (color.r - color.g) / delta + 4.0;
    return vec3(hue / 6.0, saturation, lightness);
  }

  vec3 hslToRgb(vec3 hsl) {
    if (hsl.y == 0.0) return vec3(hsl.z);
    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;
    return vec3(
      hueToRgb(p, q, hsl.x + 1.0 / 3.0),
      hueToRgb(p, q, hsl.x),
      hueToRgb(p, q, hsl.x - 1.0 / 3.0)
    );
  }

  vec3 applyHslAdjustments(vec3 color) {
    if (abs(hueShift) < 0.0001 && abs(saturationShift) < 0.0001 && abs(lightnessShift) < 0.0001) {
      return color;
    }
    vec3 hsl = rgbToHsl(color);
    hsl.x = mod(hsl.x + hueShift + 1.0, 1.0);
    hsl.y = clamp(hsl.y + saturationShift, 0.0, 1.0);
    hsl.z = clamp(hsl.z + lightnessShift, 0.0, 1.0);
    return hslToRgb(hsl);
  }

  float unpackDepth(vec4 rgbaDepth) {
    const vec4 bitShift = vec4(
      1.0 / (256.0 * 256.0 * 256.0),
      1.0 / (256.0 * 256.0),
      1.0 / 256.0,
      1.0
    );
    return dot(rgbaDepth, bitShift);
  }

  float computeAngleWeight(float ndv, float strength) {
    float strengthClamped = clamp(strength, 0.25, ${MAX_STRENGTH_FOR_ANGLE.toFixed(1)});
    float gamma = ${BASE_ANGLE_GAMMA.toFixed(1)} / strengthClamped;
    float frontFade = smoothstep(0.02, 0.25, ndv);
    return frontFade * pow(clamp(ndv, 0.0, 1.0), gamma);
  }

  void main() {
    vec4 captureWorldPosition = objectMatrixDelta * vec4(vWorldPosition, 1.0);
    vec3 captureWorldNormal = normalize(objectNormalDelta * vWorldNormal);
    vec4 projected = projectorMatrix * captureWorldPosition;
    if (abs(projected.w) < 0.0001) discard;

    vec3 ndc = projected.xyz / projected.w;
    if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
      discard;
    }

    vec2 imageUv = ndc.xy * 0.5 + 0.5;
    imageUv.y = 1.0 - imageUv.y;

    vec3 projectorViewDir = normalize(projectorPosition - captureWorldPosition.xyz);
    float ndv = dot(captureWorldNormal, projectorViewDir);
    float frontFacing = step(${NDV_HARD_REJECT.toFixed(2)}, ndv);
    if (enableBackfaceCulling > 0.5 && frontFacing < 0.5) discard;
    float angleCoverage = smoothstep(${NDV_COVERAGE_START.toFixed(2)}, ${NDV_COVERAGE_END.toFixed(2)}, ndv);
    if (angleCoverage <= 0.0001) discard;

    vec4 maskTexel = texture2D(maskMap, imageUv);
    float maskValue = max(maskTexel.r, max(maskTexel.g, maskTexel.b));
    if (useMask > 0.5 && maskValue < 0.094) discard;

    float projectedDepth = ndc.z * 0.5 + 0.5;
    float capturedDepth = unpackDepth(texture2D(depthMap, imageUv));
    float depthErr = abs(projectedDepth - capturedDepth);
    float depthWeight = useDepthCheck > 0.5
      ? mix(0.2, 1.0, exp(-pow(depthErr / max(depthBias + 0.055, 0.000001), 2.0)))
      : 1.0;

    vec4 texel = texture2D(projectedMap, imageUv);
    texel.rgb = applyHslAdjustments(texel.rgb);
    if (texel.a < 0.01) discard;
    float angleWeight = computeAngleWeight(ndv, layerStrength);
    float alpha = clamp(texel.a * layerOpacity * angleCoverage, 0.0, 1.0);
    if (alpha <= 0.016) discard;

    gl_FragColor = vec4(texel.rgb, max(alpha, alpha * depthWeight * angleWeight));
  }
`;

const fullscreenVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const dilationFragmentShader = `
  uniform sampler2D sourceMap;
  uniform vec2 texelSize;
  varying vec2 vUv;

  vec4 unpremultiply(vec4 color) {
    if (color.a <= 0.0001) return vec4(0.0);
    return vec4(color.rgb / color.a, color.a);
  }

  void main() {
    vec4 center = texture2D(sourceMap, vUv);
    if (center.a > 0.0001) {
      gl_FragColor = center;
      return;
    }

    vec4 left = texture2D(sourceMap, vUv + vec2(-texelSize.x, 0.0));
    if (left.a > 0.0001) {
      gl_FragColor = vec4(unpremultiply(left).rgb, 1.0);
      return;
    }

    vec4 right = texture2D(sourceMap, vUv + vec2(texelSize.x, 0.0));
    if (right.a > 0.0001) {
      gl_FragColor = vec4(unpremultiply(right).rgb, 1.0);
      return;
    }

    vec4 up = texture2D(sourceMap, vUv + vec2(0.0, texelSize.y));
    if (up.a > 0.0001) {
      gl_FragColor = vec4(unpremultiply(up).rgb, 1.0);
      return;
    }

    vec4 down = texture2D(sourceMap, vUv + vec2(0.0, -texelSize.y));
    if (down.a > 0.0001) {
      gl_FragColor = vec4(unpremultiply(down).rgb, 1.0);
      return;
    }

    gl_FragColor = vec4(0.0);
  }
`;

const sharpenFragmentShader = `
  uniform sampler2D sourceMap;
  uniform vec2 texelSize;
  uniform float sharpenAmount;
  uniform float detailThreshold;
  varying vec2 vUv;

  vec3 straightRgb(vec4 color) {
    if (color.a <= 0.0001) return vec3(0.0);
    return color.rgb / color.a;
  }

  vec4 sampleColor(vec2 uv) {
    return texture2D(sourceMap, uv);
  }

  void main() {
    vec4 center = sampleColor(vUv);
    if (center.a <= 0.0001) {
      gl_FragColor = center;
      return;
    }

    vec3 centerRgb = straightRgb(center);
    vec3 weightedSum = vec3(0.0);
    float totalWeight = 0.0;

    for (int oy = -1; oy <= 1; oy += 1) {
      for (int ox = -1; ox <= 1; ox += 1) {
        vec2 sampleUv = clamp(vUv + vec2(float(ox), float(oy)) * texelSize, vec2(0.0), vec2(1.0));
        vec4 sampleTexel = sampleColor(sampleUv);
        if (sampleTexel.a <= 0.0001) continue;
        float weight = ox == 0 && oy == 0 ? 4.0 : (ox == 0 || oy == 0 ? 2.0 : 1.0);
        weightedSum += straightRgb(sampleTexel) * weight;
        totalWeight += weight;
      }
    }

    vec3 blurred = totalWeight > 0.0 ? weightedSum / totalWeight : centerRgb;
    vec3 detail = centerRgb - blurred;
    vec3 sharpened = mix(centerRgb, centerRgb + detail * sharpenAmount, step(detailThreshold, max(max(abs(detail.r), abs(detail.g)), abs(detail.b))));
    sharpened = clamp(sharpened, 0.0, 1.0);
    gl_FragColor = vec4(sharpened * center.a, center.a);
  }
`;

function usesSourceAlphaMask(layer: Layer) {
  return typeof layer.generationId === 'string' && layer.generationId.startsWith('texture-map');
}

function prepareTexture(texture: THREE.Texture, filter: THREE.MinificationTextureFilter & THREE.MagnificationTextureFilter) {
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function createNeutralTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  return prepareTexture(texture, THREE.NearestFilter);
}

async function loadLayerTextures(layer: Layer): Promise<LoadedLayerTextures> {
  const loader = new THREE.TextureLoader();
  const projectedTexture = prepareTexture(await loader.loadAsync(layer.imageUrl), THREE.LinearFilter);
  const neutralTexture = createNeutralTexture();
  const shouldUseSourceAlpha = usesSourceAlphaMask(layer);
  const maskTexture =
    layer.maskUrl && !shouldUseSourceAlpha
      ? prepareTexture(await loader.loadAsync(layer.maskUrl), THREE.LinearFilter)
      : neutralTexture;
  const depthTexture =
    layer.depthUrl && !shouldUseSourceAlpha
      ? prepareTexture(await loader.loadAsync(layer.depthUrl), THREE.NearestFilter)
      : neutralTexture;
  return {
    projectedTexture,
    maskTexture,
    depthTexture,
    useMask: Boolean(layer.maskUrl && !shouldUseSourceAlpha),
    useDepthCheck: Boolean(layer.depthUrl && !shouldUseSourceAlpha),
    disposableTextures: [...new Set([projectedTexture, maskTexture, depthTexture])],
  };
}

function createObjectMatrixDelta(group: THREE.Group, layer: Layer) {
  group.updateMatrixWorld(true);
  if (!layer.objectMatrixWorld) return new THREE.Matrix4();
  return new THREE.Matrix4().fromArray(layer.objectMatrixWorld).multiply(group.matrixWorld.clone().invert());
}

function getTriangleCount(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute('position');
  const uv = mesh.geometry.getAttribute('uv');
  if (!position || !uv) return 0;
  const index = mesh.geometry.getIndex();
  return index ? index.count / 3 : position.count / 3;
}

function collectPreparedMeshes(group: THREE.Group, warnings: string[]) {
  const meshes: PreparedMesh[] = [];
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry.getAttribute('position');
    const uv = child.geometry.getAttribute('uv');
    if (!position || !uv) {
      warnings.push(`Mesh ${child.name || child.uuid} has no UV or position attribute.`);
      return;
    }
    if (!child.geometry.getAttribute('normal')) {
      child.geometry.computeVertexNormals();
      warnings.push(`Mesh ${child.name || child.uuid} had no normals; computed fallback normals.`);
    }
    meshes.push({ source: child, triangleCount: getTriangleCount(child) });
  });
  return meshes;
}

function createLayerMaterial(input: {
  group: THREE.Group;
  layer: Layer;
  textures: LoadedLayerTextures;
  enableBackfaceCulling: boolean;
}) {
  if (!input.layer.camera) throw new Error('Projected layer has no capture camera.');
  const objectMatrixDelta = createObjectMatrixDelta(input.group, input.layer);
  return new THREE.ShaderMaterial({
    name: `LiclickGpuUvBake:${input.layer.id}`,
    vertexShader,
    fragmentShader,
    uniforms: {
      projectedMap: { value: input.textures.projectedTexture },
      maskMap: { value: input.textures.maskTexture },
      depthMap: { value: input.textures.depthTexture },
      projectorMatrix: { value: buildProjectionMatrixBundle(input.layer.camera).projectorMatrix },
      objectMatrixDelta: { value: objectMatrixDelta },
      objectNormalDelta: { value: new THREE.Matrix3().getNormalMatrix(objectMatrixDelta) },
      projectorPosition: { value: new THREE.Vector3().fromArray(input.layer.camera.position) },
      layerOpacity: { value: input.layer.opacity },
      layerStrength: { value: input.layer.strength ?? 1 },
      useMask: { value: input.textures.useMask ? 1 : 0 },
      useDepthCheck: { value: input.textures.useDepthCheck ? 1 : 0 },
      enableBackfaceCulling: { value: input.enableBackfaceCulling ? 1 : 0 },
      depthBias: { value: 0.02 },
      hueShift: { value: (input.layer.adjustments?.hue ?? 0) / 100 },
      saturationShift: { value: (input.layer.adjustments?.saturation ?? 0) / 100 },
      lightnessShift: { value: (input.layer.adjustments?.lightness ?? 0) / 100 },
    },
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
    premultipliedAlpha: false,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function createBakeScene(meshes: PreparedMesh[], material: THREE.Material) {
  const scene = new THREE.Scene();
  for (const mesh of meshes) {
    const bakeMesh = new THREE.Mesh(mesh.source.geometry, material);
    bakeMesh.matrixAutoUpdate = false;
    bakeMesh.matrix.copy(mesh.source.matrixWorld);
    bakeMesh.frustumCulled = false;
    scene.add(bakeMesh);
  }
  return scene;
}

function createPostprocessTarget(resolution: number) {
  const target = new THREE.WebGLRenderTarget(resolution, resolution, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  return target;
}

function renderFullscreenPass(input: {
  renderer: THREE.WebGLRenderer;
  source: THREE.WebGLRenderTarget;
  target: THREE.WebGLRenderTarget;
  material: THREE.ShaderMaterial;
  camera: THREE.OrthographicCamera;
}) {
  input.material.uniforms.sourceMap.value = input.source.texture;
  input.renderer.setRenderTarget(input.target);
  input.renderer.clear(true, true, true);
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), input.material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  input.renderer.render(scene, input.camera);
  scene.clear();
  mesh.geometry.dispose();
}

function runGpuPostprocess(input: {
  renderer: THREE.WebGLRenderer;
  source: THREE.WebGLRenderTarget;
  resolution: UvBakeResolution;
  enableDilation: boolean;
  dilationPixels: number;
}) {
  let current = input.source;
  const ownedTargets: THREE.WebGLRenderTarget[] = [];
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const texelSize = new THREE.Vector2(1 / input.resolution, 1 / input.resolution);
  const ping = createPostprocessTarget(input.resolution);
  const pong = createPostprocessTarget(input.resolution);
  ownedTargets.push(ping, pong);
  let next = ping;

  const dilationMaterial = new THREE.ShaderMaterial({
    vertexShader: fullscreenVertexShader,
    fragmentShader: dilationFragmentShader,
    uniforms: {
      sourceMap: { value: current.texture },
      texelSize: { value: texelSize },
    },
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  if (input.enableDilation) {
    for (let iteration = 0; iteration < input.dilationPixels; iteration += 1) {
      renderFullscreenPass({
        renderer: input.renderer,
        source: current,
        target: next,
        material: dilationMaterial,
        camera,
      });
      current = next;
      next = next === ping ? pong : ping;
    }
  }
  dilationMaterial.dispose();

  if (input.resolution <= MAX_GPU_SHARPEN_RESOLUTION) {
    const sharpenMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexShader,
      fragmentShader: sharpenFragmentShader,
      uniforms: {
        sourceMap: { value: current.texture },
        texelSize: { value: texelSize },
        sharpenAmount: { value: SHARPEN_AMOUNT },
        detailThreshold: { value: SHARPEN_DETAIL_THRESHOLD },
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    renderFullscreenPass({
      renderer: input.renderer,
      source: current,
      target: next,
      material: sharpenMaterial,
      camera,
    });
    current = next;
    sharpenMaterial.dispose();
  }

  return { target: current, ownedTargets };
}

function readRenderTargetToImageData(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, resolution: number) {
  const pixels = new Uint8Array(resolution * resolution * 4);
  renderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, pixels);

  const imageData = new ImageData(resolution, resolution);
  const coverage = new Uint8Array(resolution * resolution);
  const rowLength = resolution * 4;
  for (let y = 0; y < resolution; y += 1) {
    const sourceStart = (resolution - 1 - y) * rowLength;
    const targetStart = y * rowLength;
    imageData.data.set(pixels.subarray(sourceStart, sourceStart + rowLength), targetStart);
    for (let x = 0; x < resolution; x += 1) {
      const pixelIndex = y * resolution + x;
      const offset = targetStart + x * 4;
      const alphaByte = imageData.data[offset + 3];
      if (alphaByte > 0) {
        if (alphaByte < 255) {
          const alpha = alphaByte / 255;
          imageData.data[offset] = Math.min(255, Math.round(imageData.data[offset] / alpha));
          imageData.data[offset + 1] = Math.min(255, Math.round(imageData.data[offset + 1] / alpha));
          imageData.data[offset + 2] = Math.min(255, Math.round(imageData.data[offset + 2] / alpha));
        }
        coverage[pixelIndex] = 1;
      } else {
        imageData.data[offset] = CLAY_TEXTURE_FILL[0];
        imageData.data[offset + 1] = CLAY_TEXTURE_FILL[1];
        imageData.data[offset + 2] = CLAY_TEXTURE_FILL[2];
        imageData.data[offset + 3] = 255;
      }
    }
  }
  return { imageData, coverage };
}

function restoreRendererState(
  renderer: THREE.WebGLRenderer,
  state: {
    target: THREE.WebGLRenderTarget | null;
    clearColor: THREE.Color;
    clearAlpha: number;
    viewport: THREE.Vector4;
    scissor: THREE.Vector4;
    scissorTest: boolean;
    autoClear: boolean;
    xrEnabled: boolean;
  },
) {
  renderer.setRenderTarget(state.target);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
  renderer.autoClear = state.autoClear;
  renderer.xr.enabled = state.xrEnabled;
}

export async function bakeProjectedLayerStackWithGpu(
  input: GpuLayerStackBakeInput,
): Promise<GpuLayerStackBakeOutput> {
  const { renderer, resolution } = input;
  if (resolution > renderer.capabilities.maxTextureSize) {
    throw new Error(`GPU max texture size is ${renderer.capabilities.maxTextureSize}, requested ${resolution}.`);
  }

  const warnings: string[] = [];
  const meshes = collectPreparedMeshes(input.group, warnings);
  const totalTrianglesPerLayer = meshes.reduce((sum, mesh) => sum + mesh.triangleCount, 0);
  const totalTriangles = totalTrianglesPerLayer * input.layers.length;
  if (totalTriangles <= 0) throw new Error('No UV triangles were available for GPU baking.');

  const renderTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  renderTarget.texture.colorSpace = THREE.NoColorSpace;

  const previousState = {
    target: renderer.getRenderTarget(),
    clearColor: renderer.getClearColor(new THREE.Color()),
    clearAlpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear,
    xrEnabled: renderer.xr.enabled,
  };

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  let processedTriangles = 0;
  let lastProgressAt = 0;
  const reportProgress = (layer: Layer, layerIndex: number, force = false) => {
    if (!input.onProgress) return;
    const now = performance.now();
    if (!force && now - lastProgressAt < 80) return;
    lastProgressAt = now;
    input.onProgress({
      phase: 'rasterizing',
      progress: totalTriangles > 0 ? processedTriangles / totalTriangles : 0,
      layerName: layer.name,
      layerIndex,
      layerCount: input.layers.length,
      processedTriangles,
      totalTriangles,
    });
  };

  try {
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, resolution, resolution);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);

    for (const [layerIndex, layer] of input.layers.entries()) {
      input.onProgress?.({
        phase: 'loading-assets',
        progress: 0.04 + (layerIndex / input.layers.length) * 0.78,
        layerName: layer.name,
        layerIndex,
        layerCount: input.layers.length,
      });
      const textures = await loadLayerTextures(layer);
      const material = createLayerMaterial({
        group: input.group,
        layer,
        textures,
        enableBackfaceCulling: input.enableBackfaceCulling,
      });
      const scene = createBakeScene(meshes, material);
      reportProgress(layer, layerIndex, true);
      renderer.render(scene, camera);
      processedTriangles += totalTrianglesPerLayer;
      reportProgress(layer, layerIndex, true);
      scene.clear();
      material.dispose();
      textures.disposableTextures.forEach((texture) => texture.dispose());
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    input.onProgress?.({
      phase: 'compositing',
      progress: 0.88,
      layerIndex: input.layers.length - 1,
      layerCount: input.layers.length,
    });
    const postprocess = runGpuPostprocess({
      renderer,
      source: renderTarget,
      resolution,
      enableDilation: input.enableDilation,
      dilationPixels: input.dilationPixels,
    });
    const { imageData, coverage } = readRenderTargetToImageData(renderer, postprocess.target, resolution);
    postprocess.ownedTargets.forEach((target) => target.dispose());

    let finalCoveredPixels = 0;
    for (let index = 0; index < coverage.length; index += 1) {
      if (coverage[index]) finalCoveredPixels += 1;
    }

    const canvas = document.createElement('canvas');
    canvas.width = resolution;
    canvas.height = resolution;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create GPU UV bake canvas.');
    context.putImageData(imageData, 0, 0);

    warnings.push('GPU bake does not expose per-rejection texel counters yet; fallback CPU remains available for diagnostics.');

    return {
      canvas,
      coverage,
      postProcessedOnGpu: true,
      opaqueBaseColorReady: true,
      totalTriangles,
      processedTriangles,
      coveredPixels: finalCoveredPixels,
      skippedPixels: resolution * resolution - finalCoveredPixels,
      inFrustumPixels: finalCoveredPixels,
      maskRejectedPixels: 0,
      depthRejectedPixels: 0,
      backfaceRejectedPixels: 0,
      warnings,
    };
  } finally {
    restoreRendererState(renderer, previousState);
    renderTarget.dispose();
  }
}
