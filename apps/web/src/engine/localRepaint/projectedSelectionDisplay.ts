import * as THREE from 'three';

// PROJECTED-SELECTION-DISPLAY/1.0.0. Presentation only; never an author mask.
// A texture array removes the prototype's four-sampler limit. Each immutable
// layer packs captured depth (RGB24) and screen coverage (A8); no model UV.
export type SelectionProjectionSource = {
  texture: THREE.CanvasTexture;
  projectorMatrix: THREE.Matrix4;
  projectorObjectMatrix: THREE.Matrix4;
  projectorPositionLocal: THREE.Vector3;
  depthTarget?: THREE.WebGLRenderTarget;
};
export type PendingSelectionProjection = {
  canvas: HTMLCanvasElement;
  projectorMatrix: THREE.Matrix4;
  projectorObjectMatrix: THREE.Matrix4;
  projectorPositionLocal: THREE.Vector3;
  camera: THREE.Camera;
};

// CPU history stores a lossless 512px screen canvas, not a new UV bake. Depth
// is re-rendered with the frozen camera only on undo/redo, never on pointer-up.
export function snapshotPendingSelection(source: SelectionProjectionSource, camera: THREE.Camera): PendingSelectionProjection {
  const original = source.texture.image as HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.width = original.width; canvas.height = original.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法保存选区笔画快照');
  context.drawImage(original, 0, 0);
  return {
    canvas, camera: camera.clone(),
    projectorMatrix: source.projectorMatrix.clone(),
    projectorObjectMatrix: source.projectorObjectMatrix.clone(),
    projectorPositionLocal: source.projectorPositionLocal.clone(),
  };
}

export function restorePendingSelectionCamera(pending: PendingSelectionProjection, objectMatrix: THREE.Matrix4) {
  const camera = pending.camera.clone();
  camera.matrixAutoUpdate = false;
  camera.matrix.copy(objectMatrix).multiply(pending.projectorObjectMatrix.clone().invert()).multiply(pending.camera.matrixWorld);
  camera.updateMatrixWorld(true);
  return camera;
}
type Record = {
  slot: number;
  projector: THREE.Matrix4;
  position: THREE.Vector3;
  width: number;
  height: number;
  operation: 'add' | 'subtract';
};
export type ProjectedSelectionState = {
  readonly owner: object;
  readonly records: readonly Record[];
  readonly available: boolean;
};

const SIZE = 512; // Existing author screen mask size, not output resolution.
const MAX_SLOTS = 192; // 192 MiB display-only GPU cache, including undo roots.
const vertex = `
  out vec3 worldPoint;
  out vec3 worldFacing;
  void main() {
    worldPoint = (modelMatrix * vec4(position, 1.0)).xyz;
    worldFacing = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const depthFunctions = `
  float decodeDepth(vec3 rgb) { return dot(floor(rgb * 255.0 + 0.5), vec3(65536.0,256.0,1.0)) / 16777215.0; }
  vec3 encodeDepth(float value) {
    float n = floor(clamp(value,0.0,1.0) * 16777215.0 + 0.5);
    return vec3(floor(n/65536.0), mod(floor(n/256.0),256.0), mod(n,256.0)) / 255.0;
  }
