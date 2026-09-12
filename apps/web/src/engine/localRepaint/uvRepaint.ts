import * as THREE from 'three';
import {
  UV_REPAINT_TILE_SIZE,
  type UvRepaintRect as Rect,
  type UvRepaintPatch,
} from './uvRepaintState';

// ALG-LR-UV-PAINT v1.1.4. Shared UV pixels intentionally share color/alpha.
type Tile = { bounds: Rect; surfaces: Array<{ mesh: THREE.Mesh; box: THREE.Box3 }> };
type Stroke = {
  before?: Map<number, Promise<Uint8Array<ArrayBuffer>>>;
  changed: Set<number>;
};
type ProjectedSurfaceBounds = [left: number, top: number, right: number, bottom: number] | true;

const vertex = `
attribute float repaintFaceId;
flat varying float faceId;
varying vec4 currentClip;
uniform mat4 currentViewProjection;
uniform float uvPass;
void main() {
faceId=repaintFaceId;
currentClip=currentViewProjection*modelMatrix*vec4(position,1.0);
gl_Position=mix(currentClip,vec4(uv*2.0-1.0,0.0,1.0),uvPass);
}
`;
// Screen-space derivatives avoid ill-conditioned inversion on tiny UV triangles.
// Use a conservative local footprint for curved faces, but reject depth breaks
// between the nearest face and neighbouring samples (rail/hole boundaries).
// Float rounding allowance is 2e-6; immutable source occlusion still applies.
const paintFragment = `
flat varying float faceId;
varying vec4 currentClip;
uniform sampler2D visibleFaces;
uniform vec2 visibilitySize;
uniform vec2 viewportSize,brushFrom,brushTo;
uniform float brushRadius,feather,erase;
float frontLimit(vec2 pixel,vec4 anchor,vec2 centre){
vec4 front=texture2D(visibleFaces,(pixel+0.5)/visibilitySize);
float bend=dot(abs(front.zw-anchor.zw),vec2(1.0));
float delta=front.y-anchor.y-dot(anchor.zw,pixel-centre);
if(front.x<0.5||abs(delta)>bend+0.000002)return-1.0;
return front.y+dot(abs(front.zw),vec2(0.5));
}
float repaintWeight(){
vec3 ndc=currentClip.xyz/max(currentClip.w,1e-20);
vec2 screenUv=ndc.xy*0.5+0.5;
if(currentClip.w<=0.0||any(greaterThan(abs(ndc),vec3(1.0))))discard;
vec4 front=texture2D(visibleFaces,screenUv);
if(front.x<0.5)discard;
if(abs(front.x-faceId)>0.5){
vec2 pixel=floor(screenUv*visibilitySize-0.5);
vec2 centre=floor(screenUv*visibilitySize);
float limit=max(max(frontLimit(pixel,front,centre),frontLimit(pixel+vec2(1.0,0.0),front,centre)),
max(frontLimit(pixel+vec2(0.0,1.0),front,centre),frontLimit(pixel+1.0,front,centre)));
if(ndc.z*0.5+0.5>limit+0.000002)discard;
}
vec2 p=vec2(screenUv.x,1.0-screenUv.y)*viewportSize;
vec2 ab=brushTo-brushFrom;
float t=clamp(dot(p-brushFrom,ab)/max(dot(ab,ab),0.0001),0.0,1.0);
float distanceToStroke=length(p-(brushFrom+ab*t))/max(brushRadius,0.001);
if(distanceToStroke>=1.0)discard;
return 1.0-smoothstep(max(0.0,1.0-feather),1.0,distanceToStroke);
}
`;

