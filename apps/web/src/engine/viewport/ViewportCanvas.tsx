import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent, type WheelEvent } from 'react';
import * as THREE from 'three';
import { useDragInteractionStore } from '@/stores/dragInteractionStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useLayerStore } from '@/stores/layerStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { useT } from '@/stores/i18nStore';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import { SceneRoot } from './SceneRoot';
import { CameraController } from './CameraController';
import { ViewCube } from './ViewCube';

type SurfacePaintTarget = {
  objectId: string;
  group: THREE.Object3D;
  boundingSize: THREE.Vector3;
};

type ViewportCanvasProps = {
  hasImportedModel: boolean;
  onImportModel: (file: File) => void;
  onImportReferenceImages: (files: File[]) => void;
  onOpenImport: () => void;
};

const MODEL_FILE_EXTENSIONS = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl']);
const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function RendererSettings() {
  const { gl } = useThree();
  const exposure = useSettingsStore((state) => state.exposure);

  useEffect(() => {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.LinearToneMapping;
    gl.toneMappingExposure = exposure;
  }, [exposure, gl]);

  return null;
}

function getFileExtension(file: File) {
  return file.name.split('.').pop()?.toLowerCase();
}

function getDragPayload(event: DragEvent<HTMLDivElement>) {
  const files = Array.from(event.dataTransfer.files);
  const modelFile = files.find((file) => {
    const extension = getFileExtension(file);
    return Boolean(extension && MODEL_FILE_EXTENSIONS.has(extension));
  });
  const imageFiles = files.filter((file) => {
    const extension = getFileExtension(file);
    if (extension && IMAGE_FILE_EXTENSIONS.has(extension)) return true;
    return file.type.startsWith('image/');
  });
  return {
    modelFile,
    imageFiles,
    dragType: modelFile ? 'model-file' : imageFiles.length > 0 ? 'asset-file' : undefined,
  } as const;
}

const UV_PAINT_RESOLUTION = 1024;
type UvPaintLayer = {
  objectId: string;
  paintCanvas: HTMLCanvasElement;
  paintContext: CanvasRenderingContext2D;
  paintTexture: THREE.CanvasTexture;
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskDisplayCanvas: HTMLCanvasElement;
  maskDisplayContext: CanvasRenderingContext2D;
  maskPattern: CanvasPattern;
  maskTexture: THREE.CanvasTexture;
  maskDisplayTexture: THREE.CanvasTexture;
  paintMaterial: THREE.MeshBasicMaterial;
  maskMaterial: THREE.ShaderMaterial;
  overlayMeshes: THREE.Mesh[];
  overlayTargets: Set<THREE.Mesh>;
  maskSolidNormalized: boolean;
};

type UvPaintHit = {
  model: SurfacePaintTarget;
  hit: THREE.Intersection<THREE.Object3D>;
  uv: THREE.Vector2;
  worldRadius: number;
  textureRadius: number;
};

type UvPaintSample = {
  meshUuid: string;
  faceIndex?: number;
  uv: THREE.Vector2;
  point: THREE.Vector3;
};

type PaintDirtyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PaintStrokeDraft = {
  layer: UvPaintLayer;
  target: 'paint' | 'mask';
  beforeCanvas: HTMLCanvasElement;
  beforeMaskHasContent: boolean;
  bounds?: PaintDirtyRect;
};

type PaintableMeshCache = {
  objectId: string;
  groupUuid: string;
  meshes: THREE.Mesh[];
};

function createPaintCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = UV_PAINT_RESOLUTION;
  canvas.height = UV_PAINT_RESOLUTION;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create UV paint canvas.');
  return { canvas, context };
}

function createInpaintMaskPattern(context: CanvasRenderingContext2D) {
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = 24;
  patternCanvas.height = 24;
  const patternContext = patternCanvas.getContext('2d');
  if (!patternContext) throw new Error('Could not create UV mask pattern.');
  patternContext.clearRect(0, 0, patternCanvas.width, patternCanvas.height);
  patternContext.strokeStyle = 'rgba(214, 112, 62, 0.64)';
  patternContext.lineWidth = 6;
  patternContext.lineCap = 'butt';
  patternContext.beginPath();
  for (let offset = -48; offset <= 72; offset += 12) {
    patternContext.moveTo(offset, -18);
    patternContext.lineTo(offset + 48, 30);
  }
  patternContext.stroke();
  const pattern = context.createPattern(patternCanvas, 'repeat');
  if (!pattern) throw new Error('Could not create UV mask brush pattern.');
  return pattern;
}