`;

export class ProjectedSelectionDisplay {
  readonly material: THREE.ShaderMaterial;
  private readonly owner = {};
  private readonly limit: number;
  private atlas?: THREE.WebGLArrayRenderTarget;
  private slots = new Set<number>();
  private records: readonly Record[] = [];
  private historyRoots: readonly object[] = [];
  private available = true;
  private disposed = false;
  private reported = false;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.Camera();
  private readonly pack: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly inverse = new THREE.Matrix4();
  private readonly liveProjector = new THREE.Matrix4();
  private readonly livePosition = new THREE.Vector3();
  private ready?: Promise<void>;
  private staging?: THREE.WebGLArrayRenderTarget;

  constructor(private renderer: THREE.WebGLRenderer, private warn: (reason: string) => void) {
    this.limit = Math.max(1, Math.min(128, Math.floor((renderer.capabilities.maxFragmentUniforms - 48) / 7)));
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        atlas: { value: null }, count: { value: 0 }, inverted: { value: 0 },
        projectors: { value: Array.from({ length: this.limit }, () => new THREE.Matrix4()) },
        positions: { value: Array.from({ length: this.limit }, () => new THREE.Vector3()) },
        slices: { value: Array.from({ length: this.limit }, () => new THREE.Vector3()) },
        operations: { value: new Float32Array(this.limit) },
        liveMask: { value: null }, liveDepth: { value: null }, liveReady: { value: 0 },
        liveProjector: { value: this.liveProjector }, livePosition: { value: this.livePosition },
        liveSize: { value: new THREE.Vector2(1, 1) }, liveOperation: { value: 1 },
        stripeColor: { value: new THREE.Color('#ac2f0d') },
      },
      vertexShader: vertex,
      fragmentShader: `
        precision highp sampler2DArray;
        uniform sampler2DArray atlas;
        uniform int count;
        uniform float inverted;
        uniform mat4 projectors[${this.limit}];
        uniform vec3 positions[${this.limit}], slices[${this.limit}];
        uniform float operations[${this.limit}];
        uniform sampler2D liveMask, liveDepth;
        uniform float liveReady, liveOperation;
        uniform mat4 liveProjector;
        uniform vec3 livePosition, stripeColor;
        uniform vec2 liveSize;
        in vec3 worldPoint, worldFacing;
        out vec4 result;
        ${depthFunctions}
        float correctedDepth(vec3 ndc, vec2 size) {
          vec3 dx=dFdx(ndc), dy=dFdy(ndc);
          float determinant=dx.x*dy.y-dy.x*dx.y;
          vec2 slope=abs(determinant)>1e-12
            ? vec2(dx.z*dy.y-dy.z*dx.y,dy.z*dx.x-dx.z*dy.x)/determinant : vec2(0.0);
          vec2 uv=ndc.xy*.5+.5;
          return ndc.z*.5+.5+dot(slope,(floor(uv*size)+.5)/size-uv);
        }
        float atlasAlpha(vec2 uv, vec3 slice) {
          vec2 p=uv*slice.yz-.5, f=fract(p), q=floor(p);
          vec2 hi=slice.yz-1.0;
          float a=texture(atlas,vec3((clamp(q,vec2(0),hi)+.5)/${SIZE}.0,slice.x)).a;
          float b=texture(atlas,vec3((clamp(q+vec2(1,0),vec2(0),hi)+.5)/${SIZE}.0,slice.x)).a;
          float c=texture(atlas,vec3((clamp(q+vec2(0,1),vec2(0),hi)+.5)/${SIZE}.0,slice.x)).a;
          float d=texture(atlas,vec3((clamp(q+vec2(1,1),vec2(0),hi)+.5)/${SIZE}.0,slice.x)).a;
          return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
        }
        bool inside(vec4 clip,vec3 ndc,vec3 position,float viewerFacing) {
          return clip.w>0.0001 && max(max(abs(ndc.x),abs(ndc.y)),abs(ndc.z))<=1.0
            && dot(worldFacing,position-worldPoint)*viewerFacing>=0.0;
        }
        float applyCoverage(float coverage,float alpha,float operation) {
          return operation>0.0 ? alpha+coverage*(1.0-alpha) : coverage*(1.0-alpha);
        }
        void main() {
          float coverage=0.0;
          float viewerFacing=dot(worldFacing,cameraPosition-worldPoint);
          for(int i=0;i<${this.limit};i++) {
            if(i>=count) break;
            vec4 clip=projectors[i]*vec4(worldPoint,1.0);
            vec3 ndc=clip.xyz/max(clip.w,.0001);
            float receiver=correctedDepth(ndc,slices[i].yz);
            if(inside(clip,ndc,positions[i],viewerFacing)) {
              vec2 uv=ndc.xy*.5+.5;
              vec2 p=(min(floor(uv*slices[i].yz),slices[i].yz-1.0)+.5)/${SIZE}.0;
              float depth=decodeDepth(texture(atlas,vec3(p,slices[i].x)).rgb);
              if(depth<.999999 && receiver<=depth+.00002)
                coverage=applyCoverage(coverage,atlasAlpha(uv,slices[i]),operations[i]);
            }
          }
          if(liveReady>.5) {
            vec4 clip=liveProjector*vec4(worldPoint,1.0);
            vec3 ndc=clip.xyz/max(clip.w,.0001);
            float receiver=correctedDepth(ndc,liveSize);
            if(inside(clip,ndc,livePosition,viewerFacing)) {
              vec2 uv=ndc.xy*.5+.5;
              float depth=texture(liveDepth,uv).r;
              if(depth<.999999 && receiver<=depth+.00002) {
                vec4 mask=texture(liveMask,vec2(uv.x,1.0-uv.y));
                coverage=applyCoverage(coverage,max(mask.r,max(mask.g,mask.b))*mask.a,liveOperation);
              }
            }
          }
          if(inverted>.5) coverage=1.0-coverage;
          if(coverage<=.01) discard;
          float stripe=1.0-step(7.0,mod(gl_FragCoord.x+gl_FragCoord.y,14.0));
          gl_FragDepth=clamp(gl_FragCoord.z-.00008,0.0,1.0);
          result=vec4(stripeColor,mix(.16,.94,stripe)*coverage);
        }
      `,
      transparent: true, depthTest: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -16, polygonOffsetUnits: -16,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.material.forceSinglePass = true;
    this.pack = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        mask: { value: null }, depth: { value: null }, oldAtlas: { value: null },
        oldSlot: { value: -1 }, copySlot: { value: -1 }, size: { value: new THREE.Vector2() },
      },
      vertexShader: `void main(){gl_Position=vec4(position.xy,0.0,1.0);}`,
      fragmentShader: `
        precision highp sampler2DArray;
        uniform sampler2D mask,depth;
        uniform sampler2DArray oldAtlas;
        uniform float oldSlot,copySlot;
        uniform vec2 size;
        out vec4 result;
        ${depthFunctions}
        void main(){
          vec2 p=gl_FragCoord.xy;
          if(copySlot>=0.0){result=texture(oldAtlas,vec3(p/${SIZE}.0,copySlot));return;}
          if(any(greaterThanEqual(p,size))){result=vec4(1.0,1.0,1.0,0.0);return;}
          vec2 uv=p/size;
          vec4 m=texture(mask,vec2(uv.x,1.0-uv.y));
          float a=max(m.r,max(m.g,m.b))*m.a;
          if(oldSlot>=0.0){float b=texture(oldAtlas,vec3(p/${SIZE}.0,oldSlot)).a;a=a+b*(1.0-a);}
          result=vec4(encodeDepth(texture(depth,uv).r),a);
        }
      `,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pack);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get enabled() { return !this.disposed && this.available; }
  prepare(camera: THREE.Camera) {
    if (this.ready || this.disposed) return;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(this.quad.geometry, this.material));
    this.ready = (async () => {
      await this.renderer.compileAsync(scene, camera);
      if (this.disposed) return;
      await this.renderer.compileAsync(this.quadScene, this.quadCamera);
      if (this.disposed || this.atlas) return;
      this.grow();
      this.renderInto(this.atlas!, 0); // Unpublished empty layer warms the pack pipeline.
    })().catch(error => {
      if (!this.disposed) this.useUvFallback(`投影显示预热失败：${String(error)}；实际蒙版不受影响。`);
    }).finally(() => scene.clear());
  }
  snapshot(): ProjectedSelectionState { return { owner: this.owner, records: this.records, available: this.available }; }
  restore(state?: ProjectedSelectionState) {
    this.available = Boolean(state?.owner === this.owner && state.available && state.records.every(r => this.slots.has(r.slot)));
    this.records = this.available && state ? state.records : [];
  }
  clear() { this.records = []; this.available = true; this.reported = false; }
  useUvFallback(reason?: string) {
    this.available = false;
    this.records = [];
    if (reason && !this.reported) { this.reported = true; this.warn(reason); }
  }

  // History owns only small immutable handles. Prune GPU layers after the store
  // has published its new past/future lists, never while an undo is in flight.
  collect(historyRoots: readonly object[]) {
    this.historyRoots = historyRoots;
    const used = new Set(this.records.map(r => r.slot));
    for (const root of historyRoots) {
      const state = root as ProjectedSelectionState;
      if (state.owner === this.owner && state.available) state.records.forEach(r => used.add(r.slot));
    }
    this.slots = new Set([...this.slots].filter(slot => used.has(slot)));
  }

  private renderInto(target: THREE.WebGLArrayRenderTarget, slot: number) {
    const r = this.renderer, previous = r.getRenderTarget();
    const face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const viewport = r.getViewport(new THREE.Vector4()), scissor = r.getScissor(new THREE.Vector4());
    const scissorTest = r.getScissorTest(), autoClear = r.autoClear;
    const xr = r.xr.enabled;
    try {
      r.xr.enabled = false; r.autoClear = false;
      r.setRenderTarget(target, slot); r.setViewport(0, 0, SIZE, SIZE); r.setScissorTest(false);
      r.render(this.quadScene, this.quadCamera);
    } finally {
      r.setRenderTarget(previous, face, mip); r.setViewport(viewport); r.setScissor(scissor);
      r.setScissorTest(scissorTest); r.autoClear = autoClear; r.xr.enabled = xr;
    }
  }

  private grow() {
    const previous = this.atlas;
    const count = Math.min(MAX_SLOTS, previous ? previous.depth * 2 : 4);
    const next = new THREE.WebGLArrayRenderTarget(SIZE, SIZE, count, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    const u = this.pack.uniforms;
    try {
      u.oldAtlas.value = previous?.texture ?? null;
      for (const slot of this.slots) { u.copySlot.value = slot; this.renderInto(next, slot); }
      this.atlas = next;
      this.material.uniforms.atlas.value = next.texture;
      previous?.dispose();
    } catch (error) { next.dispose(); throw error; }
    finally { u.copySlot.value = -1; u.oldAtlas.value = null; }
  }

  archive(source: SelectionProjectionSource, operation: 'add' | 'subtract') {
    if (!this.enabled) return;
    try {
      const depth = source.depthTarget;
      if (!depth?.depthTexture || depth.width > SIZE || depth.height > SIZE) throw new Error('投影深度不可用');
      const projector = source.projectorMatrix.clone().multiply(source.projectorObjectMatrix);
      const last = this.records.at(-1);
      const merge = last?.operation === operation && last.width === depth.width && last.height === depth.height
        && last.projector.equals(projector) && last.position.equals(source.projectorPositionLocal);
      if (!merge && this.records.length >= this.limit) throw new Error('当前视角记录达到显卡 uniform 预算');
      this.collect(this.historyRoots);
      let slot = 0;
      while (this.slots.has(slot)) slot++;
      if (slot >= MAX_SLOTS) throw new Error('投影显示缓存达到 192 MiB 预算');
      if (!this.atlas || slot >= this.atlas.depth) this.grow();
      const u = this.pack.uniforms;
      u.mask.value = source.texture; u.depth.value = depth.depthTexture;
      u.size.value.set(depth.width, depth.height);
      // Never read and render the same array texture, even different layers.
      // A one-layer staging target also makes archive publication atomic.
      const staging = this.staging ??= new THREE.WebGLArrayRenderTarget(SIZE, SIZE, 1, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      try {
        u.oldAtlas.value = this.atlas!.texture; u.oldSlot.value = merge ? last.slot : -1;
        this.renderInto(staging, 0);
        u.oldAtlas.value = staging.texture; u.copySlot.value = 0;
        this.renderInto(this.atlas!, slot);
      } finally { u.copySlot.value = -1; u.oldSlot.value = -1; u.oldAtlas.value = null; }
      this.slots.add(slot);
      const record: Record = { slot, projector, position: source.projectorPositionLocal.clone(), width: depth.width, height: depth.height, operation };
      this.records = [...(merge ? this.records.slice(0, -1) : this.records), record];
    } catch (error) {
      this.useUvFallback(`${error instanceof Error ? error.message : String(error)}；本次选区使用 UV 显示，实际蒙版不受影响。清空选区可恢复投影显示。`);
    }
  }

  update(objectMatrix: THREE.Matrix4, live: SelectionProjectionSource | undefined, operation: 'add' | 'subtract', inverted: boolean) {
    if (!this.enabled) return;
    const u = this.material.uniforms;
    this.inverse.copy(objectMatrix).invert();
    u.count.value = this.records.length; u.inverted.value = inverted ? 1 : 0;
    this.records.forEach((record, i) => {
      u.projectors.value[i].copy(record.projector).multiply(this.inverse);
      u.positions.value[i].copy(record.position).applyMatrix4(objectMatrix);
      u.slices.value[i].set(record.slot, record.width, record.height);
      u.operations.value[i] = record.operation === 'add' ? 1 : -1;
    });
    const depth = live?.depthTarget;
    u.liveReady.value = depth?.depthTexture ? 1 : 0;
    u.liveMask.value = live?.texture ?? null; u.liveDepth.value = depth?.depthTexture ?? null;
    u.liveOperation.value = operation === 'add' ? 1 : -1;
    if (live && depth) {
      this.liveProjector.copy(live.projectorMatrix).multiply(live.projectorObjectMatrix).multiply(this.inverse);
      this.livePosition.copy(live.projectorPositionLocal).applyMatrix4(objectMatrix);
      u.liveSize.value.set(depth.width, depth.height);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const releasePrograms = () => { this.material.dispose(); this.pack.dispose(); this.quad.geometry.dispose(); };
    if (this.ready) void this.ready.finally(releasePrograms); else releasePrograms();
    this.staging?.dispose(); this.staging = undefined;
    this.atlas?.dispose(); this.atlas = undefined; this.records = []; this.slots.clear(); this.historyRoots = [];
  }
}