function target(size: number, depthBuffer = false) {
  return new THREE.WebGLRenderTarget(size, size, {
    depthBuffer,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
}

/** Three's renderer setter applies DPR even offscreen; bounds are UV texels. */
function setUvScissor(renderer: THREE.WebGLRenderer, bounds: Rect) {
  const dpr = renderer.getPixelRatio();
  renderer.setScissor(bounds.x / dpr, bounds.y / dpr, bounds.width / dpr, bounds.height / dpr);
  renderer.setScissorTest(true);
}

/** Render-state isolation is shared by all passes, including exceptional exits. */
function isolated<T>(renderer: THREE.WebGLRenderer, work: () => T): T {
  const previous = renderer.getRenderTarget();
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  const clearColor = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  const autoClear = renderer.autoClear;
  const xr = renderer.xr.enabled;
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    renderer.setScissorTest(false);
    renderer.setClearColor(0, 0);
    return work();
  } finally {
    renderer.setRenderTarget(previous);
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.autoClear = autoClear;
    renderer.xr.enabled = xr;
  }
}

function cloneUniformValues(uniforms: Record<string, THREE.IUniform>) {
  return Object.fromEntries(
    Object.entries(uniforms).map(([key, uniform]) => [key, { value: uniform.value }]),
  );
}

/** Bake the already-verified literal source coverage, without viewport lighting,
 * adjustments or exposure. Source texels are converted back to PNG sRGB bytes.
 * The caller supplies the full-resolution frozen author/allowed mask, not the
 * mutable coverage mask nor the expanded mask sent to the generation service. */
export function createUvRepaintSourceMaterial(source: THREE.ShaderMaterial) {
  const main = /void main\(\)\s*\{/;
  if (!source.uniforms.transparentProjectionOnly || !main.test(source.vertexShader))
    throw new Error('UV repaint requires a literal capture material.');
  const uniforms = cloneUniformValues(source.uniforms);
  for (const name of ['previewLightingEnabled', 'hueShift', 'saturationShift', 'lightnessShift'])
    if (uniforms[name]) uniforms[name].value = 0;
  for (const name of [
    'layerOpacity',
    'layerStrength',
    'previewExposure',
    'transparentProjectionOnly',
  ])
    if (uniforms[name]) uniforms[name].value = 1;
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { ...source.defines },
    vertexShader:
      source.vertexShader.replace(main, 'void capturedVertex() {') +
      `
      void main() { capturedVertex(); gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }
    `,
    fragmentShader: source.fragmentShader.replace(
      /#include <(?:tonemapping|colorspace)_fragment>/g,
      '',
    ),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  return material;
}

/** Mutable shared UV RGBA, with one winning visible sample per texel/stamp. */
export class UvRepaint {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.Texture;
  readonly resolution: number;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private meshes: THREE.Mesh[] = [];
  private originals: THREE.Mesh[] = [];
  private tiles = new Map<number, Tile>();
  private source: THREE.WebGLRenderTarget;
  private output: THREE.WebGLRenderTarget;
  private ids = target(1, true);
  private brush: THREE.ShaderMaterial;
  private identity: THREE.ShaderMaterial;
  private composite: THREE.Mesh;
  private compositeScene = new THREE.Scene();
  private sourceTextures: THREE.Texture[] = [];
  private stroke?: Stroke;
  private visibilityKey = '';
  private projectedTileBoundsKey = '';
  private projectedTileBounds = new Map<number, ProjectedSurfaceBounds[]>();
  private projectedBoundsTransform = new THREE.Matrix4();
  private projectedBoundsPoint = new THREE.Vector4();
  private disposed = false;
  private outputAlive = true;
  private pending = new Set<Promise<unknown>>();

  constructor(renderer: THREE.WebGLRenderer, meshes: THREE.Mesh[], resolution: number) {
    if (
      !Number.isInteger(resolution) ||
      resolution < 1 ||
      resolution > renderer.capabilities.maxTextureSize
    )
      throw new Error('当前设备不支持所选 UV 分辨率，未降低输出尺寸。');
    if (!renderer.extensions.has('EXT_color_buffer_float'))
      throw new Error('当前设备不支持 UV 重绘浮点可见性缓冲，未修改图层。');
    this.renderer = renderer;
    this.resolution = resolution;
    this.source = target(resolution, true);
    this.output = target(resolution);
    // sRGB stamp encoding and texture decoding preserve BaseColor bytes
    // without baking display lighting or losing dark detail to linear RGBA8.
    this.source.texture.colorSpace = THREE.SRGBColorSpace;
    this.output.texture.colorSpace = THREE.SRGBColorSpace;
    this.ids.texture.type = THREE.FloatType;
    this.texture = this.output.texture;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = resolution;
    const common = { currentViewProjection: { value: new THREE.Matrix4() }, uvPass: { value: 1 } };
    this.brush = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: paintFragment,
      uniforms: {
        ...common,
        visibleFaces: { value: this.ids.texture },
        visibilitySize: { value: new THREE.Vector2() },
        viewportSize: { value: new THREE.Vector2() },
        brushFrom: { value: new THREE.Vector2() },
        brushTo: { value: new THREE.Vector2() },
        brushRadius: { value: 1 },
        feather: { value: 0 },
        erase: { value: 0 },
      },
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.LessDepth,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.identity = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader:
        `flat varying float faceId; void main() {
          gl_FragColor = vec4(faceId,
            gl_FragCoord.z, dFdx(gl_FragCoord.z), dFdy(gl_FragCoord.z)); }`,
      uniforms: { currentViewProjection: common.currentViewProjection, uvPass: { value: 0 } },
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.NoBlending,
    });
    this.composite = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D stampMap; uniform float resolution;
          void main() { gl_FragColor = texture2D(stampMap, gl_FragCoord.xy / resolution);
            if (gl_FragColor.a <= 0.0) discard; }`,
        uniforms: { stampMap: { value: this.source.texture }, resolution: { value: resolution } },
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.CustomBlending,
        toneMapped: false,
      }),
    );
    this.composite.frustumCulled = false;
    this.compositeScene.add(this.composite);
    let faceId = 1;
    try {
      for (const original of meshes) {
        const geometry = original.geometry;
        const position = geometry.getAttribute('position');
        const uv = geometry.getAttribute('uv');
        if (!uv || !position) throw new Error('局部重绘需要有效 UV，请先生成 UV。');
        if (
          (original as THREE.SkinnedMesh).isSkinnedMesh ||
          geometry.morphAttributes.position?.length
        )
          throw new Error('请先固定变形模型再进行 UV 局部重绘。');
        const indices = geometry.index;
        const count = indices?.count ?? position.count;
        const start = geometry.drawRange.start;
        const end = Math.min(count, start + geometry.drawRange.count);
        const vertexCount = Math.max(0, Math.floor((end - start) / 3) * 3);
        const vertices = new Float32Array(vertexCount * 3),
          normals = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2),
          ids = new Float32Array(vertexCount);
        const normal = geometry.getAttribute('normal');
        const box = new THREE.Box3(),
          p = new THREE.Vector3();
        for (let i = start; i + 2 < end; i += 3) {
          if (faceId > 0xffffff) throw new Error('模型三角形数量超过 UV 绘制标识上限。');
          box.makeEmpty();
          let minU = 1,
            minV = 1,
            maxU = 0,
            maxV = 0;
          for (let j = 0; j < 3; j++) {
            const k = indices ? indices.getX(i + j) : i + j;
            const u = uv.getX(k),
              v = uv.getY(k);
            if (!Number.isFinite(u + v) || u < 0 || u > 1 || v < 0 || v > 1)
              throw new Error('当前 UV 超出 0–1 范围，不能安全绘制独立 UV 图层。');
            p.fromBufferAttribute(position, k);
            if (!Number.isFinite(p.x + p.y + p.z))
              throw new Error('模型顶点无效，不能准备 UV 绘制。');
            box.expandByPoint(p);
            const vertex = i - start + j,
              xyz = vertex * 3,
              st = vertex * 2;
            vertices[xyz] = p.x;
            vertices[xyz + 1] = p.y;
            vertices[xyz + 2] = p.z;
            normals[xyz] = normal?.getX(k) ?? 0;
            normals[xyz + 1] = normal?.getY(k) ?? 0;
            normals[xyz + 2] = normal?.getZ(k) ?? 1;
            uvs[st] = u;
            uvs[st + 1] = v;
            ids[vertex] = faceId;
            minU = Math.min(minU, u);
            maxU = Math.max(maxU, u);
            minV = Math.min(minV, v);
            maxV = Math.max(maxV, v);
          }
          const base = (i - start) * 2;
          if (
            (uvs[base + 2] - uvs[base]) * (uvs[base + 5] - uvs[base + 1]) ===
            (uvs[base + 4] - uvs[base]) * (uvs[base + 3] - uvs[base + 1])
          )
            throw new Error('模型含退化 UV 三角形，请先修复 UV 后重绘。');
          const columns = Math.ceil(resolution / UV_REPAINT_TILE_SIZE);
          const maxTile = columns - 1;
          for (
            let y = Math.floor((minV * resolution) / UV_REPAINT_TILE_SIZE);
            y <= Math.min(maxTile, Math.floor((maxV * resolution) / UV_REPAINT_TILE_SIZE));
            y++
          ) {
            for (
              let x = Math.floor((minU * resolution) / UV_REPAINT_TILE_SIZE);
              x <= Math.min(maxTile, Math.floor((maxU * resolution) / UV_REPAINT_TILE_SIZE));
              x++
            ) {
              const key = y * columns + x;
              let tile = this.tiles.get(key);
              if (!tile) {
                const tx = x * UV_REPAINT_TILE_SIZE,
                  ty = y * UV_REPAINT_TILE_SIZE;
                tile = {
                  bounds: {
                    x: tx,
                    y: ty,
                    width: Math.min(UV_REPAINT_TILE_SIZE, resolution - tx),
                    height: Math.min(UV_REPAINT_TILE_SIZE, resolution - ty),
                  },
                  surfaces: [],
                };
                this.tiles.set(key, tile);
              }
              let surface = tile.surfaces.find((entry) => entry.mesh === original);
              if (!surface) {
                surface = { mesh: original, box: new THREE.Box3() };
                tile.surfaces.push(surface);
              }
              surface.box.union(box);
            }
          }
          faceId++;
        }
        const owned = new THREE.BufferGeometry();
        owned.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        owned.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        owned.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        owned.setAttribute('repaintFaceId', new THREE.BufferAttribute(ids, 1));
        const mesh = new THREE.Mesh(owned, this.brush);
        mesh.renderOrder = this.meshes.length;
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        this.meshes.push(mesh);
        this.originals.push(original);
        this.scene.add(mesh);
      }
      if (!this.meshes.length) throw new Error('没有可绘制的 UV 表面。');
      isolated(renderer, () => {
        renderer.setRenderTarget(this.output);
        renderer.clear();
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private track<T>(promise: Promise<T>) {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  private read(target: THREE.WebGLRenderTarget, bounds: Rect) {
    const pixels = new Uint8Array(bounds.width * bounds.height * 4);
    return this.track(
      this.renderer
        .readRenderTargetPixelsAsync(
          target,
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          pixels,
        )
        .then(() => pixels),
    );
  }

  private updateMatrices(camera: THREE.Camera) {
    camera.updateMatrixWorld();
    (this.brush.uniforms.currentViewProjection.value as THREE.Matrix4).multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.meshes.forEach((mesh, i) => {
      const original = this.originals[i];
      original.updateWorldMatrix(true, false);
      mesh.matrix.copy(original.matrixWorld);
      mesh.visible = true;
      for (let parent: THREE.Object3D | null = original; parent; parent = parent.parent)
        if (!parent.visible) {
          mesh.visible = false;
          break;
        }
    });
  }

  private visibilitySize() {
    const { width, height } = this.renderer.domElement;
    // Small windows must not turn fine surface curvature into UV pinholes.
    // Keep aspect ratio; this does not change output texture resolution.
    const scale = Math.max(1, 1024 / Math.max(1, width, height));
    return [Math.ceil(width * scale), Math.ceil(height * scale)] as const;
  }

  async prepare(
    material: THREE.ShaderMaterial | undefined,
    camera: THREE.Camera,
    initial?: CanvasImageSource,
  ) {
    this.updateMatrices(camera);
    // Retain immutable capture uniforms/textures, not a pre-flattened UV source:
    // overlapping faces may sample different colors in the frozen source image.
    if (material) {
      const captured = THREE.UniformsUtils.clone(material.uniforms);
      this.sourceTextures = Object.values(captured)
        .map((uniform) => uniform.value)
        .filter((value): value is THREE.Texture => value?.isTexture);
      this.brush.uniforms = { ...captured, ...this.brush.uniforms };
      this.brush.defines = { ...material.defines };
      this.brush.vertexShader =
        material.vertexShader.replace(/void main\(\)\s*\{/, 'void paintSourceVertex() {') +
        vertex.replace('void main() {', 'void main() { paintSourceVertex();');
      this.brush.fragmentShader =
        material.fragmentShader.replace(/void main\(\)\s*\{/, 'void paintSourceFragment() {') +
        paintFragment +
        `
      void main() {
        float weight = repaintWeight();
        if (erase > 0.5) gl_FragColor = vec4(0.0, 0.0, 0.0, weight);
        else {
          paintSourceFragment();
          if (gl_FragColor.a <= 0.0039) discard;
          gl_FragColor.a *= weight;
        }
        gl_FragDepth = 1.0 - weight;
      }`;
    } else {
      // Mask-only sessions never sample or flatten source colour. They rasterize
      // the visible surface footprint straight into a full-resolution GPU keep-mask.
      this.brush.vertexShader = vertex.replace(
        'vec4(uv*2.0-1.0,0.0,1.0)',
        'vec4(vec2(uv.x,1.0-uv.y)*2.0-1.0,0.0,1.0)',
      );
      for (const tile of this.tiles.values())
        tile.bounds.y = this.resolution - tile.bounds.y - tile.bounds.height;
      this.brush.fragmentShader =
        paintFragment +
        'void main(){float weight=repaintWeight();gl_FragColor=vec4(0,0,0,weight);gl_FragDepth=1.0-weight;}';
    }
    this.brush.needsUpdate = true;
    try {
      await isolated(this.renderer, () => {
        this.renderer.setRenderTarget(this.source);
        return this.renderer.compileAsync(this.scene, camera);
      });
      if (this.disposed) throw new Error('UV 绘制准备已取消。');
      await isolated(this.renderer, () => {
        this.renderer.setRenderTarget(this.output);
        return this.renderer.compileAsync(this.compositeScene, camera);
      });
      if (this.disposed) throw new Error('UV 绘制准备已取消。');
      await isolated(this.renderer, () => {
        this.ids.setSize(...this.visibilitySize());
        this.meshes.forEach((mesh) => {
          mesh.material = this.identity;
        });
        this.renderer.setRenderTarget(this.ids);
        return this.renderer.compileAsync(this.scene, camera);
      });
      if (this.disposed) throw new Error('UV 绘制准备已取消。');
      isolated(this.renderer, () => {
        this.renderer.setRenderTarget(this.ids);
        this.renderer.clear();
        this.renderer.render(this.scene, camera);
      });
      if (initial) {
        const context = this.canvas.getContext('2d')!;
        context.drawImage(initial, 0, 0, this.resolution, this.resolution);
        const bytes = context.getImageData(0, 0, this.resolution, this.resolution).data;
        const flipped = new Uint8Array(bytes.length);
        const stride = this.resolution * 4;
        for (let row = 0; row < this.resolution; row++)
          flipped.set(
            bytes.subarray(row * stride, (row + 1) * stride),
            (this.resolution - row - 1) * stride,
          );
        this.write({ x: 0, y: 0, width: this.resolution, height: this.resolution }, flipped);
      } else if (!material) {
        this.resetWhite();
      }
    } finally {
      this.meshes.forEach((mesh) => {
        mesh.material = this.brush;
      });
    }
  }

  begin(captureHistory = true) {
    if (this.disposed || this.stroke) throw new Error('UV 笔画会话不可用。');
    this.stroke = {
      ...(captureHistory ? { before: new Map() } : {}),
      changed: new Set(),
    };
  }

  private refreshProjectedTileBounds(key: string, clip: THREE.Matrix4, size: THREE.Vector2) {
    if (key === this.projectedTileBoundsKey) return;
    this.projectedTileBounds.clear();
    for (const [id, tile] of this.tiles) {
      const bounds: ProjectedSurfaceBounds[] = [];
      for (const { mesh, box } of tile.surfaces) {
        const transform = this.projectedBoundsTransform.multiplyMatrices(clip, mesh.matrixWorld);
        let left = Infinity,
          top = Infinity,
          right = -Infinity,
          bottom = -Infinity;
        let crossesNearPlane = false;
        for (let i = 0; i < 8; i++) {
          const p = this.projectedBoundsPoint
            .set(
              i & 1 ? box.max.x : box.min.x,
              i & 2 ? box.max.y : box.min.y,
              i & 4 ? box.max.z : box.min.z,
              1,
            )
            .applyMatrix4(transform);
          if (p.w <= 0) {
            crossesNearPlane = true;
            break;
          }
          const x = ((p.x / p.w) * 0.5 + 0.5) * size.x,
            y = (0.5 - (p.y / p.w) * 0.5) * size.y;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
        // Preserve the original conservative near-plane rule exactly. A boolean
        // avoids manufacturing an unbounded rectangle for the common comparison.
        bounds.push(
          crossesNearPlane
            ? true
            : [left, top, right, bottom],
        );
      }
      this.projectedTileBounds.set(id, bounds);
    }
    this.projectedTileBoundsKey = key;
  }

  private intersects(id: number, rect: Rect) {
    return this.projectedTileBounds.get(id)?.some((bounds) => {
      if (bounds === true) return true;
      return (
        bounds[2] >= rect.x &&
        bounds[0] <= rect.x + rect.width &&
        bounds[3] >= rect.y &&
        bounds[1] <= rect.y + rect.height
      );
    });
  }

  stamp(input: {
    camera: THREE.Camera;
    from?: THREE.Vector2;
    to: THREE.Vector2;
    viewport: THREE.Vector2;
    radius: number;
    feather: number;
    erase: boolean;
  }) {
    const stroke = this.stroke;
    if (!stroke || this.disposed) return false;
    this.updateMatrices(input.camera);
    const uniforms = this.brush.uniforms;
    const matrix = uniforms.currentViewProjection.value as THREE.Matrix4;
    const size = input.viewport;
    const from = (input.from ?? input.to).clone().multiply(size),
      to = input.to.clone().multiply(size);
    const rect = {
      x: Math.min(from.x, to.x) - input.radius,
      y: Math.min(from.y, to.y) - input.radius,
      width: Math.abs(from.x - to.x) + input.radius * 2,
      height: Math.abs(from.y - to.y) + input.radius * 2,
    };
    const [width, height] = this.visibilitySize();
    const key = [
      width,
      height,
      ...matrix.elements,
      ...this.meshes.flatMap((mesh) => [...mesh.matrix.elements, Number(mesh.visible)]),
    ].join(',');
    this.refreshProjectedTileBounds(`${size.x},${size.y}|${key}`, matrix, size);
    const touched: Array<[number, Tile]> = [];
    for (const entry of this.tiles) if (this.intersects(entry[0], rect)) touched.push(entry);
    if (!touched.length) return false;
    isolated(this.renderer, () => {
      if (key !== this.visibilityKey) {
        this.ids.setSize(width, height);
        this.meshes.forEach((mesh) => {
          mesh.material = this.identity;
        });
        this.renderer.setRenderTarget(this.ids);
        this.renderer.clear();
        this.renderer.render(this.scene, input.camera);
        this.visibilityKey = key;
      }
      uniforms.viewportSize.value.copy(size);
      uniforms.brushFrom.value.copy(from);
      uniforms.brushTo.value.copy(to);
      uniforms.visibilitySize.value.set(width, height);
      uniforms.brushRadius.value = input.radius;
      uniforms.feather.value = Math.max(0.0001, Math.min(1, input.feather));
      uniforms.erase.value = Number(input.erase);
      const composite = this.composite.material as THREE.ShaderMaterial;
      composite.blendEquation = THREE.AddEquation;
      composite.blendSrc = input.erase ? THREE.ZeroFactor : THREE.OneFactor;
      composite.blendDst = input.erase ? THREE.OneFactor : THREE.ZeroFactor;
      composite.blendEquationAlpha = input.erase ? THREE.AddEquation : THREE.MaxEquation;
      composite.blendSrcAlpha = input.erase ? THREE.ZeroFactor : THREE.OneFactor;
      composite.blendDstAlpha = input.erase ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
      this.meshes.forEach((mesh) => {
        mesh.material = this.brush;
      });
      // Capture undo before any output writes. Rasterize geometry once for the
      // stamp, even when its surface spans many atlas tiles. Only the original
      // touched tiles are composited; gaps inside this scratch rectangle never
      // enter the authored output or its history.
      const bounds = { ...touched[0][1].bounds };
      for (const [id, tile] of touched) {
        if (stroke.before && !stroke.before.has(id))
          stroke.before.set(id, this.read(this.output, tile.bounds));
        stroke.changed.add(id);
        const right = Math.max(bounds.x + bounds.width, tile.bounds.x + tile.bounds.width);
        const bottom = Math.max(bounds.y + bounds.height, tile.bounds.y + tile.bounds.height);
        bounds.x = Math.min(bounds.x, tile.bounds.x);
        bounds.y = Math.min(bounds.y, tile.bounds.y);
        bounds.width = right - bounds.x;
        bounds.height = bottom - bounds.y;
      }
      this.renderer.setRenderTarget(this.source);
      setUvScissor(this.renderer, bounds);
      this.renderer.clear();
      this.renderer.render(this.scene, input.camera);
      for (const [, tile] of touched) {
        this.renderer.setRenderTarget(this.output);
        setUvScissor(this.renderer, tile.bounds);
        this.renderer.render(this.compositeScene, input.camera);
      }
    });
    return true;
  }

  /** Enqueues readbacks immediately, before the next gesture can mutate output. */
  end(): Promise<UvRepaintPatch[]> {
    const stroke = this.stroke;
    this.stroke = undefined;
    if (!stroke?.before) return Promise.resolve([]);
    const beforeReads = stroke.before;
    const reads = [...stroke.changed].map(async (id) => {
      const bounds = this.tiles.get(id)!.bounds;
      const afterPromise = this.read(this.output, bounds);
      const [before, after] = await Promise.all([beforeReads.get(id)!, afterPromise]);
      if (before.every((value, i) => value === after[i])) return undefined;
      return { bounds, before, after };
    });
    return this.track(
      Promise.all(reads).then((patches) =>
        patches.filter((patch): patch is UvRepaintPatch => Boolean(patch)),
      ),
    );
  }

  resetWhite() {
    if (this.disposed || !this.outputAlive) return;
    this.stroke = undefined;
    isolated(this.renderer, () => {
      this.renderer.setRenderTarget(this.output);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear(true, false, false);
    });
  }

  publish(patches: UvRepaintPatch[], side: 'before' | 'after', restoreGpu = false) {
    const context = this.canvas.getContext('2d')!;
    for (const patch of patches) {
      const { bounds } = patch,
        bytes = patch[side];
      const image = context.createImageData(bounds.width, bounds.height);
      const stride = bounds.width * 4;
      for (let row = 0; row < bounds.height; row++)
        image.data.set(
          bytes.subarray(row * stride, (row + 1) * stride),
          (bounds.height - row - 1) * stride,
        );
      context.putImageData(image, bounds.x, this.resolution - bounds.y - bounds.height);
      if (restoreGpu && this.outputAlive) this.write(bounds, bytes);
    }
  }

  private write(bounds: Rect, bytes: Uint8Array<ArrayBuffer>) {
    const texture = new THREE.DataTexture(bytes, bounds.width, bounds.height);
    texture.needsUpdate = true;
    this.renderer.copyTextureToTexture(
      texture,
      this.output.texture,
      null,
      new THREE.Vector2(bounds.x, bounds.y),
    );
    texture.dispose();
  }

  dispose(preserveOutput = false) {
    if (this.disposed) return;
    this.disposed = true;
    this.outputAlive = preserveOutput;
    const release = () => {
      this.source.dispose();
      if (!preserveOutput) this.output.dispose();
      this.ids.dispose();
      this.brush.dispose();
      this.identity.dispose();
      this.sourceTextures.forEach((texture) => texture.dispose());
      this.composite.geometry.dispose();
      (this.composite.material as THREE.ShaderMaterial).dispose();
      this.compositeScene.clear();
      this.meshes.forEach((mesh) => mesh.geometry.dispose());
      this.scene.clear();
      this.tiles.clear();
      this.projectedTileBounds.clear();
    };
    if (this.pending.size) void Promise.allSettled([...this.pending]).then(release);
    else release();
  }

  /** Renderer owner calls this only after its resident bindings are unmounted. */
  releaseOutput() {
    if (!this.outputAlive) return;
    this.outputAlive = false;
    if (this.pending.size)
      void Promise.allSettled([...this.pending]).then(() => this.output.dispose());
    else this.output.dispose();
  }
}