function createInpaintMaskMaterial(maskTexture: THREE.CanvasTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      maskMap: { value: maskTexture },
      stripeColor: { value: new THREE.Color('#d6703e') },
      stripeOpacity: { value: 0.64 },
      stripePeriod: { value: 14 },
      stripeWidth: { value: 7 },
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D maskMap;
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float stripePeriod;
      uniform float stripeWidth;
      varying vec2 vUv;

      void main() {
        float maskAlpha = texture2D(maskMap, vUv).a;
        if (maskAlpha < 0.02) discard;

        float coord = mod(gl_FragCoord.x + gl_FragCoord.y, stripePeriod);
        float edge = 1.0;
        float stripe = 1.0 - smoothstep(stripeWidth - edge, stripeWidth + edge, coord);
        if (stripe <= 0.01) discard;

        gl_FragColor = vec4(stripeColor, stripeOpacity * stripe * maskAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -8,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function configureCanvasTexture(texture: THREE.CanvasTexture, colorSpace: THREE.ColorSpace) {
  texture.colorSpace = colorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
}

function disposeUvPaintLayer(layer?: UvPaintLayer) {
  if (!layer) return;
  layer.overlayMeshes.forEach((mesh) => mesh.removeFromParent());
  layer.paintTexture.dispose();
  layer.maskTexture.dispose();
  layer.maskDisplayTexture.dispose();
  layer.paintMaterial.dispose();
  layer.maskMaterial.dispose();
}

function hasCanvasAlpha(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}

function unionDirtyRect(a: PaintDirtyRect | undefined, b: PaintDirtyRect): PaintDirtyRect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function createDirtyRect(fromX: number, fromY: number, toX: number, toY: number, radius: number): PaintDirtyRect {
  const padding = Math.ceil(radius + 3);
  const x = Math.max(0, Math.floor(Math.min(fromX, toX) - padding));
  const y = Math.max(0, Math.floor(Math.min(fromY, toY) - padding));
  const right = Math.min(UV_PAINT_RESOLUTION, Math.ceil(Math.max(fromX, toX) + padding));
  const bottom = Math.min(UV_PAINT_RESOLUTION, Math.ceil(Math.max(fromY, toY) + padding));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function SurfacePaintOverlay() {
  const { gl, camera, scene } = useThree();
  const cursorRef = useRef<THREE.Mesh>(null);
  const layerRef = useRef<UvPaintLayer>();
  const paintableMeshCacheRef = useRef<PaintableMeshCache>();
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerRef = useRef(new THREE.Vector2());
  const isPaintingRef = useRef(false);
  const lastUvRef = useRef<THREE.Vector2>();
  const lastSampleRef = useRef<UvPaintSample>();
  const strokeDraftRef = useRef<PaintStrokeDraft>();
  const dirtyTexturesRef = useRef(new Set<THREE.CanvasTexture>());
  const textureUpdateFrameRef = useRef<number>();
  const maskDirtyRef = useRef(false);
  const maskHasContentRef = useRef(false);
  const paintTool = useSceneStore((state) => state.paintTool);
  const paintMaskResetRevision = useSceneStore((state) => state.paintMaskResetRevision);
  const paintMaskSettings = useSceneStore((state) => state.paintMaskSettings);
  const paintToolSettings = useSceneStore((state) => state.paintToolSettings);
  const setPaintMaskDataUrl = useSceneStore((state) => state.setPaintMaskDataUrl);
  const setOrbitControlsEnabled = useSceneStore((state) => state.setOrbitControlsEnabled);
  const captureRuntimeHistory = useEditorHistoryStore((state) => state.captureRuntime);
  const importedModel = useSceneStore((state) => state.importedModel);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const pushToast = useToastStore((state) => state.pushToast);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const t = useT();
  const isInpaintMode = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
  const enabled = paintTool === 'brush' || paintTool === 'eraser' || isInpaintMode;
  const activePaintLayer = layers.find(
    (layer) =>
      layer.id === activeProjectedLayerId &&
      layer.type === 'projected' &&
      layer.visible &&
      (!layer.objectId || layer.objectId === selectedObjectId),
  );
  const texturePaintReady = Boolean(activePaintLayer);
  const canUseSurfacePaint = paintTool === 'eraser' || texturePaintReady;

  const getTargetModel = useCallback((): SurfacePaintTarget | undefined => {
    if (importedModel && (!selectedObjectId || selectedObjectId === importedModel.objectId)) {
      return {
        objectId: importedModel.objectId,
        group: importedModel.group,
        boundingSize: new THREE.Vector3().fromArray(importedModel.boundingBox.size),
      };
    }
    let target: THREE.Object3D | undefined;
    scene.traverse((object) => {
      if (target) return;
      const objectId = object.userData.liclickObjectId;
      if (typeof objectId !== 'string') return;
      if (selectedObjectId && objectId !== selectedObjectId) return;
      if (object instanceof THREE.Group || object.children.length > 0) target = object;
    });
    if (!target) {
      scene.traverse((object) => {
        if (target) return;
        if (object instanceof THREE.Group && object.userData.liclickObjectId) target = object;
      });
    }
    if (!target) return undefined;
    const box = new THREE.Box3().setFromObject(target);
    const size = new THREE.Vector3();
    box.getSize(size);
    return {
      objectId: String(target.userData.liclickObjectId ?? selectedObjectId ?? 'surface-object'),
      group: target,
      boundingSize: size,
    };
  }, [importedModel, scene, selectedObjectId]);

  const getPaintableMeshes = useCallback((model: SurfacePaintTarget) => {
    const cached = paintableMeshCacheRef.current;
    if (cached?.objectId === model.objectId && cached.groupUuid === model.group.uuid) return cached.meshes;

    const meshes: THREE.Mesh[] = [];
    model.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData.liclickPaintOverlay) return;
      if (!child.geometry.getAttribute('uv')) return;
      meshes.push(child);
    });
    paintableMeshCacheRef.current = { objectId: model.objectId, groupUuid: model.group.uuid, meshes };
    return meshes;
  }, []);

  const getUvPaintLayer = useCallback((model: SurfacePaintTarget) => {
    if (layerRef.current?.objectId === model.objectId) return layerRef.current;
    disposeUvPaintLayer(layerRef.current);

    const paint = createPaintCanvas();
    const mask = createPaintCanvas();
    const maskDisplay = createPaintCanvas();
    const maskPattern = createInpaintMaskPattern(maskDisplay.context);
    const paintTexture = new THREE.CanvasTexture(paint.canvas);
    const maskTexture = new THREE.CanvasTexture(mask.canvas);
    const maskDisplayTexture = new THREE.CanvasTexture(maskDisplay.canvas);
    configureCanvasTexture(paintTexture, THREE.SRGBColorSpace);
    configureCanvasTexture(maskTexture, THREE.NoColorSpace);
    configureCanvasTexture(maskDisplayTexture, THREE.NoColorSpace);

    const paintMaterial = new THREE.MeshBasicMaterial({
      map: paintTexture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const maskMaterial = createInpaintMaskMaterial(maskTexture);

    layerRef.current = {
      objectId: model.objectId,
      paintCanvas: paint.canvas,
      paintContext: paint.context,
      paintTexture,
      maskCanvas: mask.canvas,
      maskContext: mask.context,
      maskDisplayCanvas: maskDisplay.canvas,
      maskDisplayContext: maskDisplay.context,
      maskPattern,
      maskTexture,
      maskDisplayTexture,
      paintMaterial,
      maskMaterial,
      overlayMeshes: [],
      overlayTargets: new Set(),
      maskSolidNormalized: false,
    };
    return layerRef.current;
  }, []);

  const ensureOverlayForMesh = useCallback((layer: UvPaintLayer, mesh: THREE.Mesh) => {
    if (layer.overlayTargets.has(mesh)) return;
    layer.overlayTargets.add(mesh);

    const paintOverlay = new THREE.Mesh(mesh.geometry, layer.paintMaterial);
    paintOverlay.name = 'Liclick UV Paint Overlay';
    paintOverlay.userData.liclickPaintOverlay = true;
    paintOverlay.renderOrder = 30;
    mesh.add(paintOverlay);
    layer.overlayMeshes.push(paintOverlay);

    const maskOverlay = new THREE.Mesh(mesh.geometry, layer.maskMaterial);
    maskOverlay.name = 'Liclick UV Inpaint Mask Overlay';
    maskOverlay.userData.liclickPaintOverlay = true;
    maskOverlay.userData.liclickInpaintMaskTexture = layer.maskTexture;
    maskOverlay.renderOrder = 31;
    mesh.add(maskOverlay);
    layer.overlayMeshes.push(maskOverlay);
  }, []);

  useEffect(() => () => disposeUvPaintLayer(layerRef.current), []);

  const scheduleTextureUpdate = useCallback((texture: THREE.CanvasTexture) => {
    dirtyTexturesRef.current.add(texture);
    if (textureUpdateFrameRef.current !== undefined) return;
    textureUpdateFrameRef.current = window.requestAnimationFrame(() => {
      textureUpdateFrameRef.current = undefined;
      dirtyTexturesRef.current.forEach((dirtyTexture) => {
        dirtyTexture.needsUpdate = true;
      });
      dirtyTexturesRef.current.clear();
    });
  }, []);

  const refreshMaskDisplay = useCallback((layer: UvPaintLayer) => {
    if (!layer.maskSolidNormalized) {
      const logicalImage = layer.maskContext.getImageData(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
      const logicalData = logicalImage.data;
      let normalized = false;
      for (let index = 0; index < logicalData.length; index += 4) {
        if (logicalData[index + 3] === 0) continue;
        if (
          logicalData[index] !== 255 ||
          logicalData[index + 1] !== 255 ||
          logicalData[index + 2] !== 255 ||
          logicalData[index + 3] !== 255
        ) {
          logicalData[index] = 255;
          logicalData[index + 1] = 255;
          logicalData[index + 2] = 255;
          logicalData[index + 3] = 255;
          normalized = true;
        }
      }
      if (normalized) {
        layer.maskContext.putImageData(logicalImage, 0, 0);
        scheduleTextureUpdate(layer.maskTexture);
      }
      layer.maskSolidNormalized = true;
    }
    layer.maskDisplayContext.save();
    layer.maskDisplayContext.clearRect(0, 0, layer.maskDisplayCanvas.width, layer.maskDisplayCanvas.height);
    layer.maskDisplayContext.fillStyle = layer.maskPattern;
    layer.maskDisplayContext.fillRect(0, 0, layer.maskDisplayCanvas.width, layer.maskDisplayCanvas.height);
    layer.maskDisplayContext.globalCompositeOperation = 'destination-in';
    layer.maskDisplayContext.drawImage(layer.maskCanvas, 0, 0);
    layer.maskDisplayContext.restore();
    scheduleTextureUpdate(layer.maskDisplayTexture);
  }, [scheduleTextureUpdate]);

  useEffect(() => () => {
    if (textureUpdateFrameRef.current !== undefined) window.cancelAnimationFrame(textureUpdateFrameRef.current);
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.maskContext.clearRect(0, 0, layer.maskCanvas.width, layer.maskCanvas.height);
    layer.maskSolidNormalized = true;
    scheduleTextureUpdate(layer.maskTexture);
    refreshMaskDisplay(layer);
    maskDirtyRef.current = false;
    maskHasContentRef.current = false;
  }, [paintMaskResetRevision, refreshMaskDisplay, scheduleTextureUpdate]);

  const getBrushWorldRadius = useCallback((model: SurfacePaintTarget) => {
    const maxDimension = Math.max(model.boundingSize.x, model.boundingSize.y, model.boundingSize.z, 1);
    const setting =
      paintTool === 'brush'
        ? paintToolSettings.brushSize
        : paintTool === 'eraser'
          ? paintToolSettings.eraserSize
          : paintMaskSettings.brushSize;
    const isMaskBrush = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
    const worldScale = isMaskBrush ? 0.075 : 0.45;
    const minRadius = isMaskBrush ? maxDimension * 0.0008 : maxDimension * 0.004;
    const maxRadius = isMaskBrush ? maxDimension * 0.12 : maxDimension * 0.18;
    return THREE.MathUtils.clamp((maxDimension * setting * worldScale) / 700, minRadius, maxRadius);
  }, [paintMaskSettings.brushSize, paintTool, paintToolSettings.brushSize, paintToolSettings.eraserSize]);

  const getBrushTextureRadius = useCallback(() => {
    const setting =
      paintTool === 'brush'
        ? paintToolSettings.brushSize
        : paintTool === 'eraser'
          ? paintToolSettings.eraserSize
          : paintMaskSettings.brushSize;
    const isMaskBrush = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
    return isMaskBrush
      ? THREE.MathUtils.clamp(setting * 0.2, 0.75, 48)
      : THREE.MathUtils.clamp(setting * 0.45, 1.5, 96);
  }, [paintMaskSettings.brushSize, paintTool, paintToolSettings.brushSize, paintToolSettings.eraserSize]);

  const raycastModel = useCallback((event: globalThis.PointerEvent): UvPaintHit | undefined => {
    const model = getTargetModel();
    if (!model) return undefined;
    const rect = gl.domElement.getBoundingClientRect();
    pointerRef.current.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    raycasterRef.current.setFromCamera(pointerRef.current, camera);
    const hit = raycasterRef.current.intersectObjects(getPaintableMeshes(model), false)[0];
    if (!hit || !(hit.object instanceof THREE.Mesh) || !hit.face || !hit.uv) return undefined;
    return {
      model,
      hit,
      uv: hit.uv.clone(),
      worldRadius: getBrushWorldRadius(model),
      textureRadius: getBrushTextureRadius(),
    };
  }, [camera, getBrushTextureRadius, getBrushWorldRadius, getPaintableMeshes, getTargetModel, gl.domElement]);

  const warnMissingPaintLayer = useCallback(() => {
    showPanel('layers');
    setPanelCollapsed('layers', false);
    pushToast({
      tone: 'warning',
      title: t('paintLayerMissing'),
      description: t('paintLayerMissingHelp'),
      dedupeKey: 'paint-layer-missing',
    });
  }, [pushToast, setPanelCollapsed, showPanel, t]);

  const getCursorColor = useCallback(() => {
    if (paintTool === 'eraser') return '#ffffff';
    if (isInpaintMode) return '#ff8a68';
    return paintToolSettings.color;
  }, [isInpaintMode, paintTool, paintToolSettings.color]);

  const updateCursor = useCallback((event: globalThis.PointerEvent) => {
    const canPreviewBrush = enabled && (isInpaintMode || canUseSurfacePaint);
    const result = canPreviewBrush ? raycastModel(event) : undefined;
    const cursor = cursorRef.current;
    if (!cursor) return result;
    if (!result) {
      cursor.visible = false;
      gl.domElement.style.cursor = enabled ? 'default' : '';
      return undefined;
    }
    const worldNormal = result.hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(result.hit.object.matrixWorld);
    worldNormal.applyMatrix3(normalMatrix).normalize();
    const localPoint = result.model.group.worldToLocal(
      result.hit.point.clone().add(worldNormal.clone().multiplyScalar(result.worldRadius * 0.025)),
    );
    const localNormal = result.model.group.worldToLocal(result.hit.point.clone().add(worldNormal))
      .sub(result.model.group.worldToLocal(result.hit.point.clone()))
      .normalize();
    const worldScale = new THREE.Vector3();
    result.model.group.getWorldScale(worldScale);
    result.model.group.attach(cursor);
    cursor.position.copy(localPoint);
    cursor.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal));
    cursor.scale.setScalar(result.worldRadius / Math.max(worldScale.x, worldScale.y, worldScale.z, 0.0001));
    if (cursor.material instanceof THREE.MeshBasicMaterial) cursor.material.color.set(getCursorColor());
    cursor.visible = true;
    gl.domElement.style.cursor = 'none';
    return result;
  }, [canUseSurfacePaint, enabled, getCursorColor, gl.domElement, isInpaintMode, raycastModel]);

  const drawBrushSegment = useCallback((
    context: CanvasRenderingContext2D,
    texture: THREE.CanvasTexture,
    fromUv: THREE.Vector2 | undefined,
    toUv: THREE.Vector2,
    radius: number,
    color: string | CanvasPattern,
    compositeOperation: GlobalCompositeOperation,
    hardness: number,
  ) => {
    const targetUvX = THREE.MathUtils.euclideanModulo(toUv.x, 1);
    const targetUvY = THREE.MathUtils.euclideanModulo(toUv.y, 1);
    const sourceUvX = fromUv ? THREE.MathUtils.euclideanModulo(fromUv.x, 1) : targetUvX;
    const sourceUvY = fromUv ? THREE.MathUtils.euclideanModulo(fromUv.y, 1) : targetUvY;
    const toX = targetUvX * UV_PAINT_RESOLUTION;
    const toY = targetUvY * UV_PAINT_RESOLUTION;
    const fromX = sourceUvX * UV_PAINT_RESOLUTION;
    const fromY = sourceUvY * UV_PAINT_RESOLUTION;
    const bounds = createDirtyRect(fromX, fromY, toX, toY, radius);
    const softness = 1 - THREE.MathUtils.clamp(hardness / 100, 0, 1);
    const innerRadius = Math.max(1, radius * (1 - softness * 0.55));

    context.save();
    context.globalCompositeOperation = compositeOperation;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (softness > 0.02) {
      context.globalAlpha = Math.max(0.18, 1 - softness * 0.68);
      context.strokeStyle = color;
      context.lineWidth = radius * 2;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(toX, toY);
      context.stroke();
    }
    context.globalAlpha = 1;
    context.strokeStyle = color;
    context.lineWidth = innerRadius * 2;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.restore();
    scheduleTextureUpdate(texture);
    return bounds;
  }, [scheduleTextureUpdate]);

  const getStrokeSourceUv = useCallback((result: UvPaintHit) => {
    const previous = lastSampleRef.current;
    if (!previous || !(result.hit.object instanceof THREE.Mesh)) return undefined;
    if (previous.meshUuid !== result.hit.object.uuid) return undefined;

    const targetUvX = THREE.MathUtils.euclideanModulo(result.uv.x, 1);
    const targetUvY = THREE.MathUtils.euclideanModulo(result.uv.y, 1);
    const sourceUvX = THREE.MathUtils.euclideanModulo(previous.uv.x, 1);
    const sourceUvY = THREE.MathUtils.euclideanModulo(previous.uv.y, 1);
    const deltaX = Math.min(Math.abs(targetUvX - sourceUvX), 1 - Math.abs(targetUvX - sourceUvX));
    const deltaY = Math.min(Math.abs(targetUvY - sourceUvY), 1 - Math.abs(targetUvY - sourceUvY));
    const textureDistance = Math.hypot(deltaX, deltaY) * UV_PAINT_RESOLUTION;
    const worldDistance = previous.point.distanceTo(result.hit.point);
    const isMaskBrush = paintTool === 'inpaint-add' || paintTool === 'inpaint-subtract';
    const maxTextureDistance = isMaskBrush
      ? THREE.MathUtils.clamp(result.textureRadius * 2.2, 3, 36)
      : THREE.MathUtils.clamp(result.textureRadius * 3, 8, 96);
    const maxWorldDistance = result.worldRadius * (isMaskBrush ? 2.25 : 3.5);
    const sameFace = previous.faceIndex !== undefined && previous.faceIndex === result.hit.faceIndex;
    if (!sameFace && worldDistance > maxWorldDistance) return undefined;
    if (textureDistance > maxTextureDistance) return undefined;
    return previous.uv;
  }, [paintTool]);

  const paintAt = useCallback((result: UvPaintHit) => {
    const layer = getUvPaintLayer(result.model);
    if (result.hit.object instanceof THREE.Mesh) ensureOverlayForMesh(layer, result.hit.object);
    const fromUv = getStrokeSourceUv(result);

    if (paintTool === 'brush') {
      const bounds = drawBrushSegment(
        layer.paintContext,
        layer.paintTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        paintToolSettings.color,
        'source-over',
        paintToolSettings.brushHardness,
      );
      if (strokeDraftRef.current?.target === 'paint') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
    } else if (paintTool === 'eraser') {
      const bounds = drawBrushSegment(
        layer.paintContext,
        layer.paintTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        '#000000',
        'destination-out',
        paintToolSettings.eraserHardness,
      );
      if (strokeDraftRef.current?.target === 'paint') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
    } else if (paintTool === 'inpaint-add') {
      const bounds = drawBrushSegment(
        layer.maskContext,
        layer.maskTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        '#ffffff',
        'source-over',
        paintMaskSettings.brushHardness,
      );
      if (strokeDraftRef.current?.target === 'mask') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
      maskDirtyRef.current = true;
      maskHasContentRef.current = true;
      refreshMaskDisplay(layer);
    } else if (paintTool === 'inpaint-subtract') {
      const bounds = drawBrushSegment(
        layer.maskContext,
        layer.maskTexture,
        fromUv,
        result.uv,
        result.textureRadius,
        '#000000',
        'destination-out',
        paintMaskSettings.brushHardness,
      );
      if (strokeDraftRef.current?.target === 'mask') {
        strokeDraftRef.current.bounds = unionDirtyRect(strokeDraftRef.current.bounds, bounds);
      }
      maskDirtyRef.current = true;
      refreshMaskDisplay(layer);
    }

    lastUvRef.current = result.uv.clone();
    lastSampleRef.current =
      result.hit.object instanceof THREE.Mesh
        ? {
            meshUuid: result.hit.object.uuid,
            faceIndex: result.hit.faceIndex ?? undefined,
            uv: result.uv.clone(),
            point: result.hit.point.clone(),
          }
        : undefined;
  }, [
    drawBrushSegment,
    ensureOverlayForMesh,
    getStrokeSourceUv,
    getUvPaintLayer,
    paintMaskSettings.brushHardness,
    paintTool,
    paintToolSettings.brushHardness,
    paintToolSettings.color,
    paintToolSettings.eraserHardness,
    refreshMaskDisplay,
  ]);

  const commitMaskIfDirty = useCallback(() => {
    if (!maskDirtyRef.current) return;
    maskDirtyRef.current = false;
    setPaintMaskDataUrl(undefined, maskHasContentRef.current);
  }, [setPaintMaskDataUrl]);

  const beginStrokeHistory = useCallback((result: UvPaintHit) => {
    const layer = getUvPaintLayer(result.model);
    const target = isInpaintMode ? 'mask' : 'paint';
    const sourceCanvas = target === 'mask' ? layer.maskCanvas : layer.paintCanvas;
    const beforeCanvas = document.createElement('canvas');
    beforeCanvas.width = sourceCanvas.width;
    beforeCanvas.height = sourceCanvas.height;
    beforeCanvas.getContext('2d')?.drawImage(sourceCanvas, 0, 0);
    strokeDraftRef.current = { layer, target, beforeCanvas, beforeMaskHasContent: maskHasContentRef.current };
  }, [getUvPaintLayer, isInpaintMode]);

  const commitStrokeHistory = useCallback(() => {
    const draft = strokeDraftRef.current;
    strokeDraftRef.current = undefined;
    if (!draft?.bounds) return;

    const targetCanvas = draft.target === 'mask' ? draft.layer.maskCanvas : draft.layer.paintCanvas;
    const targetContext = draft.target === 'mask' ? draft.layer.maskContext : draft.layer.paintContext;
    const targetTexture = draft.target === 'mask' ? draft.layer.maskTexture : draft.layer.paintTexture;
    const beforeContext = draft.beforeCanvas.getContext('2d', { willReadFrequently: true });
    if (!beforeContext) return;

    const { x, y, width, height } = draft.bounds;
    const beforeImageData = beforeContext.getImageData(x, y, width, height);
    const afterImageData = targetContext.getImageData(x, y, width, height);
    const beforeMaskHasContent = draft.beforeMaskHasContent;
    const afterMaskHasContent =
      draft.target === 'mask'
        ? paintTool === 'inpaint-add'
          ? true
          : hasCanvasAlpha(targetCanvas, targetContext)
        : maskHasContentRef.current;

    if (draft.target === 'mask') {
      draft.layer.maskSolidNormalized = true;
      maskHasContentRef.current = afterMaskHasContent;
    }

    captureRuntimeHistory({
      label: draft.target === 'mask' ? '编辑绘制蒙版' : '绘制纹理',
      undo: () => {
        targetContext.putImageData(beforeImageData, x, y);
        scheduleTextureUpdate(targetTexture);
        if (draft.target === 'mask') {
          draft.layer.maskSolidNormalized = false;
          refreshMaskDisplay(draft.layer);
          maskHasContentRef.current = beforeMaskHasContent;
          setPaintMaskDataUrl(undefined, beforeMaskHasContent);
        }
      },
      redo: () => {
        targetContext.putImageData(afterImageData, x, y);
        scheduleTextureUpdate(targetTexture);
        if (draft.target === 'mask') {
          draft.layer.maskSolidNormalized = false;
          refreshMaskDisplay(draft.layer);
          maskHasContentRef.current = afterMaskHasContent;
          setPaintMaskDataUrl(undefined, afterMaskHasContent);
        }
      },
    });
  }, [captureRuntimeHistory, paintTool, refreshMaskDisplay, scheduleTextureUpdate, setPaintMaskDataUrl]);

  useEffect(() => {
    const canvas = gl.domElement;
    const cursorMesh = cursorRef.current;
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const result = updateCursor(event);
      if (isPaintingRef.current && result) {
        event.preventDefault();
        event.stopPropagation();
        paintAt(result);
      }
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      if (!enabled || event.button !== 0) return;
      if (!isInpaintMode && !canUseSurfacePaint) {
        const result = raycastModel(event);
        if (!result) return;
        event.preventDefault();
        event.stopPropagation();
        warnMissingPaintLayer();
        return;
      }
      const result = updateCursor(event);
      if (!result) return;
      event.preventDefault();
      event.stopPropagation();
      isPaintingRef.current = true;
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      beginStrokeHistory(result);
      setOrbitControlsEnabled(false);
      paintAt(result);
    };
    const handlePointerUp = () => {
      if (!isPaintingRef.current) return;
      isPaintingRef.current = false;
      lastUvRef.current = undefined;
      lastSampleRef.current = undefined;
      setOrbitControlsEnabled(true);
      commitStrokeHistory();
      commitMaskIfDirty();
    };
    const handlePointerLeave = () => {
      if (cursorMesh) cursorMesh.visible = false;
      if (!isPaintingRef.current) gl.domElement.style.cursor = '';
    };
    canvas.addEventListener('pointermove', handlePointerMove, true);
    canvas.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    return () => {
      canvas.removeEventListener('pointermove', handlePointerMove, true);
      canvas.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      if (cursorMesh) cursorMesh.visible = false;
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        setOrbitControlsEnabled(true);
        commitStrokeHistory();
        commitMaskIfDirty();
      }
      gl.domElement.style.cursor = '';
    };
  }, [
    commitMaskIfDirty,
    beginStrokeHistory,
    commitStrokeHistory,
    enabled,
    gl,
    isInpaintMode,
    paintAt,
    raycastModel,
    setOrbitControlsEnabled,
    canUseSurfacePaint,
    updateCursor,
    warnMissingPaintLayer,
  ]);

  return (
    <mesh ref={cursorRef} visible={false} userData={{ liclickPaintOverlay: true }}>
      <ringGeometry args={[0.84, 1, 64]} />
      <meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent opacity={0.96} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function ViewportCanvas({
  hasImportedModel,
  onImportModel,
  onImportReferenceImages,
  onOpenImport,
}: ViewportCanvasProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [captureFrameVisible, setCaptureFrameVisible] = useState(false);
  const [canvasKey, setCanvasKey] = useState(0);
  const [viewportIssue, setViewportIssue] = useState<string>();
  const recoveryAttemptsRef = useRef(0);
  const captureFrameTimerRef = useRef<number>();
  const activeDragType = useDragInteractionStore((state) => state.activeDragType);
  const startFileDrag = useDragInteractionStore((state) => state.startFileDrag);
  const clearDrag = useDragInteractionStore((state) => state.clearDrag);
  const exposure = useSettingsStore((state) => state.exposure);
  const t = useT();

  useEffect(() => () => window.clearTimeout(captureFrameTimerRef.current), []);

  function pulseCaptureFrame() {
    setCaptureFrameVisible(true);
    window.clearTimeout(captureFrameTimerRef.current);
    captureFrameTimerRef.current = window.setTimeout(() => {
      setCaptureFrameVisible(false);
    }, 1800);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.buttons === 0) return;
    pulseCaptureFrame();
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaX === 0 && event.deltaY === 0 && event.deltaZ === 0) return;
    pulseCaptureFrame();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (activeDragType === 'panel') {
      clearDrag();
      return;
    }
    const payload = getDragPayload(event);
    if (payload.modelFile) {
      onImportModel(payload.modelFile);
      clearDrag();
      return;
    }
    if (payload.imageFiles.length > 0) onImportReferenceImages(payload.imageFiles);
    clearDrag();
  }

  return (
    <div
      className="relative h-full w-full bg-[#080914]"
      onPointerDownCapture={pulseCaptureFrame}
      onPointerMoveCapture={handlePointerMove}
      onWheelCapture={handleWheel}
      onDragOver={(event) => {
        if (activeDragType === 'panel') return;
        event.preventDefault();
        const payload = getDragPayload(event);
        if (!payload.dragType) return;
        startFileDrag(payload.dragType);
        setIsDragging(true);
      }}
      onDragLeave={() => {
        setIsDragging(false);
        if (activeDragType !== 'panel') clearDrag();
      }}
      onDrop={handleDrop}
    >
      <Canvas
        key={canvasKey}
        dpr={[1, 1.5]}
        camera={{ position: [3.2, 2.4, 4], fov: 45, near: 0.1, far: 100 }}
        gl={{
          alpha: true,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
          outputColorSpace: THREE.SRGBColorSpace,
          toneMapping: THREE.LinearToneMapping,
          toneMappingExposure: exposure,
        }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.LinearToneMapping;
          gl.toneMappingExposure = exposure;
          setViewportIssue(undefined);
          recoveryAttemptsRef.current = 0;
          const canvas = gl.domElement;
          const handleContextLost = (event: Event) => {
            event.preventDefault();
            recoveryAttemptsRef.current += 1;
            if (recoveryAttemptsRef.current <= 2) {
              window.setTimeout(() => setCanvasKey((key) => key + 1), 250);
              return;
            }
            setViewportIssue(t('viewportContextLostHelp'));
          };
          const handleContextRestored = () => {
            setViewportIssue(undefined);
            setCanvasKey((key) => key + 1);
          };
          canvas.addEventListener('webglcontextlost', handleContextLost);
          canvas.addEventListener('webglcontextrestored', handleContextRestored);
        }}
        onError={(error) => {
          console.error('[Liclick 3D Texture] Viewport renderer failed:', error);
          setViewportIssue(error instanceof Error ? error.message : '视口渲染失败。');
        }}
      >
        <color attach="background" args={['#080914']} />
        <Suspense fallback={null}>
          <RendererSettings />
          <SceneRoot />
          <SurfacePaintOverlay />
        </Suspense>
        <CameraController />
      </Canvas>
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 z-20 h-[82%] w-[72%] max-w-[1280px] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-[3px] border-dashed border-[#d9795c]/75 shadow-[0_0_0_1px_rgba(217,121,92,0.12)] transition-opacity duration-300 ${
          captureFrameVisible ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden="true"
      />
      {viewportIssue && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[#080914]/86 px-5 text-white backdrop-blur-sm">
          <div className="grid max-w-[420px] gap-3 rounded-lg border border-white/14 bg-black/50 p-4 text-center shadow-2xl">
            <div className="text-sm font-semibold">{t('viewportNeedsRestore')}</div>
            <div className="text-xs leading-5 text-white/66">{viewportIssue}</div>
            <button
              type="button"
              className="mx-auto h-9 rounded-md bg-white px-4 text-xs font-semibold text-black transition hover:bg-white/90"
              onClick={() => {
                setViewportIssue(undefined);
                setCanvasKey((key) => key + 1);
              }}
            >
              {t('reloadViewport')}
            </button>
          </div>
        </div>
      )}
      <ViewCube />
      {!hasImportedModel && (
        <button
          type="button"
          onClick={onOpenImport}
          className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/42 px-3 py-2 text-xs text-white/66 backdrop-blur transition hover:bg-white/10 hover:text-white"
        >
          {t('dropModelImport')}
        </button>
      )}
      {isDragging && activeDragType === 'model-file' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop model to import
        </div>
      )}
      {isDragging && activeDragType === 'asset-file' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center border-2 border-dashed border-liclick-pink bg-liclick-purple/18 text-lg font-semibold text-white backdrop-blur-sm">
          Drop image to add reference
        </div>
      )}
    </div>
  );
}
